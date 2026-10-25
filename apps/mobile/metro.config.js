const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

/**
 * Expo monorepo Metro setup (pnpm, node-linker=hoisted):
 * - projectRoot = apps/mobile; watchFolders / nodeModulesPaths include the workspace root.
 * - Metro's server root is the workspace root, so entry URLs are workspace-relative.
 * @see https://docs.expo.dev/guides/monorepos/
 */
const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, "../..");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, "node_modules"),
  path.resolve(workspaceRoot, "node_modules"),
];

// A bare /index.bundle (React Native's default bundle root, used by older native
// builds) resolves against the workspace root, where no index.js exists. Send it
// to this app's entry so a stale binary can never redbox on "./index".
const appEntry = "/" + path.relative(workspaceRoot, path.join(projectRoot, "index")).split(path.sep).join("/");
const expoRewrite = config.server.rewriteRequestUrl;
config.server.rewriteRequestUrl = (url) => {
  const rewritten = expoRewrite ? expoRewrite(url) : url;
  return rewritten.replace(/^((?:https?:\/\/[^/]+)?)\/index\.(bundle|map)(?=\?|$)/, `$1${appEntry}.$2`);
};

module.exports = config;
