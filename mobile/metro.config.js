// Expo's default config already understands the monorepo (watch folders, the
// workspace root's node_modules). One addition: Babel injects `@babel/runtime`
// helpers into the engine's files too, and web/engine has no such dependency,
// so the app's own node_modules is a fallback for every lookup. Jest does the
// same (jest.config.js, modulePaths).
const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver.nodeModulesPaths = [
  path.resolve(__dirname, 'node_modules'),
  ...(config.resolver.nodeModulesPaths ?? []),
];

module.exports = config;
