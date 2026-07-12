import v8 from "node:v8";
import { describe, expect, test } from "@jest/globals";
import {
  CACHE_KEY,
  ENCODED_KEY,
  TAG,
  FakeRedis,
  handler,
  makeEntry,
  setupHandlerTests,
} from "./helpers/test-helpers.js";

setupHandlerTests();

describe("updateTags", () => {
  test("deletes entries and index, sets meta with TTL, publishes Pub/Sub", async () => {
    const OTHER_TAG = "data:posts:de:de";
    const OTHER_KEY = 'abc:["posts","de"]';
    await handler.set(CACHE_KEY, Promise.resolve(makeEntry()));
    await handler.set(OTHER_KEY, Promise.resolve(makeEntry({ tags: [OTHER_TAG] })));

    await handler.updateTags([TAG], {});

    expect(FakeRedis.state.store.has(ENCODED_KEY)).toBe(false);
    expect(FakeRedis.state.sets.has(`index:${TAG}`)).toBe(false);
    expect(FakeRedis.state.store.has(OTHER_KEY.replace(/:/g, ";"))).toBe(true);
    expect(FakeRedis.state.store.get(`meta:revalidated-at:${TAG}`)?.toString()).toMatch(/^\d+$/);
    expect(FakeRedis.state.ttls.get(`meta:revalidated-at:${TAG}`)).toBe(7 * 24 * 60 * 60);
    expect(FakeRedis.state.sets.get("meta:revalidated-tags")?.has(TAG)).toBe(true);

    const lastPublished = FakeRedis.state.published.at(-1);
    const published = v8.deserialize(
      Buffer.from(lastPublished!.message, "base64"),
    ) as { tags: string[]; keys: string[] };
    expect(published.tags).toEqual([TAG]);
    expect(published.keys).toEqual([ENCODED_KEY]);

    expect(await handler.get(CACHE_KEY, [])).toBeUndefined();
  });

  test("getExpiration returns invalidation timestamp, 0 for unknown tags", async () => {
    const before = Date.now();
    await handler.updateTags([TAG], {});

    expect(await handler.getExpiration([TAG])).toBeGreaterThanOrEqual(before);
    expect(await handler.getExpiration(["data:unknown:xx:yy"])).toBe(0);
  });
});

describe("Pub/Sub invalidation", () => {
  test("Pub/Sub message from another instance clears local LRU", async () => {
    await handler.get("warmup:key", []);
    await handler.set(CACHE_KEY, Promise.resolve(makeEntry({ payload: "stale" })));

    FakeRedis.state.store.delete(ENCODED_KEY);
    const sub = FakeRedis.state.subscribers[0]!;
    sub.emit(
      "message",
      "pubsub:invalidate",
      v8.serialize({ tags: [TAG], keys: [ENCODED_KEY] }).toString("base64"),
    );

    expect(await handler.get(CACHE_KEY, [])).toBeUndefined();
  });
});
