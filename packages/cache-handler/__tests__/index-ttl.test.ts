import { describe, expect, test } from "@jest/globals";
import { CACHE_KEY, TAG, FakeRedis, handler, makeEntry, setupHandlerTests } from "./helpers/test-helpers.js";

setupHandlerTests();

describe("TTL indeksow (EXPIRE NX + GT)", () => {
  test("krotszy wpis nie skraca TTL indeksu, dluzszy wydluza", async () => {
    await handler.set(CACHE_KEY, Promise.resolve(makeEntry({ expire: 3600 })));
    expect(FakeRedis.state.ttls.get(`index:${TAG}`)).toBe(3660);

    await handler.set('abc:["posts","short"]', Promise.resolve(makeEntry({ expire: 120 })));
    expect(FakeRedis.state.ttls.get(`index:${TAG}`)).toBe(3660);

    await handler.set('abc:["posts","long"]', Promise.resolve(makeEntry({ expire: 7200 })));
    expect(FakeRedis.state.ttls.get(`index:${TAG}`)).toBe(7260);
  });
});
