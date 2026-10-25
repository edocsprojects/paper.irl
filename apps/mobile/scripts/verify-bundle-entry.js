#!/usr/bin/env node
/**
 * Linux Metro gates for the pnpm monorepo Expo app.
 * Catches failure modes without Xcode/Simulator:
 *   1) @babel/runtime missing under pnpm
 *   2) expo/AppEntry ../../App (wrong entry)
 *   3) bare "index" resolved from monorepo root (AppDelegate @"index")
 *
 * Also runs Metro the way root `pnpm mobile:ios:*` does (package cwd via filter)
 * and HTTP-GETs virtual-metro-entry + apps/mobile/index.
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");
const { createRequire } = require("module");

const projectRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(projectRoot, "../..");
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

function section(title) {
  console.log(`\n=== ${title} ===`);
}

section("map trail render HTML (MapLibre layer, not payload-only)");
{
  const trailProbe = spawnSync(
    "node",
    [path.join(__dirname, "verify-map-trails.js")],
    { cwd: projectRoot, encoding: "utf8", env: process.env },
  );
  process.stdout.write(trailProbe.stdout || "");
  process.stderr.write(trailProbe.stderr || "");
  if (trailProbe.status !== 0) {
    fail(`verify-map-trails exited ${trailProbe.status}`);
  }
  const breakProbe = spawnSync(
    "node",
    [path.join(__dirname, "verify-map-trails.js")],
    {
      cwd: projectRoot,
      encoding: "utf8",
      env: { ...process.env, VERIFY_TRAILS_BREAK: "1" },
    },
  );
  process.stdout.write(breakProbe.stdout || "");
  process.stderr.write(breakProbe.stderr || "");
  if (breakProbe.status !== 0) {
    fail(
      `verify-map-trails BREAK self-check exited ${breakProbe.status} (must fail when layer removed)`,
    );
  }
  ok("verify-map-trails + BREAK self-check");
}

section("static entry / native config");

if (pkg.main !== "index.js") fail(`package.json main is ${pkg.main}, expected index.js`);
ok("package.json main = index.js");

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
const pathsApi = expoReq("@expo/config/paths");
const resolved = pathsApi.resolveEntryPoint(projectRoot, { platform: "ios" });
if (path.resolve(resolved) !== indexPath) {
  fail(`resolveEntryPoint → ${resolved}, expected ${indexPath}`);
}
ok(`resolveEntryPoint → ${resolved}`);

const serverRoot = pathsApi.getMetroServerRoot(projectRoot);
if (path.resolve(serverRoot) !== workspaceRoot) {
  fail(
    `getMetroServerRoot → ${serverRoot}, expected workspace ${workspaceRoot}. ` +
      `Do not set EXPO_NO_METRO_WORKSPACE_ROOT — virtual-metro-entry must rewrite to apps/mobile/index.`
  );
}
ok(`Metro server root = workspace`);

const relativeEntry = path.relative(serverRoot, resolved).replace(/\.[tj]sx?$/, "");
const normalized = relativeEntry.split(path.sep).join("/");
if (normalized !== "apps/mobile/index") {
  fail(`relative entry from server root is ${normalized}, expected apps/mobile/index`);
}
ok(`workspace-relative entry = ${normalized}`);

if (!fs.existsSync(appDelegate)) fail("AppDelegate.mm missing");
const ad = fs.readFileSync(appDelegate, "utf8");
if (/jsBundleURLForBundleRoot:@"index"/.test(ad)) {
  fail(
    'AppDelegate uses @"index" — Metro resolves that from the monorepo root and redboxes. ' +
      'Use @".expo/.virtual-metro-entry" instead.'
  );
}
if (!/jsBundleURLForBundleRoot:@"\.expo\/\.virtual-metro-entry"/.test(ad)) {
  fail('AppDelegate DEBUG root must be @".expo/.virtual-metro-entry"');
}
ok('AppDelegate DEBUG = ".expo/.virtual-metro-entry"');

if (fs.existsSync(xcodeEnv)) {
  const env = fs.readFileSync(xcodeEnv, "utf8");
  if (!/ENTRY_FILE=index\.js/.test(env)) {
    fail("ios/.xcode.env must set ENTRY_FILE=index.js");
  }
  ok("ios/.xcode.env ENTRY_FILE=index.js");
}

if (fs.existsSync(path.join(workspaceRoot, "index.js"))) {
  fail("repo-root index.js would mask the index-from-root redbox — remove it");
}
ok("no repo-root index.js spoof");

section("virtual-metro-entry rewrite");

const { getRewriteRequestUrl } = require("@expo/metro-config/build/rewriteRequestUrl");
const rewrite = getRewriteRequestUrl(projectRoot);
const virtualUrl =
  "/.expo/.virtual-metro-entry.bundle?platform=ios&dev=true&minify=false&modulesOnly=false&runModule=true";
const rewritten = rewrite(virtualUrl);
if (!rewritten.includes("/apps/mobile/index.bundle")) {
  fail(`virtual-metro-entry rewrote to ${rewritten}, expected /apps/mobile/index.bundle`);
}
if (/expo\/AppEntry/.test(rewritten)) {
  fail(`virtual-metro-entry still points at AppEntry: ${rewritten}`);
}
ok(`rewrite → ${rewritten.split("?")[0]}`);

section("babel runtime on Metro nodeModulesPaths");

const babelMobile = path.join(
  projectRoot,
  "node_modules/@babel/runtime/helpers/interopRequireDefault.js"
);
const babelRoot = path.join(
  workspaceRoot,
  "node_modules/@babel/runtime/helpers/interopRequireDefault.js"
);
if (!fs.existsSync(babelMobile) && !fs.existsSync(babelRoot)) {
  fail("@babel/runtime helpers missing from apps/mobile and workspace node_modules");
}
ok("@babel/runtime helpers present");

section("node_modules layout (node-linker=hoisted, no stale .pnpm links)");

const pnpmStore = path.join(workspaceRoot, "node_modules/.pnpm");
const staleStore = fs.existsSync(pnpmStore)
  ? fs.readdirSync(pnpmStore).filter((n) => n !== "lock.yaml" && !n.startsWith("."))
  : [];
if (staleStore.length) {
  fail(
    `node_modules/.pnpm still holds ${staleStore.length} packages from the isolated layout ` +
      `(e.g. ${staleStore[0]}). rm -rf node_modules apps/*/node_modules packages/*/node_modules && pnpm install`
  );
}
const mobileModules = path.join(projectRoot, "node_modules");
for (const name of fs.existsSync(mobileModules) ? fs.readdirSync(mobileModules) : []) {
  const p = path.join(mobileModules, name);
  if (fs.lstatSync(p).isSymbolicLink() && fs.readlinkSync(p).includes(".pnpm")) {
    fail(`apps/mobile/node_modules/${name} is a stale symlink into .pnpm — clean reinstall required`);
  }
}
ok("hoisted layout, no .pnpm package links");

section("iOS autolinking (what pod install links)");

const autolink = spawnSync(
  "npx",
  ["expo-modules-autolinking", "resolve", "--platform", "apple", "--json"],
  { cwd: projectRoot, encoding: "utf8", env: { ...process.env, NO_COLOR: "1" }, timeout: 60_000 }
);
if (autolink.status !== 0) fail(`expo-modules-autolinking resolve failed:\n${autolink.stderr}`);
const pods = JSON.parse(autolink.stdout).modules.flatMap((m) => m.pods);
for (const required of ["ExpoModulesCore", "ExpoLocation", "EXConstants"]) {
  const pod = pods.find((p) => p.podName === required);
  if (!pod) fail(`autolinking is missing pod ${required}`);
  if (pod.podspecDir.includes("/.pnpm/")) fail(`${required} links through .pnpm: ${pod.podspecDir}`);
  if (!fs.existsSync(pod.podspecDir)) fail(`${required} podspec dir missing: ${pod.podspecDir}`);
}
ok(`autolinking resolves ${pods.length} pods incl. ExpoModulesCore/ExpoLocation/EXConstants at hoisted paths`);

if (process.platform === "darwin") {
  section("local iOS build state (macOS)");
  for (const rel of ["ios/Podfile.lock", "ios/Pods/Manifest.lock"]) {
    const p = path.join(projectRoot, rel);
    if (fs.existsSync(p) && fs.readFileSync(p, "utf8").includes(".pnpm/")) {
      fail(`${rel} references node_modules/.pnpm (old layout → corrupted ExpoModulesCore .pcm). Run: pnpm mobile:ios:clean`);
    }
  }
  ok("no Pods state pointing at the old .pnpm layout");
}

section("expo export (apps/mobile cwd)");

const outDir = path.join(projectRoot, ".verify-export");
fs.rmSync(outDir, { recursive: true, force: true });

const exportResult = spawnSync(
  "npx",
  ["expo", "export", "--platform", "ios", "--output-dir", ".verify-export", "--clear"],
  {
    cwd: projectRoot,
    encoding: "utf8",
    env: { ...process.env, CI: "1", EXPO_NO_TELEMETRY: "1" },
    timeout: 180_000,
  }
);

const exportLog = `${exportResult.stdout}\n${exportResult.stderr}`;
if (exportResult.status !== 0) {
  console.error(exportLog);
  if (/Unable to resolve ["']@babel\/runtime/.test(exportLog)) {
    fail("expo export: @babel/runtime resolve failed");
  }
  if (/Unable to resolve ["']\.\.\/\.\.\/App["']/.test(exportLog)) {
    fail("expo export: AppEntry ../../App resolve failed");
  }
  if (/Unable to resolve module \.\/index/.test(exportLog)) {
    fail("expo export: ./index resolve-from-root failed");
  }
  fail(`expo export exited ${exportResult.status}`);
}

const metadataPath = path.join(outDir, "metadata.json");
if (!fs.existsSync(metadataPath)) fail("expo export missing metadata.json");
const meta = fs.readFileSync(metadataPath, "utf8");
if (/AppEntry/.test(meta)) fail(`export metadata references AppEntry: ${meta}`);
if (!/index-[a-f0-9]+\.hbc/.test(meta)) {
  fail(`export metadata bundle is not index-*.hbc: ${meta.slice(0, 240)}`);
}
ok("expo export → index-*.hbc");

section("expo export from repo root cwd (npx expo export ./apps/mobile)");

const rootOut = path.join(projectRoot, ".verify-export-from-root");
fs.rmSync(rootOut, { recursive: true, force: true });
const rootExport = spawnSync(
  "npx",
  [
    "expo",
    "export",
    "./apps/mobile",
    "--platform",
    "ios",
    "--output-dir",
    rootOut,
    "--clear",
  ],
  {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: { ...process.env, CI: "1", EXPO_NO_TELEMETRY: "1" },
    timeout: 180_000,
  }
);
const rootLog = `${rootExport.stdout}\n${rootExport.stderr}`;
if (rootExport.status !== 0) {
  console.error(rootLog);
  if (/Unable to resolve ["']@babel\/runtime/.test(rootLog)) {
    fail("root-cwd export: @babel/runtime resolve failed");
  }
  if (/Unable to resolve ["']\.\.\/\.\.\/App["']/.test(rootLog)) {
    fail("root-cwd export: AppEntry ../../App resolve failed");
  }
  if (/Unable to resolve module \.\/index/.test(rootLog)) {
    fail("root-cwd export: ./index resolve-from-root failed");
  }
  fail(`root-cwd expo export exited ${rootExport.status}`);
}
if (!/apps\/mobile\/index\.js/.test(rootLog) && !/Bundled.*index\.js/.test(rootLog)) {
  // soft: still require metadata
}
const rootMetaPath = path.join(rootOut, "metadata.json");
if (!fs.existsSync(rootMetaPath)) fail("root-cwd export missing metadata.json");
const rootMeta = fs.readFileSync(rootMetaPath, "utf8");
if (/AppEntry/.test(rootMeta)) fail(`root-cwd metadata references AppEntry: ${rootMeta}`);
if (!/index-[a-f0-9]+\.hbc/.test(rootMeta)) {
  fail(`root-cwd metadata bundle is not index-*.hbc: ${rootMeta.slice(0, 240)}`);
}
ok("root-cwd expo export ./apps/mobile → index-*.hbc");

for (const launch of ["root", "package"]) {
  section(
    launch === "root"
      ? "Metro HTTP probe — repo root cwd via pnpm --filter (same as pnpm mobile:ios:host-bots)"
      : "Metro HTTP probe — apps/mobile cwd"
  );
  const probe = spawnSync("node", [path.join(__dirname, "metro-http-probe.js")], {
    cwd: workspaceRoot,
    encoding: "utf8",
    env: { ...process.env, CI: "1", EXPO_NO_TELEMETRY: "1", METRO_PROBE_LAUNCH: launch },
    timeout: 180_000,
  });
  process.stdout.write(probe.stdout || "");
  process.stderr.write(probe.stderr || "");
  if (probe.status !== 0) {
    fail(`metro-http-probe (${launch}) exited ${probe.status}`);
  }
  ok(`metro-http-probe (${launch})`);
}

console.log("\nGATE GREEN: babel + AppEntry + index-from-root + root and package Metro launches.");
process.exit(0);
