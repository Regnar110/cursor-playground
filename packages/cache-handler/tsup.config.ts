import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/remote-handler.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  target: "node20",
  outDir: "dist",
  external: ["ioredis", "lru-cache"],
});
