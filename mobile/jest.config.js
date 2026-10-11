// jest-expo exempts pnpm's `.pnpm` store from transformIgnorePatterns so the
// packages inside it are still compiled. Bun's isolated installs keep the same
// shape under `.bun`, so it gets the same exemption.
const { transformIgnorePatterns } = require('jest-expo/jest-preset');

module.exports = {
  preset: 'jest-expo',
  // Babel injects `@babel/runtime` helpers into every file it compiles,
  // including the engine's (web/engine), which resolves from its own folder
  // and has no such dependency. Fall back to the app's node_modules — the
  // same fallback Metro uses (metro.config.js).
  modulePaths: ['<rootDir>/node_modules'],
  transformIgnorePatterns: transformIgnorePatterns.map((pattern) =>
    pattern.replace('(.pnpm|', '(.pnpm|.bun|'),
  ),
};
