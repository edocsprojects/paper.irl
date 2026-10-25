#!/usr/bin/env node
/**
 * Runtime map check — executes the REAL map page script (buildMapHtml) in a
 * VM against a MapLibre stand-in that validates every addLayer with
 * @maplibre/maplibre-gl-style-spec, exactly like maplibre-gl 4.x does
 * (an invalid layer fires `error` and is NOT added).
 *
 * Then it drives real game state from @paper-irl/rules through the real RN
 * paint payload (paintPayload.ts) and asserts what the map would draw:
 * - trails + trails-casing layers exist (above owned-fill, below players)
 * - a player who left their land has a LineString that reaches their dot
 * - territory polygons (incl. holes) reach the owned source
 * - the camera snaps to the local player on first paint (no slide from Keller)
 * - the page posted no MapLibre errors
 *
 * Self-check: VERIFY_MAP_BREAK=1 re-introduces the old bug (line-cap in
 * `paint`) and other sabotage; each must make the check fail.
 */
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const ts = require("typescript");

const projectRoot = path.join(__dirname, "..");
const workspaceRoot = path.join(projectRoot, "../..");
const rulesDist = path.join(workspaceRoot, "packages/rules/dist/index.js");
const styleSpec = require(
  require.resolve("@maplibre/maplibre-gl-style-spec", { paths: [projectRoot, workspaceRoot] }),
);

function transpile(file) {
  const src = fs.readFileSync(file, "utf8");
  return ts.transpileModule(src, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2019, esModuleInterop: true },
    fileName: path.basename(file),
  }).outputText;
}

function loadTs(file, requireMap = {}) {
  const out = transpile(file);
  const module = { exports: {} };
  const req = (id) => {
    if (requireMap[id]) return requireMap[id];
    if (id.startsWith(".")) return {}; // type-only imports
    return require(id);
  };
  // eslint-disable-next-line no-new-func
  new Function("exports", "module", "require", out)(module.exports, module, req);
  return module.exports;
}

function fail(msg) {
  throw new Error(msg);
}

/** Minimal MapLibre GL stand-in with real style-spec layer validation. */
function makeMapLibre(record) {
  class Map {
    constructor(opts) {
      this.handlers = {};
      this.sources = {};
      this.layers = [];
      this.center = opts.center;
      record.map = this;
      record.jumps = [];
    }
    on(ev, fn) {
      (this.handlers[ev] ||= []).push(fn);
    }
    fire(ev, payload) {
      for (const fn of this.handlers[ev] || []) fn(payload);
    }
    addSource(id, spec) {
      if (this.sources[id]) fail(`source ${id} added twice`);
      const src = { spec, data: spec.data, setData(d) { this.data = JSON.parse(JSON.stringify(d)); } };
      this.sources[id] = src;
    }
    getSource(id) {
      return this.sources[id];
    }
    addLayer(layer) {
      if (this.layers.some((l) => l.id === layer.id)) fail(`layer ${layer.id} added twice`);
      const style = {
        version: 8,
        sources: Object.fromEntries(
          Object.keys(this.sources).map((k) => [k, { type: "geojson", data: { type: "FeatureCollection", features: [] } }]),
        ),
        layers: [layer],
      };
      const errors = styleSpec.validateStyleMin(style);
      if (errors.length) {
        // maplibre-gl Style#addLayer: _validate() → fire error → return (layer NOT added)
        this.fire("error", { error: new Error(errors.map((e) => e.message).join("; ")) });
        return this;
      }
      this.layers.push(layer);
      // Real MapLibre fires `styledata` on the next frame after a style change.
      record.styleDirty = true;
      return this;
    }
    getLayer(id) {
      return this.layers.find((l) => l.id === id);
    }
    getStyle() {
      // Basemap layers + ours, like the real style object.
      return {
        layers: [
          { id: "road_label", type: "symbol" },
          { id: "railway", type: "line" },
          { id: "water", type: "fill" },
          ...this.layers,
        ],
      };
    }
    setPaintProperty(id, prop, value) {
      const l = this.getLayer(id);
      if (l) l.paint = { ...(l.paint || {}), [prop]: value };
    }
    getLayoutProperty(id, prop) {
      return this.getLayer(id)?.layout?.[prop];
    }
    setLayoutProperty(id, prop, value) {
      const l = this.getLayer(id);
      if (l) l.layout = { ...(l.layout || {}), [prop]: value };
    }
    jumpTo(o) {
      this.center = o.center;
      record.jumps.push(o.center.slice());
    }
  }
  return { Map };
}

function extractPageScript(html) {
  const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (scripts.length !== 1) fail(`expected 1 inline <script>, got ${scripts.length}`);
  return scripts[0];
}

/** Build real game state: You planted, then walked 30 m out of your land. */
function buildGame(rules) {
  const arena = rules.buildArena({ centerLat: 37.3349, centerLon: -122.009, radiusM: 400 });
  const lobby = rules.createLobby("MAP", arena, { durationMs: 600_000 });
  const you = rules.joinLobby(lobby, "You").seat;
  const rival = rules.joinLobby(lobby, "Rival").seat;
  const at = (x, y) => rules.fromLocalM(arena.centerLat, arena.centerLon, x, y);
  const fix = (p, t, plant) => ({ lat: p.lat, lon: p.lon, accuracyM: 4, speedMps: 2, clientTsMs: t, plant });
  let t = 1_000;
  // GPS before start → starters spawn where people stand.
  rules.applyFix(lobby, you.id, fix(at(120, 40), t), t);
  rules.applyFix(lobby, rival.id, fix(at(-60, -60), t), t);
  rules.startLobby(lobby, t);
  rules.applyFix(lobby, you.id, fix(at(120, 40), ++t, true), t);
  rules.applyFix(lobby, rival.id, fix(at(-60, -60), ++t, true), t);
  if (you.mode !== "safe" || rival.mode !== "safe") fail("fixture: players did not plant");
  // Rival banks a ring around a pocket (leaves no hole — paper.io fills it).
  for (let x = 0; x <= 30; x += 1) {
    t += 300;
    rules.applyFix(lobby, you.id, fix(at(120 + x, 40), t), t);
  }
  if (you.mode !== "trailing" || you.trail.length < 2) fail(`fixture: you should be trailing (${you.mode})`);
  const views = [...lobby.seats.values()].map(rules.seatPublicView);
  return {
    lobby,
    youId: you.id,
    payload: {
      code: lobby.code,
      phase: lobby.phase,
      durationMs: lobby.durationMs,
      startedAtMs: lobby.startedAtMs,
      endsAtMs: lobby.endsAtMs,
      maxSeats: lobby.maxSeats,
      mode: "freeplay",
      arena: {
        id: arena.id,
        centerLat: arena.centerLat,
        centerLon: arena.centerLon,
        radiusM: arena.radiusM,
        starterRadiusM: arena.starterRadiusM,
      },
      seats: views,
      top3: views.slice(0, 3),
    },
  };
}

function runPage(html, paintMsg, opts = {}) {
  const record = { posts: [], rafs: [], clock: 1000 };
  const window = {
    ReactNativeWebView: { postMessage: (s) => record.posts.push(JSON.parse(s)) },
    addEventListener() {},
  };
  const ctx = {
    window,
    document: { addEventListener() {} },
    maplibregl: makeMapLibre(record),
    requestAnimationFrame: (fn) => record.rafs.push(fn),
    performance: { now: () => record.clock },
    console,
    JSON,
    Math,
    Object,
  };
  vm.createContext(ctx);
  vm.runInContext(extractPageScript(html), ctx);
  const map = record.map;
  if (!map) fail("page never constructed maplibregl.Map");
  map.fire("load");
  const flushStyle = () => {
    if (record.styleDirty) {
      record.styleDirty = false;
      map.fire("styledata", {});
    }
  };
  flushStyle();
  if (!record.posts.some((p) => p.type === "ready")) fail("page never posted ready");
  const pump = (n = 400) => {
    for (let i = 0; i < n && record.rafs.length; i++) {
      const q = record.rafs.splice(0);
      for (const fn of q) fn();
      flushStyle();
    }
  };
  window.__paperPaint(JSON.stringify(paintMsg));
  pump();
  if (opts.glide) {
    // Next server update 250 ms later with "you" 10 m further east…
    const moved = JSON.parse(JSON.stringify(paintMsg));
    const you = moved.state.seats.find((s) => s.you);
    const dLon = 10 / (111320 * Math.cos((you.position.lat * Math.PI) / 180));
    record.glideFrom = you.position.lon;
    you.position.lon += dLon;
    record.glideTo = you.position.lon;
    record.clock += 250;
    window.__paperPaint(JSON.stringify(moved));
    // …halfway through the glide, the dot must be in between (not teleported).
    record.clock += 135;
    pump(1);
    const dot = map.getSource("players").data.features.find((f) => f.properties.you && f.properties.mode !== "marker");
    record.glideMid = dot.geometry.coordinates[0];
    record.camMid = map.center[0];
    record.clock += 2000;
    pump();
  }
  return { map, record };
}

function analyze(html, ctx) {
  const glide = runPage(html, ctx.msg, { glide: true }).record;
  const span = glide.glideTo - glide.glideFrom;
  const frac = (glide.glideMid - glide.glideFrom) / span;
  if (!(frac > 0.15 && frac < 0.9)) fail(`dot did not glide between updates (at ${(frac * 100).toFixed(0)}% mid-interval)`);
  if (Math.abs(glide.camMid - glide.glideMid) > 1e-9) fail("camera is not riding the smoothed player dot");
  const { map, record } = runPage(html, ctx.msg);
  const errs = record.posts.filter((p) => p.type === "error");
  if (errs.length) fail(`map posted errors: ${errs.map((e) => e.message).join(" | ")}`);
  const ids = map.layers.map((l) => l.id);
  for (const need of ["owned-fill", "owned-border", "trails-casing", "trails", "players"]) {
    if (!ids.includes(need)) fail(`layer '${need}' missing at runtime (layers: ${ids.join(",")})`);
  }
  for (const l of map.layers) {
    if (l.layout?.visibility === "none") fail(`our layer '${l.id}' was hidden (visibility:none)`);
  }
  const idx = (id) => ids.indexOf(id);
  if (!(idx("owned-fill") < idx("trails-casing") && idx("trails-casing") < idx("trails") && idx("trails") < idx("players"))) {
    fail(`bad layer order: ${ids.join(" < ")}`);
  }
  const trails = map.getSource("trails").data;
  const you = ctx.msg.state.seats.find((s) => s.id === ctx.youId);
  const line = trails.features.find((f) => f.properties.seatId === ctx.youId);
  if (!line || line.geometry.type !== "LineString") fail("no trail LineString for the trailing player");
  const coords = line.geometry.coordinates;
  if (coords.length < 2) fail(`trail has ${coords.length} coords`);
  const tip = coords[coords.length - 1];
  if (Math.abs(tip[0] - you.position.lon) > 1e-7 || Math.abs(tip[1] - you.position.lat) > 1e-7) {
    fail("trail does not reach the player's dot");
  }
  const trailLayer = map.getLayer("trails");
  if (!(trailLayer.paint["line-width"] >= 4)) fail("trail core width < 4");
  if (!(map.getLayer("trails-casing").paint["line-width"] >= 7)) fail("trail casing width < 7");
  if (trailLayer.layout?.["line-cap"] !== "round") fail("trail line-cap must be a layout property");
  const owned = map.getSource("owned").data.features;
  if (owned.length < 2) fail(`expected ≥2 territory polygons, got ${owned.length}`);
  if (!owned.every((f) => f.geometry.type === "Polygon" && f.properties.fill)) fail("bad territory feature");
  const paintReport = record.posts.filter((p) => p.type === "paint").pop();
  if (!paintReport || !paintReport.trailsLayer || paintReport.trailFeatures < 1) {
    fail(`page paint report says trails not drawn: ${JSON.stringify(paintReport)}`);
  }
  // Camera: after the first state paint, the very first jump is onto the player.
  const firstJump = record.jumps[0];
  if (!firstJump) fail("camera never moved");
  if (Math.abs(firstJump[0] - you.position.lon) > 1e-6 || Math.abs(firstJump[1] - you.position.lat) > 1e-6) {
    fail(`camera did not snap to the player on load (first jump ${firstJump})`);
  }
  return { ids, trailCoords: coords.length, owned: owned.length };
}

function main() {
  if (!fs.existsSync(rulesDist)) fail("build packages/rules first (pnpm --filter @paper-irl/rules build)");
  const rules = require(rulesDist);
  const { buildMapHtml, MAP_HTML_REVISION } = loadTs(path.join(projectRoot, "src/map/mapHtml.ts"));
  const { buildPaperPaintMessage } = loadTs(path.join(projectRoot, "src/map/paintPayload.ts"), {
    "@paper-irl/rules": rules,
  });
  const game = buildGame(rules);
  const ctx = { msg: buildPaperPaintMessage(game.payload, game.youId), youId: game.youId };
  const html = buildMapHtml();

  if (process.env.VERIFY_MAP_BREAK === "1") {
    const sabotage = {
      "line-cap in paint (the old bug)": (h) =>
        h.replace(/layout:\{'line-cap':'round','line-join':'round'\},\s*paint:\{/g, "paint:{'line-cap':'round','line-join':'round',"),
      "trails setData removed": (h) => h.replace("map.getSource('trails').setData(trails);", ""),
      "trail not extended to dot": (h) => h.replace("coords[coords.length-1]=[live.lon,live.lat];", "coords.pop();"),
      "camera ignores the player": (h) => h.replace("if(l.you){ c=", "if(false){ c="),
      "dots snap instead of glide": (h) => h.replace("prev.dur=Math.max(120,Math.min(900,gap*1.1));", "prev.dur=0;"),
      "declutter hides trails (/rail/ matches 'trails')": (h) => h.replace("if(OWN_LAYERS[layer.id]) continue;", ""),
    };
    for (const [name, fn] of Object.entries(sabotage)) {
      const broken = fn(html);
      if (broken === html) fail(`sabotage '${name}' did not apply — update the self-check`);
      let failed = false;
      try {
        analyze(broken, ctx);
      } catch {
        failed = true;
      }
      if (!failed) fail(`self-check: '${name}' was NOT detected`);
    }
    console.log(`OK: verify-map-runtime self-check — ${Object.keys(sabotage).length} sabotages all detected`);
    return;
  }

  const r = analyze(html, ctx);
  console.log(
    `OK: verify-map-runtime (rev ${MAP_HTML_REVISION}) — layers [${r.ids.join(", ")}], ` +
      `trail ${r.trailCoords} pts reaching the dot, ${r.owned} territory polygons, camera snapped to player`,
  );
}

try {
  main();
} catch (e) {
  console.error("FAIL:", e.message);
  process.exitCode = 1;
}
