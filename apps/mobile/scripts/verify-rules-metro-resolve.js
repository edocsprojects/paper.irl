#!/usr/bin/env node
/**
 * Gate: Metro must resolve @paper-irl/rules source imports that use ESM ".js"
 * extensions pointing at ".ts" files (e.g. export * from "./types.js").
 *
 * Reproduces Ethan's redbox without a Simulator:
 *   Unable to resolve module ./types.js from packages/rules/src/index.ts
 *
 * Fails if metro.config.js drops the .js→.ts remap for packages/rules.
 * Does not wipe node_modules; does not change the Node/vitest runner.
 *
 * Set VERIFY_RULES_METRO_EXPORT=1 to also run expo export (also covered by
 * verify-bundle-entry with an explicit ./types.js failure message).
 *
 * Run: node ./scripts/verify-rules-metro-resolve.js
 */

const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const projectRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(projectRoot, "../..");
const rulesIndex = path.join(workspaceRoot, "packages/rules/src/index.ts");
const typesTs = path.join(workspaceRoot, "packages/rules/src/types.ts");

function fail(msg) {
  console.error("FAIL:", msg);
  process.exit(1);
}

function ok(msg) {
  console.log("OK:", msg);
}

if (!fs.existsSync(rulesIndex)) fail(`missing ${rulesIndex}`);
if (!fs.existsSync(typesTs)) fail(`missing ${typesTs}`);
if (fs.existsSync(path.join(workspaceRoot, "packages/rules/src/types.js"))) {
  fail(
    "packages/rules/src/types.js exists — gate expects TS-only source with .js import specifiers",
  );
}

const indexSrc = fs.readFileSync(rulesIndex, "utf8");
if (!/from\s+["']\.\/types\.js["']/.test(indexSrc)) {
  fail('packages/rules/src/index.ts must import "./types.js" (ESM TS style)');
}

const metroConfigPath = path.join(projectRoot, "metro.config.js");
const metroSrc = fs.readFileSync(metroConfigPath, "utf8");
if (!/resolveRequest/.test(metroSrc)) {
  fail("apps/mobile/metro.config.js must set resolver.resolveRequest");
}
if (!/packages\/rules/.test(metroSrc) && !/rulesSrc/.test(metroSrc)) {
  fail("metro resolveRequest must specially handle packages/rules .js→.ts");
}

let metroConfig;
try {
  // Clear cache so edits to metro.config.js are picked up in the same verify run.
  delete require.cache[require.resolve(metroConfigPath)];
  metroConfig = require(metroConfigPath);
} catch (e) {
  fail(`require metro.config.js failed: ${e && e.message ? e.message : e}`);
}

const resolveRequest = metroConfig.resolver && metroConfig.resolver.resolveRequest;
if (typeof resolveRequest !== "function") {
  fail("metro.config.js resolver.resolveRequest is not a function");
}

const resolved = resolveRequest(
  {
    originModulePath: rulesIndex,
    // Mimic Metro: next hop is not ourselves.
    resolveRequest: require("metro-resolver").resolve,
  },
  "./types.js",
  "ios",
);

if (!resolved || resolved.type !== "sourceFile") {
  fail(
    `resolveRequest("./types.js" from rules index) did not return a sourceFile (got ${JSON.stringify(resolved)})`,
  );
}
const got = path.resolve(resolved.filePath);
const want = path.resolve(typesTs);
if (got !== want) {
  fail(`resolveRequest mapped ./types.js → ${got}, expected ${want}`);
}
ok("metro resolveRequest maps packages/rules ./types.js → types.ts");

// Also remap a nested import (lobby → geo.js).
const lobbyTs = path.join(workspaceRoot, "packages/rules/src/lobby.ts");
const geoTs = path.join(workspaceRoot, "packages/rules/src/geo.ts");
const geoResolved = resolveRequest(
  {
    originModulePath: lobbyTs,
    resolveRequest: require("metro-resolver").resolve,
  },
  "./geo.js",
  "ios",
);
if (!geoResolved || path.resolve(geoResolved.filePath) !== path.resolve(geoTs)) {
  fail(
    `resolveRequest("./geo.js" from lobby.ts) → ${geoResolved && geoResolved.filePath}`,
  );
}
ok("metro resolveRequest maps packages/rules ./geo.js → geo.ts");

if (process.env.VERIFY_RULES_METRO_EXPORT === "1") {
  const outDir = path.join(projectRoot, ".verify-rules-metro");
  fs.rmSync(outDir, { recursive: true, force: true });
  const exportResult = spawnSync(
    "npx",
    ["expo", "export", "--platform", "ios", "--output-dir", outDir],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, CI: "1", EXPO_NO_TELEMETRY: "1" },
      timeout: 180_000,
    },
  );
  const log = `${exportResult.stdout || ""}\n${exportResult.stderr || ""}`;
  if (/Unable to resolve module \.\/types\.js/.test(log)) {
    console.error(log.slice(-2000));
    fail(
      "expo export still cannot resolve packages/rules ./types.js — Metro remap broken",
    );
  }
  if (exportResult.status !== 0) {
    console.error(log.slice(-2500));
    fail(
      `expo export exited ${exportResult.status} while verifying @paper-irl/rules`,
    );
  }
  ok("expo export bundles @paper-irl/rules without ./types.js redbox");
}

console.log("PASS: verify-rules-metro-resolve");
process.exit(0);
