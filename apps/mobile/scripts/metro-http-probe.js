#!/usr/bin/env node
/**
 * Start Expo Metro from apps/mobile (as `pnpm --filter @paper-irl/mobile` does)
 * and HTTP-GET the URLs AppDelegate / monorepo Metro use.
 *
 * Expect:
 *   - /.expo/.virtual-metro-entry.bundle → 200, no resolve errors
 *   - /apps/mobile/index.bundle → 200
 *   - /index.bundle → resolve error (workspace root has no index) OR non-app
 *
 * Exit 0 on success.
 */
const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const projectRoot = path.resolve(__dirname, "..");
const workspaceRoot = path.resolve(projectRoot, "../..");
const port = Number(process.env.METRO_PROBE_PORT || 8099);

function get(urlPath) {
  return new Promise((resolve) => {
    const req = http.get(
      { host: "127.0.0.1", port, path: urlPath, timeout: 90_000 },
      (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode, body }));
      }
    );
    req.on("error", (err) => resolve({ status: 0, body: String(err) }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ status: 0, body: "timeout" });
    });
  });
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function fail(msg) {
  console.error("FAIL:", msg);
  process.exit(1);
}

async function waitForMetro(logRef, child) {
  for (let i = 0; i < 90; i++) {
    const ping = await get("/status");
    if (
      ping.status === 200 ||
      (ping.body && ping.body.includes("packager-status:running"))
    ) {
      return true;
    }
    if (child.exitCode != null) {
      fail(`Metro exited early (${child.exitCode}): ${logRef.current.slice(-1500)}`);
    }
    await sleep(500);
  }
  return false;
}

async function main() {
  console.log(`Starting Metro in ${projectRoot} on :${port} (cwd=package, like pnpm --filter)`);

  const child = spawn(
    "npx",
    ["expo", "start", "--port", String(port), "--non-interactive"],
    {
      cwd: projectRoot,
      env: { ...process.env, CI: "1", EXPO_NO_TELEMETRY: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    }
  );

  const logRef = { current: "" };
  child.stdout.on("data", (d) => {
    logRef.current += d.toString();
  });
  child.stderr.on("data", (d) => {
    logRef.current += d.toString();
  });

  const cleanup = () => {
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, 1500);
  };
  process.on("exit", cleanup);
  process.on("SIGINT", () => {
    cleanup();
    process.exit(130);
  });

  const ready = await waitForMetro(logRef, child);
  if (!ready) {
    cleanup();
    fail(`Metro did not become ready.\n${logRef.current.slice(-2000)}`);
  }
  console.log("OK: Metro ready");

  await sleep(1000);

  const virtualPath =
    "/.expo/.virtual-metro-entry.bundle?platform=ios&dev=true&minify=false&modulesOnly=false&runModule=true";
  const bareIndexPath =
    "/index.bundle?platform=ios&dev=true&minify=false&modulesOnly=false&runModule=true";
  const monoIndexPath =
    "/apps/mobile/index.bundle?platform=ios&dev=true&minify=false&modulesOnly=false&runModule=true";

  const virtual = await get(virtualPath);
  const mono = await get(monoIndexPath);
  const bare = await get(bareIndexPath);

  cleanup();
  await sleep(500);

  const hasResolveErr = (body) => /Unable to resolve/.test(body);
  const hasAppEntryBug = (body) =>
    /Unable to resolve ["']\.\.\/\.\.\/App["']/.test(body) ||
    (/expo\/AppEntry/.test(body) && /Unable to resolve/.test(body));
  const hasBabelBug = (body) => /Unable to resolve ["']@babel\/runtime/.test(body);
  const hasIndexFromRootBug = (body) =>
    /Unable to resolve module \.\/index/.test(body) ||
    /Unable to resolve module ["']\.\/index["']/.test(body);

  console.log(`virtual status=${virtual.status} resolveErr=${hasResolveErr(virtual.body)}`);
  console.log(`mono    status=${mono.status} resolveErr=${hasResolveErr(mono.body)}`);
  console.log(`bare    status=${bare.status} resolveErr=${hasResolveErr(bare.body)}`);

  if (virtual.status !== 200) {
    fail(`virtual-metro-entry HTTP ${virtual.status}: ${virtual.body.slice(0, 500)}`);
  }
  if (hasResolveErr(virtual.body) || hasAppEntryBug(virtual.body) || hasBabelBug(virtual.body)) {
    fail(`virtual-metro-entry bundle error:\n${virtual.body.slice(0, 800)}`);
  }
  console.log("OK: virtual-metro-entry bundles without AppEntry/babel errors");

  if (mono.status !== 200 || hasResolveErr(mono.body)) {
    fail(`/apps/mobile/index.bundle failed: ${mono.body.slice(0, 500)}`);
  }
  console.log("OK: /apps/mobile/index.bundle");

  // Bare /index at workspace Metro root should NOT be the happy path.
  if (bare.status === 200 && !hasResolveErr(bare.body) && !hasIndexFromRootBug(bare.body)) {
    console.log(
      "WARN: bare /index.bundle succeeded — AppDelegate must still use virtual-metro-entry (not @\"index\")"
    );
  } else {
    console.log("OK: bare /index.bundle is not a valid monorepo entry (expected)");
  }

  // Ensure workspace has no spoof index that would hide the bug
  const spoof = path.join(workspaceRoot, "index.js");
  if (fsExists(spoof)) {
    fail("repo root index.js exists — would mask index-from-root redbox; remove it");
  }

  console.log("PASS: metro-http-probe");
  process.exit(0);
}

function fsExists(p) {
  try {
    return require("fs").existsSync(p);
  } catch {
    return false;
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
