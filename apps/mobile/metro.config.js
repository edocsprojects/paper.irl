const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

/**
 * Expo monorepo Metro setup (pnpm):
 * - projectRoot = apps/mobile (this package)
 * - watchFolders / nodeModulesPaths include the workspace root
 * - Do NOT set EXPO_NO_METRO_WORKSPACE_ROOT — Metro server root stays the
 *   repo root so virtual-metro-entry rewrites to apps/mobile/index.
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

module.exports = config;
