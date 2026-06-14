/**
 * Unit tests for cache-debug module (ring buffer, formatting, auth gate).
 */

describe("cache-debug", () => {
  const originalEnv = process.env.REMOTE_CACHE_DEBUG;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.REMOTE_CACHE_DEBUG;
    } else {
      process.env.REMOTE_CACHE_DEBUG = originalEnv;
    }
  });

  test("disabled by default — log is a no-op", () => {
    delete process.env.REMOTE_CACHE_DEBUG;
    jest.isolateModules(() => {
      const dbg = require("../cache-debug.mjs");
      expect(dbg.isDebugEnabled()).toBe(false);
      dbg.log("GET", "HIT", "should not appear");
      expect(dbg.getEvents()).toEqual([]);
    });
  });

  test("enabled when REMOTE_CACHE_DEBUG is set", () => {
    process.env.REMOTE_CACHE_DEBUG = "test-secret";
    jest.isolateModules(() => {
      const dbg = require("../cache-debug.mjs");
      expect(dbg.isDebugEnabled()).toBe(true);
      expect(dbg.authorizeDebugToken("test-secret")).toBe(true);
      expect(dbg.authorizeDebugToken("wrong")).toBe(false);
    });
  });

  test("formatEventBlock is human-readable", () => {
    jest.isolateModules(() => {
      const dbg = require("../cache-debug.mjs");
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
      const dbg = require("../cache-debug.mjs");
      const entry = { timestamp: 1000, tags: ["data:posts:pl:pl"], revalidate: 300 };
      const map = new Map([["data:posts:pl:pl", 2000]]);
      const reason = dbg.describeStaleReason(entry, map);
      expect(reason).toContain("data:posts:pl:pl");
      expect(reason).toContain("invalidated");
    });
  });

  test("shortKey truncates long keys", () => {
    jest.isolateModules(() => {
      const dbg = require("../cache-debug.mjs");
      const long = "a".repeat(100);
      expect(dbg.shortKey(long, 20).endsWith("…")).toBe(true);
    });
  });

  test("log stores events when enabled", () => {
    process.env.REMOTE_CACHE_DEBUG = "secret";
    jest.isolateModules(() => {
      const dbg = require("../cache-debug.mjs");
      dbg.log("GET", "MISS", "First");
      dbg.log("SET", "WRITE", "Second");
      const events = dbg.getEvents();
      expect(events).toHaveLength(2);
      expect(events[0].summary).toBe("First");
      expect(events[1].summary).toBe("Second");
    });
  });

  test("classifyCacheLayer distinguishes DATA, UI, SOFT", () => {
    jest.isolateModules(() => {
      const dbg = require("../cache-debug.mjs");
      expect(dbg.classifyCacheLayer(["data:posts:pl:pl"])).toBe("DATA");
      expect(dbg.classifyCacheLayer(["ui:header:pl:pl"])).toBe("UI");
      expect(dbg.classifyCacheLayer([], ["path:/fr/fr"])).toBe("SOFT");
      expect(dbg.classifyCacheLayer(["data:x", "ui:y"])).toBe("DATA+UI");
    });
  });
});
