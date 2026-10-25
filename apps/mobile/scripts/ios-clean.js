#!/usr/bin/env node
/**
 * Remove native iOS build state that survives a JS reinstall:
 * Pods + Podfile.lock (may point at the old node_modules/.pnpm layout),
 * Xcode DerivedData for this project (stale ExpoModulesCore .pcm),
 * and the app installed on the booted Simulator (stale AppDelegate).
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");

const iosDir = path.resolve(__dirname, "../ios");
const bundleId = require("../app.json").expo.ios.bundleIdentifier;

for (const p of ["Pods", "Podfile.lock", "build"]) {
  fs.rmSync(path.join(iosDir, p), { recursive: true, force: true });
  console.log(`removed ios/${p}`);
}

const derivedData = path.join(os.homedir(), "Library/Developer/Xcode/DerivedData");
if (fs.existsSync(derivedData)) {
  for (const name of fs.readdirSync(derivedData)) {
    if (name.startsWith("paperirl-")) {
      fs.rmSync(path.join(derivedData, name), { recursive: true, force: true });
      console.log(`removed DerivedData/${name}`);
    }
  }
}

if (process.platform === "darwin") {
  const r = spawnSync("xcrun", ["simctl", "uninstall", "booted", bundleId], { encoding: "utf8" });
  console.log(
    r.status === 0
      ? `uninstalled ${bundleId} from booted Simulator`
      : `no booted Simulator app to uninstall (${(r.stderr || "").trim() || "skipped"})`
  );
}
