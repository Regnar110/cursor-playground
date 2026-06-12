/**
 * In-memory atrapa ioredis pokrywajaca dokladnie API uzywane przez remote-handler.mjs:
 * connect/status/on, get/getBuffer/set/del/exists, sadd/smembers/srem, mget,
 * expire (NX/GT), eval (compare-and-delete locka), publish/subscribe, multi().
 *
 * Stan jest trzymany na globalThis, zeby przezyl jest.resetModules() - testy moga
 * zaladowac handler na swiezo (nowy "proces") przy zachowaniu zawartosci "Redisa".
 */
const S = (globalThis.__fakeRedisState = globalThis.__fakeRedisState || {});

function initState() {
  S.instances = [];
  S.store = new Map(); // klucz -> wartosc (Buffer | string)
  S.sets = new Map(); // klucz -> Set<string>
  S.ttls = new Map(); // klucz -> sekundy (ostatnio ustawione)
  S.published = []; // { channel, message }
  S.subscribers = []; // instancje po subscribe()
  S.failConnect = false;
}

if (!S.store) {
  initState();
}

class FakeRedis {
  constructor(url, opts) {
    this.url = url;
    this.opts = opts;
    this.status = "wait";
    this.subscribedChannel = null;
    this.listeners = new Map();
    S.instances.push(this);
  }

  on(event, cb) {
    if (!this.listeners.has(event)) this.listeners.set(event, []);
    this.listeners.get(event).push(cb);
    return this;
  }

  emit(event, ...args) {
    for (const cb of this.listeners.get(event) ?? []) cb(...args);
  }

  async connect() {
    if (S.failConnect) {
      this.status = "end";
      throw new Error("ECONNREFUSED (fake)");
    }
    this.status = "ready";
  }

  /** Symuluje permanentna smierc klienta (ioredis po wyczerpaniu retryStrategy). */
  die() {
    this.status = "end";
    this.emit("end");
  }

  assertReady() {
    if (this.status !== "ready") throw new Error("Connection is closed.");
  }

  async subscribe(channel) {
    this.assertReady();
    this.subscribedChannel = channel;
    S.subscribers.push(this);
  }

  async publish(channel, message) {
    this.assertReady();
    S.published.push({ channel, message });
    for (const sub of S.subscribers) {
      if (sub.status === "ready") sub.emit("message", channel, message);
    }
    return S.subscribers.length;
  }

  async get(key) {
    this.assertReady();
    const v = S.store.get(key);
    return v == null ? null : String(v);
  }

  async getBuffer(key) {
    this.assertReady();
    const v = S.store.get(key);
    if (v == null) return null;
    return Buffer.isBuffer(v) ? v : Buffer.from(v);
  }

  async set(key, value, ...args) {
    this.assertReady();
    const nx = args.includes("NX");
    const exIdx = args.indexOf("EX");
    if (nx && S.store.has(key)) return null;
    S.store.set(key, value);
    if (exIdx !== -1) S.ttls.set(key, Number(args[exIdx + 1]));
    return "OK";
  }

  async del(key) {
    this.assertReady();
    const existed = S.store.delete(key) || S.sets.delete(key);
    S.ttls.delete(key);
    return existed ? 1 : 0;
  }

  async exists(key) {
    this.assertReady();
    return S.store.has(key) || S.sets.has(key) ? 1 : 0;
  }

  async sadd(key, ...members) {
    this.assertReady();
    if (!S.sets.has(key)) S.sets.set(key, new Set());
    const set = S.sets.get(key);
    let added = 0;
    for (const m of members) {
      if (!set.has(m)) {
        set.add(m);
        added++;
      }
    }
    return added;
  }

  async smembers(key) {
    this.assertReady();
    return Array.from(S.sets.get(key) ?? []);
  }

  async srem(key, ...members) {
    this.assertReady();
    const set = S.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const m of members) {
      if (set.delete(m)) removed++;
    }
    return removed;
  }

  async mget(keys) {
    this.assertReady();
    return keys.map((k) => (S.store.has(k) ? String(S.store.get(k)) : null));
  }

  async expire(key, ttl, mode) {
    this.assertReady();
    if (!S.store.has(key) && !S.sets.has(key)) return 0;
    const current = S.ttls.get(key);
    // Semantyka Redis 7: NX = tylko gdy klucz nie ma TTL;
    // GT = tylko gdy nowy TTL wiekszy (klucz bez TTL traktowany jak nieskonczony -> pomijany)
    if (mode === "NX" && current != null) return 0;
    if (mode === "GT" && (current == null || ttl <= current)) return 0;
    S.ttls.set(key, ttl);
    return 1;
  }

  async eval(script, numKeys, key, value) {
    this.assertReady();
    if (S.store.get(key) === value) {
      S.store.delete(key);
      S.ttls.delete(key);
      return 1;
    }
    return 0;
  }

  multi() {
    const ops = [];
    const self = this;
    const pipeline = {
      set: (...a) => (ops.push(["set", a]), pipeline),
      sadd: (...a) => (ops.push(["sadd", a]), pipeline),
      expire: (...a) => (ops.push(["expire", a]), pipeline),
      del: (...a) => (ops.push(["del", a]), pipeline),
      exec: async () => {
        const results = [];
        for (const [method, args] of ops) {
          try {
            results.push([null, await self[method](...args)]);
          } catch (err) {
            results.push([err, null]);
          }
        }
        return results;
      },
    };
    return pipeline;
  }
}

FakeRedis.state = S;
FakeRedis.reset = initState;

module.exports = FakeRedis;
