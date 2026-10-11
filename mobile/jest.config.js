// jest-expo exempts pnpm's `.pnpm` store from transformIgnorePatterns so the
// packages inside it are still compiled. Bun's isolated installs keep the same
// shape under `.bun`, so it gets the same exemption.
//
// Better Auth's client ships ES modules only — some as `.mjs`, which the
// preset's transform does not match — as do the packages it is built on, so
// they are compiled too (stage 4's session layer imports it).
const { transform, transformIgnorePatterns } = require('jest-expo/jest-preset');

const ESM_ONLY = ['@better-auth', 'better-auth', '@better-fetch', 'better-call', 'nanostores'];

module.exports = {
  preset: 'jest-expo',
  // Babel injects `@babel/runtime` helpers into every file it compiles,
  // including the engine's (web/engine), which resolves from its own folder
  // and has no such dependency. Fall back to the app's node_modules — the
  // same fallback Metro uses (metro.config.js).
  modulePaths: ['<rootDir>/node_modules'],
  transform: { ...transform, '\\.mjs$': transform['\\.[jt]sx?$'] },
  transformIgnorePatterns: transformIgnorePatterns.map((pattern) =>
    pattern.replace('(.pnpm|', `(.pnpm|.bun|${ESM_ONLY.join('|')}|`),
  ),
};
