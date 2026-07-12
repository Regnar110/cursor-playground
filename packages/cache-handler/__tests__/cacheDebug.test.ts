/**
 * Unit tests for cache-debug module (write-only telemetry).
 */
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, describe, expect, jest, test } from "@jest/globals";

const PKG_ROOT = process.cwd();
const requireCjs = createRequire(join(PKG_ROOT, "package.json"));

describe("cache-debug", () => {
  const originalEnabled = process.env.REMOTE_CACHE_DEBUG_ENABLED;

  afterEach(() => {
    if (originalEnabled === undefined) {
      delete process.env.REMOTE_CACHE_DEBUG_ENABLED;
    } else {
      process.env.REMOTE_CACHE_DEBUG_ENABLED = originalEnabled;
    }
  });

  test("disabled by default — log is a no-op", () => {
    delete process.env.REMOTE_CACHE_DEBUG_ENABLED;
    jest.isolateModules(() => {
      const dbg = requireCjs(join(PKG_ROOT, "src/cache-debug.ts")) as typeof import("../src/cache-debug.js");
      expect(dbg.isDebugEnabled()).toBe(false);
      dbg.log("GET", "HIT", "should not appear");
      expect(dbg.getEvents()).toEqual([]);
    });
  });

  test("enabled when REMOTE_CACHE_DEBUG_ENABLED is true", () => {
    process.env.REMOTE_CACHE_DEBUG_ENABLED = "true";
    jest.isolateModules(() => {
      const dbg = requireCjs(join(PKG_ROOT, "src/cache-debug.ts")) as typeof import("../src/cache-debug.js");
      expect(dbg.isDebugEnabled()).toBe(true);
    });
  });

  test("formatEventBlock is human-readable", () => {
    jest.isolateModules(() => {
      const dbg = requireCjs(join(PKG_ROOT, "src/cache-debug.ts")) as typeof import("../src/cache-debug.js");
      const block = dbg.formatEventBlock({
        ts: Date.UTC(2024, 0, 1, 12, 0, 0),
        op: "GET",
        outcome: "HIT",
        summary: "Returned fresh entry from L1 (in-process LRU)",
        fields: { layer: "L1", tags: "data:posts:pl:pl" },
      });
      expect(block).toContain("GET");
      expect(block).toContain("HIT");
      expect(block).toContain("L1");
      expect(block).toContain("data:posts:pl:pl");
    });
  });

  test("describeStaleReason explains tag invalidation clearly", () => {
    jest.isolateModules(() => {
      const dbg = requireCjs(join(PKG_ROOT, "src/cache-debug.ts")) as typeof import("../src/cache-debug.js");
      const entry = { timestamp: 1000, tags: ["data:posts:pl:pl"], revalidate: 300 };
      const map = new Map([["data:posts:pl:pl", 2000]]);
      const reason = dbg.describeStaleReason(entry, map);
      expect(reason).toContain("data:posts:pl:pl");
      expect(reason).toContain("invalidated");
    });
  });

  test("log stores events when enabled", () => {
    process.env.REMOTE_CACHE_DEBUG_ENABLED = "true";
    jest.isolateModules(() => {
      const dbg = requireCjs(join(PKG_ROOT, "src/cache-debug.ts")) as typeof import("../src/cache-debug.js");
      dbg.log("GET", "MISS", "First");
      dbg.log("SET", "WRITE", "Second");
      const events = dbg.getEvents();
      expect(events).toHaveLength(2);
      expect(events[0]?.summary).toBe("First");
      expect(events[1]?.summary).toBe("Second");
    });
  });

  test("classifyCacheLayer distinguishes DATA, UI, SOFT", () => {
    jest.isolateModules(() => {
      const dbg = requireCjs(join(PKG_ROOT, "src/cache-debug.ts")) as typeof import("../src/cache-debug.js");
      expect(dbg.classifyCacheLayer(["data:posts:pl:pl"])).toBe("DATA");
      expect(dbg.classifyCacheLayer(["ui:header:pl:pl"])).toBe("UI");
      expect(dbg.classifyCacheLayer([], ["path:/fr/fr"])).toBe("SOFT");
      expect(dbg.classifyCacheLayer(["data:x", "ui:y"])).toBe("DATA+UI");
    });
  });
});
