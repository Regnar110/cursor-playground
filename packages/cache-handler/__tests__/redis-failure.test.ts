import { beforeEach, describe, expect, jest, test } from "@jest/globals";
import {
  CACHE_KEY,
  FakeRedis,
  handler,
  makeEntry,
  readAll,
  setupHandlerTests,
} from "./helpers/test-helpers.js";

setupHandlerTests();

describe("Redis failure resilience", () => {
  beforeEach(() => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  test("without connection handler runs on LRU only", async () => {
    FakeRedis.state.failConnect = true;

    await handler.set(CACHE_KEY, Promise.resolve(makeEntry({ payload: "lru-only" })));
    const entry = await handler.get(CACHE_KEY, []);

    expect(await readAll(entry!.value)).toBe("lru-only");
    expect(FakeRedis.state.store.size).toBe(0);
  });

  test('after "end" client is recreated after cooldown (reconnect fix)', async () => {
    await handler.set(CACHE_KEY, Promise.resolve(makeEntry()));
    const clientsBefore = FakeRedis.state.instances.length;

    FakeRedis.state.instances.find((c) => !c.subscribedChannel)!.die();

    const DURING_KEY = 'abc:["posts","during"]';
    await handler.set(DURING_KEY, Promise.resolve(makeEntry()));
    expect(FakeRedis.state.store.has(DURING_KEY.replace(/:/g, ";"))).toBe(false);

    const realNow = Date.now();
    jest.spyOn(Date, "now").mockReturnValue(realNow + 31_000);

    const AFTER_KEY = 'abc:["posts","after"]';
    await handler.set(AFTER_KEY, Promise.resolve(makeEntry({ timestamp: Date.now() })));

    expect(FakeRedis.state.instances.length).toBeGreaterThan(clientsBefore);
    expect(FakeRedis.state.store.has(AFTER_KEY.replace(/:/g, ";"))).toBe(true);
  });
});
