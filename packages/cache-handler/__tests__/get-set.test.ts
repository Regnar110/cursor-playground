import v8 from "node:v8";
import { describe, expect, test } from "@jest/globals";
import {
  CACHE_KEY,
  ENCODED_KEY,
  TAG,
  FakeRedis,
  handler,
  loadHandler,
  makeEntry,
  readAll,
  setupHandlerTests,
} from "./helpers/test-helpers.js";

setupHandlerTests();

describe("set + get", () => {
  test("roundtrip: get returns stored payload and metadata", async () => {
    const ts = Date.now();
    await handler.set(CACHE_KEY, Promise.resolve(makeEntry({ payload: "hello", timestamp: ts })));

    const entry = await handler.get(CACHE_KEY, []);

    expect(entry).toBeDefined();
    expect(await readAll(entry!.value)).toBe("hello");
    expect(entry!.tags).toEqual([TAG]);
    expect(entry!.timestamp).toBe(ts);
    expect(entry!.revalidate).toBe(300);
  });

  test('stores in Redis under semicolon-encoded key and indexes tag 1:1', async () => {
    await handler.set(CACHE_KEY, Promise.resolve(makeEntry()));

    expect(FakeRedis.state.store.has(ENCODED_KEY)).toBe(true);
    expect(FakeRedis.state.store.has(CACHE_KEY)).toBe(false);
    expect(Array.from(FakeRedis.state.sets.get(`index:${TAG}`) ?? [])).toEqual([ENCODED_KEY]);
    expect(FakeRedis.state.ttls.get(ENCODED_KEY)).toBe(3600);
    expect(FakeRedis.state.ttls.get(`index:${TAG}`)).toBe(3660);
  });

  test("Redis payload includes _meta for Redis Insight debugging", async () => {
    await handler.set(CACHE_KEY, Promise.resolve(makeEntry()));

    const raw = v8.deserialize(FakeRedis.state.store.get(ENCODED_KEY)!) as {
      _meta: { layer: string; resource: string; locale: string };
    };
    expect(raw._meta).toMatchObject({ layer: "data", resource: "posts", locale: "pl/pl" });
  });

  test("another instance (fresh process) reads entry from Redis", async () => {
    await handler.set(CACHE_KEY, Promise.resolve(makeEntry({ payload: "shared" })));

    const handlerB = loadHandler();
    const entry = await handlerB.get(CACHE_KEY, []);

    expect(entry).toBeDefined();
    expect(await readAll(entry!.value)).toBe("shared");
  });

  test("entry past revalidate window is skipped (miss)", async () => {
    await handler.set(
      CACHE_KEY,
      Promise.resolve(makeEntry({ revalidate: 1, timestamp: Date.now() - 5000 })),
    );

    expect(await handler.get(CACHE_KEY, [])).toBeUndefined();
  });
});
