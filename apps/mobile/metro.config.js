const { getDefaultConfig } = require("expo/metro-config");
const { resolve: metroResolve } = require("metro-resolver");
const path = require("path");
const fs = require("fs");

/**
 * Expo monorepo Metro setup (pnpm, node-linker=hoisted):
 * - projectRoot = apps/mobile; watchFolders / nodeModulesPaths include the workspace root.
 * - Metro's server root is the workspace root, so entry URLs are workspace-relative.
 * - packages/rules is TypeScript ESM: source imports use ".js" extensions that map to
 *   ".ts" on disk. Node/tsc accept that; Metro does not unless we remap.
 * @see https://docs.expo.dev/guides/monorepos/
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");
const rulesSrcRoot = path.resolve(workspaceRoot, "packages/rules/src");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

/**
 * Map `./foo.js` → `./foo.ts` (or .tsx) for modules under packages/rules/src when
 * the .js file is absent. Keeps Node/vitest/tsc on real ESM .js specifiers.
 */
function resolveRulesTsExtension(originModulePath, moduleName) {
  if (!moduleName.startsWith(".") || !moduleName.endsWith(".js")) return null;
  if (!originModulePath) return null;
  const originNorm = originModulePath.replace(/\\/g, "/");
  const rulesNorm = rulesSrcRoot.replace(/\\/g, "/");
  if (!originNorm.startsWith(rulesNorm + "/") && originNorm !== rulesNorm) {
    return null;
  }
  const absJs = path.normalize(path.join(path.dirname(originModulePath), moduleName));
  if (fs.existsSync(absJs)) return null;
  for (const ext of [".ts", ".tsx"]) {
    const candidate = absJs.replace(/\.js$/i, ext);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

config.resolver.resolveRequest = (context, moduleName, platform) => {
  const mapped = resolveRulesTsExtension(context.originModulePath, moduleName);
  if (mapped) {
    return { filePath: mapped, type: "sourceFile" };
  }
  // Force metro-resolver as the next hop so we never recurse into this hook.
  return metroResolve(
    { ...context, resolveRequest: metroResolve },
    moduleName,
    platform,
  );
};

// A bare /index.bundle (React Native's default bundle root, used by older native
// builds) resolves against the workspace root, where no index.js exists. Send it
// to this app's entry so a stale binary can never redbox on "./index".
const appEntry =
  "/" +
  path
    .relative(workspaceRoot, path.join(projectRoot, "index"))
    .split(path.sep)
    .join("/");
const expoRewrite = config.server.rewriteRequestUrl;
config.server.rewriteRequestUrl = (url) => {
  const rewritten = expoRewrite ? expoRewrite(url) : url;
  return rewritten.replace(
    /^((?:https?:\/\/[^/]+)?)\/index\.(bundle|map)(?=\?|$)/,
    `$1${appEntry}.$2`,
  );
};

module.exports = config;
