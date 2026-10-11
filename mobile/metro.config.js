// Expo's default config already understands the monorepo (watch folders, the
// workspace root's node_modules). Two additions:
//  - Babel injects `@babel/runtime` helpers into the engine's files too, and
//    web/engine has no such dependency, so the app's own node_modules is a
//    fallback for every lookup. Jest does the same (jest.config.js,
//    modulePaths).
//  - The engine has import cycles that are legal ES modules and harmless
//    (task-optimizer <-> goal-line). Metro warns about each, and the warning's
//    toast covers the tab bar; the engine is imported unchanged, so there is
//    nothing for the app to act on.
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  ...(config.resolver.nodeModulesPaths ?? []),
];

config.resolver.requireCycleIgnorePatterns = [
  ...(config.resolver.requireCycleIgnorePatterns ?? []),
  /(^|\/)web\/engine\//,
];

module.exports = config;
