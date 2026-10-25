#!/usr/bin/env node
/**
 * Paint-path CI: builds the exact __paperPaint / trails.setData object and
 * asserts a trailing player gets a visible LineString on the trail layer.
 *
 * This is NOT an HTML-comment or trail[].length check. It fails when:
 * - state.trails is missing (paint skipped on update)
 * - trailing seat has no LineString / &lt;2 coordinates
 * - trail layer width is 0 or road-grey
 * - trails layer is under owned-fill
 * - getSource('trails').setData is removed
 *
 * Self-check: VERIFY_TRAIL_PAINT_BREAK=1 mutates width→0 / strips setData /
 * clears features and expects each mutation to fail.
 *
 * Run: node ./scripts/verify-trail-paint-payload.js
 */

const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const projectRoot = path.join(__dirname, "..");
const workspaceRoot = path.join(projectRoot, "../..");
const rulesDist = path.join(workspaceRoot, "packages/rules/dist");
const mapHtmlPath = path.join(projectRoot, "src/map/mapHtml.ts");
const paintPayloadPath = path.join(projectRoot, "src/map/paintPayload.ts");

let quiet = false;
function assert(cond, msg) {
  if (!cond) {
    if (!quiet) console.error("FAIL:", msg);
    throw new Error(msg);
  }
}

function transpileTs(filePath) {
  const src = fs.readFileSync(filePath, "utf8");
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
      esModuleInterop: true,
    },
    fileName: path.basename(filePath),
  });
  return outputText;
}

function loadPaintPayloadModule() {
  assert(
    fs.existsSync(path.join(rulesDist, "index.js")),
    "packages/rules must be built (dist/index.js) before paint payload verify",
  );
  const outputText = transpileTs(paintPayloadPath).replace(
    /require\(["']@paper-irl\/rules["']\)/g,
    `require(${JSON.stringify(path.join(rulesDist, "index.js"))})`,
  );
  const module = { exports: {} };
  const req = (id) => {
    if (id.startsWith(".")) {
      // api types only — paintPayload imports type-only from api at compile time;
      // after transpile value imports of ../lib/api should not remain.
      const resolved = path.join(path.dirname(paintPayloadPath), id);
      if (fs.existsSync(resolved + ".ts") || fs.existsSync(resolved + ".js")) {
        return {};
      }
    }
    return require(id);
  };
  // eslint-disable-next-line no-new-func
  const fn = new Function("exports", "module", "require", outputText);
  fn(module.exports, module, req);
  return module.exports;
}

function loadBuildMapHtml() {
  const outputText = transpileTs(mapHtmlPath);
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  const fn = new Function("exports", "module", "require", outputText);
  fn(module.exports, module, require);
  return module.exports;
}

function loadRules() {
  return require(path.join(rulesDist, "index.js"));
}

/** Lobby seat views shaped like the mobile API payload. */
function seatsAsLobbyViews(lobby) {
  return [...lobby.seats.values()].map((s) => ({
    id: s.id,
    nickname: s.nickname,
    mode: s.mode,
    color: s.color,
    areaM2: s.areaM2,
    trail: s.trail.map((p) => ({ ...p })),
    owned: s.owned.map((ring) => ring.map((p) => ({ ...p }))),
    position: s.position ? { ...s.position } : null,
    respawnAt: s.respawnAt ? { ...s.respawnAt } : null,
  }));
}

function buildTrailingLobby(rules) {
  const arena = rules.buildKellerArena();
  const lobby = rules.createLobby("PNT", arena, { durationMs: 60_000 });
  const { seat } = rules.joinLobby(lobby, "You");
  const t0 = 8_000_000;
  rules.startLobby(lobby, t0);
  rules.applyFix(
    lobby,
    seat.id,
    {
      lat: seat.respawnAt.lat,
      lon: seat.respawnAt.lon,
      accuracyM: 8,
      speedMps: 2,
      clientTsMs: t0 + 1,
    },
    t0 + 1,
  );
  const home = seat.position;
  const out = rules.fromLocalM(home.lat, home.lon, 50, 0);
  rules.applyFix(
    lobby,
    seat.id,
    {
      lat: out.lat,
      lon: out.lon,
      accuracyM: 8,
      speedMps: 2,
      clientTsMs: t0 + 2,
    },
    t0 + 2,
  );
  assert(seat.mode === "trailing", "fixture seat must be trailing outside home");
  assert(
    seat.trail.length >= 2,
    `fixture open trail must have ≥2 points (got ${seat.trail.length})`,
  );
  return {
    lobbyPayload: {
      code: lobby.code,
      phase: lobby.phase,
      mode: "freeplay",
      arena: lobby.arena,
      seats: seatsAsLobbyViews(lobby),
      top3: rules.topScores(lobby, 3).map((s) => ({
        id: s.id,
        nickname: s.nickname,
        areaM2: s.areaM2,
        color: s.color,
      })),
      rematchReady: [],
    },
    seatId: seat.id,
    trail: seat.trail.map((p) => ({ ...p })),
  };
}

function assertLayerStyle(html, style) {
  const coreW = html.match(/TRAIL_CORE_WIDTH\s*=\s*([0-9.]+)/);
  const caseW = html.match(/TRAIL_CASE_WIDTH\s*=\s*([0-9.]+)/);
  assert(coreW, "TRAIL_CORE_WIDTH missing from map HTML");
  assert(caseW, "TRAIL_CASE_WIDTH missing from map HTML");
  const cw = Number(coreW[1]);
  const sw = Number(caseW[1]);
  assert(cw > 0, `trail core line-width must be > 0 (got ${cw})`);
  assert(sw > 0, `trail casing line-width must be > 0 (got ${sw})`);
  assert(
    cw >= 4 && sw >= 7,
    `trail widths must be visible (core>=4, casing>=7); got core=${cw} case=${sw}`,
  );
  assert(
    Math.abs(cw - style.coreWidth) < 0.01,
    `TRAIL_CORE_WIDTH ${cw} must match paintPayload TRAIL_LAYER_STYLE.coreWidth ${style.coreWidth}`,
  );
  assert(
    /TRAIL_CORE\s*=\s*['"]#111111['"]/.test(html),
    "trail core color must contrast basemap (#111111), not road grey",
  );
  assert(
    /TRAIL_CASE\s*=\s*['"]#ffffff['"]/.test(html),
    "trail casing must be white (#ffffff) for basemap contrast",
  );
  assert(
    /'line-width'\s*:\s*TRAIL_CORE_WIDTH/.test(html),
    "trails layer must paint line-width: TRAIL_CORE_WIDTH (draw call)",
  );
  assert(
    /'line-color'\s*:\s*TRAIL_CORE/.test(html),
    "trails layer must paint line-color: TRAIL_CORE (draw call)",
  );

  const loadMatch = html.match(/map\.on\(\s*['"]load['"][\s\S]*?ready\s*=\s*true/);
  assert(loadMatch, "map.on('load') init block missing");
  const loadBlock = loadMatch[0];
  const ownedInLoad = loadBlock.indexOf(style.aboveLayerId);
  const trailsInLoad = loadBlock.indexOf("ensureTrailLayers");
  assert(ownedInLoad >= 0, `${style.aboveLayerId} missing in load handler`);
  assert(trailsInLoad >= 0, "ensureTrailLayers() missing in load handler");
  assert(
    trailsInLoad > ownedInLoad,
    "trail line layer must be above territory fill (ensureTrailLayers after owned-fill)",
  );

  assert(
    /getSource\(\s*['"]trails['"]\s*\)\.setData/.test(html),
    "getSource('trails').setData missing — paint update would skip the line",
  );
  assert(
    html.includes("__paperPaint"),
    "window.__paperPaint bridge missing",
  );
  assert(
    html.includes("lastState.trails") || html.includes("state.trails"),
    "flushLayers must apply state.trails FeatureCollection from __paperPaint",
  );
}

function assertPaintPayload(paintMod, fixture) {
  const msg = paintMod.buildPaperPaintMessage(
    fixture.lobbyPayload,
    fixture.seatId,
  );
  assert(msg.type === "state", "paint message type must be state");
  assert(
    msg.state && msg.state.trails,
    "paint skipped — __paperPaint state.trails missing",
  );

  const { setData, line } = paintMod.assertTrailingTrailInPaintPayload(
    msg,
    fixture.seatId,
  );
  assert(
    setData.features.length >= 1,
    "trails.setData FeatureCollection is empty — line would not paint",
  );
  assert(line.geometry.type === "LineString", "expected LineString geometry");
  assert(
    line.geometry.coordinates.length >= 2,
    "LineString needs ≥2 coordinates to draw",
  );

  // Coordinates must track the live trail (lon,lat GeoJSON order).
  const first = line.geometry.coordinates[0];
  const tip = fixture.trail[0];
  assert(
    Math.abs(first[0] - tip.lon) < 1e-8 && Math.abs(first[1] - tip.lat) < 1e-8,
    "LineString coordinates must match the player's trail samples",
  );

  // Skipping setData on update: empty/missing trails must fail.
  const skipped = paintMod.trailsSetDataFromPaintMessage({
    type: "state",
    state: { ...msg.state, trails: undefined },
  });
  assert(
    skipped === null,
    "trailsSetDataFromPaintMessage must return null when paint is skipped",
  );
  let threw = false;
  try {
    paintMod.assertTrailingTrailInPaintPayload(
      { type: "state", state: { ...msg.state, trails: { type: "FeatureCollection", features: [] } } },
      fixture.seatId,
    );
  } catch {
    threw = true;
  }
  assert(
    threw,
    "assertTrailingTrailInPaintPayload must fail when setData features are empty",
  );

  return msg;
}

function runBreakSelfCheck(paintMod, mapMod, style, fixture) {
  const html = mapMod.buildMapHtml();
  const cases = [
    {
      name: "width0",
      mutate: (h) =>
        h
          .replace(/TRAIL_CORE_WIDTH\s*=\s*[0-9.]+/, "TRAIL_CORE_WIDTH=0")
          .replace(/TRAIL_CASE_WIDTH\s*=\s*[0-9.]+/, "TRAIL_CASE_WIDTH=0"),
      check: (h) => assertLayerStyle(h, style),
    },
    {
      name: "noSetData",
      mutate: (h) =>
        h.replace(
          /getSource\(\s*['"]trails['"]\s*\)\.setData\([^)]*\)/g,
          "/* setData stripped */",
        ),
      check: (h) => assertLayerStyle(h, style),
    },
    {
      name: "emptyFeatures",
      mutate: null,
      check: () => {
        const msg = paintMod.buildPaperPaintMessage(
          fixture.lobbyPayload,
          fixture.seatId,
        );
        msg.state.trails = { type: "FeatureCollection", features: [] };
        paintMod.assertTrailingTrailInPaintPayload(msg, fixture.seatId);
      },
    },
  ];

  for (const c of cases) {
    let failed = false;
    quiet = true;
    try {
      if (c.mutate) c.check(c.mutate(html));
      else c.check();
    } catch {
      failed = true;
    }
    quiet = false;
    assert(
      failed,
      `VERIFY_TRAIL_PAINT_BREAK expected failure for mutation '${c.name}'`,
    );
  }
  console.log(
    "OK: verify-trail-paint-payload self-check — width0 / noSetData / emptyFeatures each fail",
  );
}

function main() {
  const paintMod = loadPaintPayloadModule();
  const mapMod = loadBuildMapHtml();
  const rules = loadRules();
  const style = paintMod.TRAIL_LAYER_STYLE;
  assert(style.coreWidth > 0, "TRAIL_LAYER_STYLE.coreWidth must be > 0");
  assert(style.caseWidth > 0, "TRAIL_LAYER_STYLE.caseWidth must be > 0");

  const fixture = buildTrailingLobby(rules);

  if (process.env.VERIFY_TRAIL_PAINT_BREAK === "1") {
    runBreakSelfCheck(paintMod, mapMod, style, fixture);
    return;
  }

  const html = mapMod.buildMapHtml();
  assertLayerStyle(html, style);
  assertPaintPayload(paintMod, fixture);

  console.log(
    "OK: verify-trail-paint-payload — trailing LineString in __paperPaint/setData, width>0, contrast, above fill",
  );
}

try {
  main();
} catch (e) {
  if (!quiet) {
    console.error(e && e.message ? e.message : e);
  }
  process.exitCode = 1;
}
