/**
 * Testy jednostkowe remote cache handlera (LRU + Redis + Pub/Sub + single-flight).
 */
const v8 = require("node:v8");

const TAG = "data:posts:pl:pl";
const CACHE_KEY = 'abc:["posts",{"country":"pl","lang":"pl"}]';
const ENCODED_KEY = CACHE_KEY.replace(/:/g, ";");

let FakeRedis;
let handler;

function loadHandler() {
  jest.resetModules();
  FakeRedis = require("./fake-redis.cjs");
  return require("../src/handler/create-handler.ts").default;
}

function streamFrom(text) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(text));
      controller.close();
    },
  });
}

async function readAll(stream) {
  const reader = stream.getReader();
  const chunks = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString();
}

function makeEntry({
  payload = "hello",
  tags = [TAG],
  revalidate = 300,
  expire = 3600,
  timestamp = Date.now(),
} = {}) {
  return { value: streamFrom(payload), tags, stale: 60, timestamp, expire, revalidate };
}

function seedRedisEntry(
  encodedKey,
  {
    payload = "remote",
    tags = [TAG],
    revalidate = 300,
    expire = 3600,
    timestamp = Date.now(),
  } = {},
) {
  FakeRedis.state.store.set(
    encodedKey,
    v8.serialize({ value: Buffer.from(payload), tags, stale: 60, timestamp, expire, revalidate }),
  );
}

beforeEach(() => {
  process.env.REDIS_HOST = "fake";
  process.env.REDIS_PORT = "6379";
  process.env.REDIS_DB = "0";
  process.env.REDIS_PASSWORD = "test";
  delete process.env.REMOTE_CACHE_DEBUG_ENABLED;
  delete process.env.NEXT_PHASE;
  handler = loadHandler();
  FakeRedis.reset();
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("set + get", () => {
  test("roundtrip: get zwraca zapisany payload i metadane", async () => {
    const ts = Date.now();
    await handler.set(CACHE_KEY, Promise.resolve(makeEntry({ payload: "hello", timestamp: ts })));

    const entry = await handler.get(CACHE_KEY, []);

    expect(entry).toBeDefined();
    expect(await readAll(entry.value)).toBe("hello");
    expect(entry.tags).toEqual([TAG]);
    expect(entry.timestamp).toBe(ts);
    expect(entry.revalidate).toBe(300);
  });

  test('zapisuje w Redis pod kluczem z ";" zamiast ":" i indeksuje tag 1:1', async () => {
    await handler.set(CACHE_KEY, Promise.resolve(makeEntry()));

    expect(FakeRedis.state.store.has(ENCODED_KEY)).toBe(true);
    expect(FakeRedis.state.store.has(CACHE_KEY)).toBe(false);
    expect(Array.from(FakeRedis.state.sets.get(`index:${TAG}`))).toEqual([ENCODED_KEY]);
    expect(FakeRedis.state.ttls.get(ENCODED_KEY)).toBe(3600);
    expect(FakeRedis.state.ttls.get(`index:${TAG}`)).toBe(3660);
  });

  test("payload w Redis zawiera _meta do debugowania w Redis Insight", async () => {
    await handler.set(CACHE_KEY, Promise.resolve(makeEntry()));

    const raw = v8.deserialize(FakeRedis.state.store.get(ENCODED_KEY));
    expect(raw._meta).toMatchObject({ layer: "data", resource: "posts", locale: "pl/pl" });
  });

  test("inna instancja (swiezy proces) czyta wpis z Redis", async () => {
    await handler.set(CACHE_KEY, Promise.resolve(makeEntry({ payload: "shared" })));

    const handlerB = loadHandler();
    const entry = await handlerB.get(CACHE_KEY, []);

    expect(entry).toBeDefined();
    expect(await readAll(entry.value)).toBe("shared");
  });

  test("wpis po uplywie revalidate jest pomijany (miss)", async () => {
    await handler.set(
      CACHE_KEY,
      Promise.resolve(makeEntry({ revalidate: 1, timestamp: Date.now() - 5000 })),
    );

    expect(await handler.get(CACHE_KEY, [])).toBeUndefined();
  });
});

describe("single-flight", () => {
  test("miss przejmuje lock (wartosc = instanceId) i zwraca undefined", async () => {
    const result = await handler.get(CACHE_KEY, []);

    expect(result).toBeUndefined();
    const lock = FakeRedis.state.store.get(`lock:${ENCODED_KEY}`);
    expect(lock).toMatch(/^pid-\d+-[0-9a-f]{12}$/);
    expect(FakeRedis.state.ttls.get(`lock:${ENCODED_KEY}`)).toBe(30);
  });

  test("set() zwalnia locka tej instancji", async () => {
    await handler.get(CACHE_KEY, []);
    await handler.set(CACHE_KEY, Promise.resolve(makeEntry()));

    expect(FakeRedis.state.store.has(`lock:${ENCODED_KEY}`)).toBe(false);
  });

  test("nie kasuje locka nalezacego do innej instancji (compare-and-delete)", async () => {
    await handler.get(CACHE_KEY, []);
    FakeRedis.state.store.set(`lock:${ENCODED_KEY}`, "pid-999-aaaaaaaaaaaa");
    await handler.set(CACHE_KEY, Promise.resolve(makeEntry()));

    expect(FakeRedis.state.store.get(`lock:${ENCODED_KEY}`)).toBe("pid-999-aaaaaaaaaaaa");
  });

  test("czeka na wynik instancji trzymajacej lock zamiast renderowac", async () => {
    FakeRedis.state.store.set(`lock:${ENCODED_KEY}`, "pid-999-aaaaaaaaaaaa");

    const getPromise = handler.get(CACHE_KEY, []);
    setTimeout(() => {
      seedRedisEntry(ENCODED_KEY, { payload: "rendered-elsewhere" });
      FakeRedis.state.store.delete(`lock:${ENCODED_KEY}`);
    }, 150);

    const entry = await getPromise;
    expect(entry).toBeDefined();
    expect(await readAll(entry.value)).toBe("rendered-elsewhere");
  });
});

describe("invalidacja (updateTags)", () => {
  test("kasuje wpisy i indeks, ustawia meta z TTL, publikuje Pub/Sub", async () => {
    const OTHER_TAG = "data:posts:de:de";
    const OTHER_KEY = 'abc:["posts","de"]';
    await handler.set(CACHE_KEY, Promise.resolve(makeEntry()));
    await handler.set(OTHER_KEY, Promise.resolve(makeEntry({ tags: [OTHER_TAG] })));

    await handler.updateTags([TAG], {});

    expect(FakeRedis.state.store.has(ENCODED_KEY)).toBe(false);
    expect(FakeRedis.state.sets.has(`index:${TAG}`)).toBe(false);
    expect(FakeRedis.state.store.has(OTHER_KEY.replace(/:/g, ";"))).toBe(true);
    expect(FakeRedis.state.store.get(`meta:revalidated-at:${TAG}`)).toMatch(/^\d+$/);
    expect(FakeRedis.state.ttls.get(`meta:revalidated-at:${TAG}`)).toBe(7 * 24 * 60 * 60);
    expect(FakeRedis.state.sets.get("meta:revalidated-tags").has(TAG)).toBe(true);

    const published = v8.deserialize(
      Buffer.from(FakeRedis.state.published.at(-1).message, "base64"),
    );
    expect(published.tags).toEqual([TAG]);
    expect(published.keys).toEqual([ENCODED_KEY]);

    expect(await handler.get(CACHE_KEY, [])).toBeUndefined();
  });

  test("getExpiration zwraca timestamp invalidacji, 0 dla nieznanych tagow", async () => {
    const before = Date.now();
    await handler.updateTags([TAG], {});

    expect(await handler.getExpiration([TAG])).toBeGreaterThanOrEqual(before);
    expect(await handler.getExpiration(["data:unknown:xx:yy"])).toBe(0);
  });

  test("komunikat Pub/Sub z innej instancji czysci lokalne LRU", async () => {
    await handler.get("warmup:key", []);
    await handler.set(CACHE_KEY, Promise.resolve(makeEntry({ payload: "stale" })));

    FakeRedis.state.store.delete(ENCODED_KEY);
    const sub = FakeRedis.state.subscribers[0];
    sub.emit(
      "message",
      "pubsub:invalidate",
      v8.serialize({ tags: [TAG], keys: [ENCODED_KEY] }).toString("base64"),
    );

    expect(await handler.get(CACHE_KEY, [])).toBeUndefined();
  });
});

describe("refreshTags", () => {
  test("synchronizuje timestampy z Redis i przycina wygasle tagi", async () => {
    const STALE_TAG = "data:old:xx:yy";
    FakeRedis.state.sets.set("meta:revalidated-tags", new Set([TAG, STALE_TAG]));
    FakeRedis.state.store.set(`meta:revalidated-at:${TAG}`, "12345");

    await handler.refreshTags();

    expect(await handler.getExpiration([TAG])).toBe(12345);
    expect(await handler.getExpiration([STALE_TAG])).toBe(0);
    expect(FakeRedis.state.sets.get("meta:revalidated-tags").has(STALE_TAG)).toBe(false);
  });
});

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

describe("odpornosc na awarie Redis", () => {
  beforeEach(() => {
    jest.spyOn(console, "warn").mockImplementation(() => {});
  });

  test("bez polaczenia handler dziala na samym LRU", async () => {
    FakeRedis.state.failConnect = true;

    await handler.set(CACHE_KEY, Promise.resolve(makeEntry({ payload: "lru-only" })));
    const entry = await handler.get(CACHE_KEY, []);

    expect(await readAll(entry.value)).toBe("lru-only");
    expect(FakeRedis.state.store.size).toBe(0);
  });

  test('po "end" klient jest odtwarzany po cooldownie (fix reconnectu)', async () => {
    await handler.set(CACHE_KEY, Promise.resolve(makeEntry()));
    const clientsBefore = FakeRedis.state.instances.length;

    FakeRedis.state.instances.find((c) => !c.subscribedChannel).die();

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
