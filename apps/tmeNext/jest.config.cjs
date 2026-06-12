/**
 * Jest dla testow jednostkowych remote cache handlera.
 *
 * - Transform .mjs przez babel-jest z presetem inline (CELOWO bez babel.config.js
 *   w roocie aplikacji - obecnosc tego pliku wylaczylaby SWC w `next build`).
 * - ioredis podmieniony na in-memory FakeRedis przez moduleNameMapper.
 */
module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/cache-handlers"],
  // tylko *.test.js - w __tests__ leza tez pliki pomocnicze (fake-redis.cjs)
  testMatch: ["**/*.test.js"],
  moduleFileExtensions: ["js", "mjs", "cjs", "json"],
  moduleNameMapper: {
    "^ioredis$": "<rootDir>/cache-handlers/__tests__/fake-redis.cjs",
  },
  transform: {
    "^.+\\.mjs$": [
      "babel-jest",
      {
        presets: [["@babel/preset-env", { targets: { node: "current" } }]],
        babelrc: false,
        configFile: false,
      },
    ],
  },
};
