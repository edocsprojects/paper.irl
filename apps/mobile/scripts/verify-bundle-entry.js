#!/usr/bin/env node
/**
 * Prove Metro/Expo resolve apps/mobile/index.js — not expo/AppEntry's ../../App.
 * Runs on Linux (no Xcode). Exit 0 only if entry + export graph are correct.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const projectRoot = path.resolve(__dirname, "..");
const pkg = require(path.join(projectRoot, "package.json"));
const indexPath = path.join(projectRoot, "index.js");
const appPath = path.join(projectRoot, "App.tsx");
const appDelegate = path.join(projectRoot, "ios/paperirl/AppDelegate.mm");
const xcodeEnv = path.join(projectRoot, "ios/.xcode.env");

function fail(msg) {
  console.error("FAIL:", msg);
  process.exit(1);
}

function ok(msg) {
  console.log("OK:", msg);
}

if (pkg.main !== "index.js") fail(`package.json main is ${pkg.main}, expected index.js`);
ok(`package.json main = index.js`);

if (!fs.existsSync(indexPath)) fail("apps/mobile/index.js missing");
if (!fs.existsSync(appPath)) fail("apps/mobile/App.tsx missing");
const indexSrc = fs.readFileSync(indexPath, "utf8");
if (!indexSrc.includes('from "./App"') && !indexSrc.includes("from './App'")) {
  fail("index.js must import ./App");
}
if (!indexSrc.includes("registerRootComponent")) {
  fail("index.js must call registerRootComponent");
}
ok("index.js registers ./App");

const expoReq = createRequire(require.resolve("expo/package.json", { paths: [projectRoot] }));
const { resolveEntryPoint } = expoReq("@expo/config/paths");
const resolved = resolveEntryPoint(projectRoot, { platform: "ios" });
if (path.resolve(resolved) !== indexPath) {
  fail(`resolveEntryPoint → ${resolved}, expected ${indexPath}`);
}
ok(`resolveEntryPoint → ${resolved}`);

if (fs.existsSync(appDelegate)) {
  const ad = fs.readFileSync(appDelegate, "utf8");
  // Ignore comments — only the ObjC string literal matters.
  if (/jsBundleURLForBundleRoot:@"\.expo\/\.virtual-metro-entry"/.test(ad)) {
    fail("AppDelegate still uses .expo/.virtual-metro-entry (pnpm resolves to expo/AppEntry)");
  }
  if (!/jsBundleURLForBundleRoot:@"index"/.test(ad)) {
    fail('AppDelegate DEBUG root must be @"index"');
  }
  ok('AppDelegate DEBUG bundle root = "index"');
}

if (fs.existsSync(xcodeEnv)) {
  const env = fs.readFileSync(xcodeEnv, "utf8");
  if (!/ENTRY_FILE=index\.js/.test(env)) {
    fail("ios/.xcode.env must set ENTRY_FILE=index.js");
  }
  ok("ios/.xcode.env ENTRY_FILE=index.js");
}

const outDir = path.join(projectRoot, ".verify-export");
fs.rmSync(outDir, { recursive: true, force: true });

console.log("Running: npx expo export --platform ios --output-dir .verify-export");
const result = spawnSync(
  "npx",
  ["expo", "export", "--platform", "ios", "--output-dir", ".verify-export", "--clear"],
  {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, CI: "1", EXPO_NO_TELEMETRY: "1" },
    timeout: 180_000,
  }
);

if (result.status !== 0) {
  console.error(result.stdout);
  console.error(result.stderr);
  fail(`expo export exited ${result.status}`);
}

const exportLog = `${result.stdout}\n${result.stderr}`;
if (/Unable to resolve ["']\.\.\/\.\.\/App["']/.test(exportLog)) {
  fail("expo export still failed resolving ../../App from AppEntry");
}
if (/expo\/AppEntry\.js/.test(exportLog) && /Unable to resolve/.test(exportLog)) {
  fail("expo export still referencing broken AppEntry resolve");
}

// Walk exported JS for AppEntry relative import failure signature
function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, files);
    else if (/\.(js|hbc|map)$/.test(name)) files.push(p);
  }
  return files;
}

const bundles = walk(outDir);
if (bundles.length === 0) fail("expo export produced no bundle files");
ok(`expo export wrote ${bundles.length} artifact(s) under .verify-export`);

const metadataPath = path.join(outDir, "metadata.json");
if (fs.existsSync(metadataPath)) {
  const meta = fs.readFileSync(metadataPath, "utf8");
  if (meta.includes("expo/AppEntry") || meta.includes("AppEntry")) {
    fail("export metadata still references expo/AppEntry");
  }
  if (!/index-[a-f0-9]+\.hbc/.test(meta) && !meta.includes("/index")) {
    fail(`export metadata bundle is not index-*.hbc: ${meta.slice(0, 200)}`);
  }
  ok("metadata.json bundle is index-*.hbc (not AppEntry)");
}

// Confirm index is the entry used by reading export stdout for "index"
const usedAppEntryAsRoot =
  /Bundling.*expo\/AppEntry|entry.*expo\/AppEntry|AppEntry\.js as entry/i.test(exportLog);
if (usedAppEntryAsRoot) {
  fail("export log suggests AppEntry was the bundle entry");
}

console.log("\nPASS: entry is index.js; AppDelegate bypasses virtual-metro-entry; expo export succeeded.");
process.exit(0);
