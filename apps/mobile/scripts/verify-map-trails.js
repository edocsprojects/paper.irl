#!/usr/bin/env node
/**
 * Asserts the MapLibre HTML the client loads actually declares a visible trail
 * polyline layer — not just that rules emit trail[] arrays.
 *
 * Fails if:
 * - TRAIL_LAYER_OK sentinel missing (layer block removed / stale HTML)
 * - no addSource('trails') / addLayer id trails
 * - trail line-width too thin or color is road-grey
 * - trails layer is declared before owned-fill (would paint under fill)
 *
 * Run: node ./scripts/verify-map-trails.js
 * Self-check: VERIFY_TRAILS_BREAK=1 strips the layer and expects failure.
 */

const fs = require("fs");
const path = require("path");
const ts = require("typescript");

const mapHtmlPath = path.join(__dirname, "../src/map/mapHtml.ts");

function loadBuildMapHtml() {
  const src = fs.readFileSync(mapHtmlPath, "utf8");
  const { outputText } = ts.transpileModule(src, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2019,
    },
    fileName: "mapHtml.ts",
  });
  const module = { exports: {} };
  // eslint-disable-next-line no-new-func
  const fn = new Function("exports", "module", "require", outputText);
  fn(module.exports, module, require);
  return module.exports;
}

let quietAssert = false;
function assert(cond, msg) {
  if (!cond) {
    if (!quietAssert) console.error("FAIL:", msg);
    throw new Error(msg);
  }
}

function analyze(html) {
  assert(
    html.includes("TRAIL_LAYER_OK"),
    "TRAIL_LAYER_OK sentinel missing — trail layer not in loaded HTML",
  );
  assert(
    /addSource\(\s*['"]trails['"]/.test(html),
    "addSource('trails') missing from map HTML",
  );
  assert(
    /id:\s*['"]trails['"]/.test(html) || /id:'trails'/.test(html),
    "addLayer id trails missing from map HTML",
  );
  assert(
    /id:\s*['"]trails-casing['"]/.test(html) || /id:'trails-casing'/.test(html),
    "trails-casing layer missing (need contrast casing over basemap)",
  );

  // Visible width via TRAIL_*_WIDTH constants (or inline numerics)
  const coreW = html.match(/TRAIL_CORE_WIDTH\s*=\s*([0-9.]+)/);
  const caseW = html.match(/TRAIL_CASE_WIDTH\s*=\s*([0-9.]+)/);
  const widthHits = [...html.matchAll(/'line-width'\s*:\s*([0-9.]+)/g)].map(
    (m) => Number(m[1]),
  );
  const constWidths = [coreW && Number(coreW[1]), caseW && Number(caseW[1])].filter(
    (n) => typeof n === "number" && !Number.isNaN(n),
  );
  const trailWidths = [...constWidths, ...widthHits].filter((w) => w >= 4);
  assert(
    trailWidths.length >= 1 &&
      constWidths.some((w) => w >= 4) &&
      constWidths.some((w) => w >= 7),
    `trail widths must be visible (core>=4, casing>=7); consts=${constWidths} inline=${widthHits}`,
  );
  assert(
    /'line-width'\s*:\s*TRAIL_CORE_WIDTH/.test(html) &&
      /'line-width'\s*:\s*TRAIL_CASE_WIDTH/.test(html),
    "trails layers must paint with TRAIL_CORE_WIDTH / TRAIL_CASE_WIDTH",
  );

  // Contrast vs typical OSM road greys
  assert(
    /TRAIL_CORE\s*=\s*['"]#111111['"]/.test(html) ||
      /'line-color'\s*:\s*TRAIL_CORE/.test(html),
    "trail core must use high-contrast TRAIL_CORE (#111111), not road grey",
  );
  assert(
    /TRAIL_CASE\s*=\s*['"]#ffffff['"]/.test(html) ||
      /'line-color'\s*:\s*TRAIL_CASE/.test(html),
    "trail casing must be white (#ffffff) for contrast on the basemap",
  );

  assert(html.includes("owned-fill"), "owned-fill layer missing");
  assert(/id:\s*['"]trails['"]/.test(html), "trails layer id missing");
  // In map.on('load'), owned-fill must be added before ensureTrailLayers()
  // so trail polylines sit above territory fill at runtime.
  const loadMatch = html.match(/map\.on\(\s*['"]load['"][\s\S]*?ready\s*=\s*true/);
  assert(loadMatch, "map.on('load') init block missing");
  const loadBlock = loadMatch[0];
  const ownedInLoad = loadBlock.indexOf("owned-fill");
  const trailsInLoad = loadBlock.indexOf("ensureTrailLayers");
  assert(ownedInLoad >= 0, "owned-fill not added in map load handler");
  assert(trailsInLoad >= 0, "ensureTrailLayers() not called in map load handler");
  assert(
    trailsInLoad > ownedInLoad,
    "ensureTrailLayers() must run after owned-fill so trails paint above territory",
  );

  assert(
    html.includes("__paperPaint"),
    "window.__paperPaint bridge missing — iOS WebView needs injectJavaScript paint path",
  );
  assert(
    html.includes("getSource('trails').setData") ||
      html.includes('getSource("trails").setData') ||
      /getSource\(\s*['"]trails['"]\s*\)\.setData/.test(html),
    "trails source setData missing — layer would stay empty",
  );
}

function main() {
  const mod = loadBuildMapHtml();
  assert(typeof mod.buildMapHtml === "function", "buildMapHtml export missing");
  assert(
    typeof mod.MAP_HTML_REVISION === "number" && mod.MAP_HTML_REVISION >= 9,
    "MAP_HTML_REVISION must be bumped (>=9) so Simulator remounts WebView",
  );

  let html = mod.buildMapHtml();

  if (process.env.VERIFY_TRAILS_BREAK === "1") {
    // Self-check: removing the layer must make analyze() fail.
    html = html
      .replace(/TRAIL_LAYER_OK/g, "TRAIL_LAYER_GONE")
      .replace(/id:'trails'/g, "id:'trails_removed'")
      .replace(/id:"trails"/g, 'id:"trails_removed"');
    let failed = false;
    quietAssert = true;
    try {
      analyze(html);
    } catch {
      failed = true;
    }
    quietAssert = false;
    assert(
      failed,
      "VERIFY_TRAILS_BREAK=1 expected analyze() to fail after stripping trail layer",
    );
    console.log(
      "OK: verify-map-trails self-check — analyze fails when trail layer removed",
    );
    return;
  }

  analyze(html);
  console.log(
    `OK: verify-map-trails — trail source/layer in HTML (rev ${mod.MAP_HTML_REVISION}), contrast widths, above fill, __paperPaint bridge`,
  );
}

try {
  main();
} catch (e) {
  process.exitCode = 1;
}

