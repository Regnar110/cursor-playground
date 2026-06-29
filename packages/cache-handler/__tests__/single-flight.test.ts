import { describe, expect, test } from "@jest/globals";
import {
  CACHE_KEY,
  ENCODED_KEY,
  FakeRedis,
  handler,
  makeEntry,
  readAll,
  seedRedisEntry,
  setupHandlerTests,
} from "./helpers/test-helpers.js";

setupHandlerTests();

describe("single-flight", () => {
  test("miss przejmuje lock (wartosc = instanceId) i zwraca undefined", async () => {
    const result = await handler.get(CACHE_KEY, []);

    expect(result).toBeUndefined();
    const lock = FakeRedis.state.store.get(`lock:${ENCODED_KEY}`);
    expect(String(lock)).toMatch(/^pid-\d+-[0-9a-f]{12}$/);
    expect(FakeRedis.state.ttls.get(`lock:${ENCODED_KEY}`)).toBe(30);
  });

  test("set() zwalnia locka tej instancji", async () => {
    await handler.get(CACHE_KEY, []);
    await handler.set(CACHE_KEY, Promise.resolve(makeEntry()));

    expect(FakeRedis.state.store.has(`lock:${ENCODED_KEY}`)).toBe(false);
  });

  test("nie kasuje locka nalezacego do innej instancji (compare-and-delete)", async () => {
    await handler.get(CACHE_KEY, []);
    FakeRedis.state.store.set(`lock:${ENCODED_KEY}`, Buffer.from("pid-999-aaaaaaaaaaaa"));
    await handler.set(CACHE_KEY, Promise.resolve(makeEntry()));

    expect(FakeRedis.state.store.get(`lock:${ENCODED_KEY}`)?.toString()).toBe(
      "pid-999-aaaaaaaaaaaa",
    );
  });

  test("czeka na wynik instancji trzymajacej lock zamiast renderowac", async () => {
    FakeRedis.state.store.set(`lock:${ENCODED_KEY}`, Buffer.from("pid-999-aaaaaaaaaaaa"));

    const getPromise = handler.get(CACHE_KEY, []);
    setTimeout(() => {
      seedRedisEntry(ENCODED_KEY, { payload: "rendered-elsewhere" });
      FakeRedis.state.store.delete(`lock:${ENCODED_KEY}`);
    }, 150);

    const entry = await getPromise;
    expect(entry).toBeDefined();
    expect(await readAll(entry!.value)).toBe("rendered-elsewhere");
  });
});
