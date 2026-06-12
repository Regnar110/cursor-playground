import v8 from "node:v8";
import crypto from "node:crypto";
import { LRUCache } from "lru-cache";
import Redis from "ioredis";

/**
 * Remote cache handler dla Next.js 16 (`use cache: remote`).
 *
 * Architektura:
 * - L1: in-process LRU (krótki TTL) — ogranicza round-tripy do Redis przy gorącym ruchu.
 * - L2: Redis — współdzielony między instancjami Next.js (wspólny artefakt .next).
 * - Pub/Sub — natychmiastowe czyszczenie L1 na wszystkich instancjach po invalidacji.
 * - Single-flight lock — przy cache miss tylko jedna instancja renderuje, reszta czeka.
 * - Timestampy tagów (meta:revalidated-at:*) — trwały backstop, gdyby instancja
 *   przegapiła komunik.at Pub/Sub (np. restart, chwilowy brak połączenia).
 *
 * Schemat kluczy Redis (Redis Insight grupuje po ":"):
 *
 * {cacheKey z ; zamiast :}                  — payload; klucz Next.js, ":" → ";" (JSON nie rozbija drzewa)
 * lock:{cacheKey z ;}                       — single-flight lock (tymczasowy, z weryfikacją właściciela)
 * index:data:cache-lab:pl:pl                — SET cacheKey (zakodowanych); drzewo index:data / index:ui
 * meta:revalidated-at:data:cache-lab:pl:pl  — timestamp invalidacji tagu (TTL = TAG_META_TTL_SECONDS)
 * meta:revalidated-tags                     — SET nazw tagów (przycinany w refreshTags)
 */
const REVALIDATED_TAGS_SET = "meta:revalidated-tags";
const INVALIDATE_CHANNEL = "pubsub:invalidate";

/** TTL locka single-flight; render dłuższy niż to okno traci locka (patrz releaseRenderLock). */
const LOCK_TTL_SECONDS = 30;
/** Odstęp między kolejnymi odpytaniami Redis podczas czekania na wynik innej instancji. */
const SINGLE_FLIGHT_POLL_MS = 100;
/** Maksymalna liczba prób odpytania = ~5 s czekania (50 × 100 ms). */
const SINGLE_FLIGHT_MAX_ATTEMPTS = 50;

/**
 * TTL metadanych invalidacji (meta:revalidated-at:*).
 *
 * Timestamp tagu jest backstopem dla wpisów zapisanych PRZED invalidacją, które nie
 * zostały skasowane (np. wyścig zapisu, instancja offline w momencie updateTags).
 * Takie wpisy i tak wygasają przez własny TTL, więc timestamp starszy niż najdłuższy
 * sensowny czas życia wpisu nie ma już czego unieważniać — może bezpiecznie zniknąć.
 * Dzięki temu meta-klucze nie akumulują się w nieskończoność.
 */
const TAG_META_TTL_SECONDS = 7 * 24 * 60 * 60;

/**
 * cacheKey Next.js to JSON z ":" w środku (np. {"country":"us"}). Redis Insight rozbija
 * klucze po ":", więc surowy cacheKey rozpadałby się na śmieciowe gałęzie. Zamieniamy ":"
 * na ";", żeby cały cacheKey był jednym czytelnym kluczem. Tagi (index / meta) są budowane
 * z osobnych stringów ("data:posts:pl:pl") i pozostają nietknięte.
 *
 * @param {string} cacheKey - Surowy klucz cache z Next.js.
 * @returns {string} Klucz z ";" zamiast ":".
 */
function encodeCacheKey(cacheKey) {
  return cacheKey.replace(/:/g, ";");
}

/**
 * Kanoniczny identyfikator wpisu — używany jako klucz Redis, klucz LRU i member w index SET.
 * Dzięki temu member w indeksie = nazwa klucza wpisu (1:1).
 *
 * @param {string} cacheKey - Surowy klucz cache z Next.js.
 * @returns {string} Klucz wpisu w Redis.
 */
function redisEntryKey(cacheKey) {
  return encodeCacheKey(cacheKey);
}

/**
 * Klucz locka single-flight dla danego wpisu.
 *
 * @param {string} cacheKey - Surowy klucz cache z Next.js.
 * @returns {string} Klucz locka w Redis.
 */
function redisLockKey(cacheKey) {
  return `lock:${encodeCacheKey(cacheKey)}`;
}

/**
 * Klucz timestampu invalidacji tagu.
 * tag = "data:posts:pl:pl" → "meta:revalidated-at:data:posts:pl:pl"
 *
 * @param {string} tag - Tag aplikacyjny (data:* / ui:*).
 * @returns {string} Klucz meta w Redis.
 */
function redisRevalidatedAtKey(tag) {
  return `meta:revalidated-at:${tag}`;
}

/**
 * Klucz indeksu wpisów dla tagu.
 * tag = "data:posts:pl:pl" → "index:data:posts:pl:pl" (drzewo index:data / index:ui)
 *
 * @param {string} tag - Tag aplikacyjny (data:* / ui:*).
 * @returns {string} Klucz indeksu (SET) w Redis.
 */
function redisIndexKey(tag) {
  return `index:${tag}`;
}

/**
 * Wyciąga metadane (warstwa / zasób / locale) z tagów wpisu na potrzeby pola `_meta`
 * w payloadzie — ułatwia debugowanie wpisów w Redis Insight.
 *
 * @param {string[]} tags - Tagi wpisu cache.
 * @returns {{layer: string, resource: string, locale: string}} Metadane opisowe.
 */
function parseTagsMeta(tags) {
  const primary = tags?.find((t) => t.includes(":") && t.split(":").length >= 4) ?? tags?.[0] ?? "";
  const parts = primary.split(":");

  return {
    layer: parts[0] === "data" || parts[0] === "ui" ? parts[0] : "unknown",
    resource: parts[1] ?? "unknown",
    locale: parts.length >= 4 ? `${parts[2]}/${parts[3]}` : "global",
  };
}

const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

/**
 * Unikalny identyfikator tej instancji — wartość locka single-flight.
 * Sam PID nie wystarcza, bo różne hosty mogą mieć ten sam PID.
 */
const instanceId = `pid-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;

/**
 * Compare-and-delete locka (atomowo w Lua): kasuje TYLKO jeśli lock nadal należy do nas.
 * Chroni przed wyścigiem: render instancji A trwa > LOCK_TTL_SECONDS → lock wygasa →
 * instancja B zakłada własny lock → A kończy i bez tej weryfikacji skasowałaby lock B.
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

/** L1: in-process LRU — krótki TTL, invalidowany przez Pub/Sub */
const lru = new LRUCache({
  max: 500,
  maxSize: 50 * 1024 * 1024,
  sizeCalculation: (entry) => entry._size ?? 1024,
  ttl: 15_000,
});

/** Zapisy w toku (cacheKey → Promise) — get() czeka na trwający set() tego samego klucza. */
const pendingSets = new Map();

/**
 * Lokalna kopia timestampów invalidacji (tag → ms). Synchronizowana z Redis w refreshTags().
 * Przycinana razem z meta-kluczami: gdy meta:revalidated-at:{tag} wygaśnie w Redis,
 * tag znika też stąd (patrz refreshTags) — mapa nie rośnie w nieskończoność.
 */
const localTagTimestamps = new Map();

let redisClient = null;
let redisSubClient = null;
let redisConnecting = null;
let redisSubConnecting = null;
let redisUnavailableUntil = 0;

/**
 * Tworzy klienta ioredis nastawionego na szybki fallback:
 * - lazyConnect — łączymy ręcznie przez connect(), żeby kontrolować fallback na LRU.
 * - enableOfflineQueue:false — komendy bez połączenia od razu rzucają błąd zamiast wisieć w kolejce.
 * - retryStrategy — kilka prób, potem rezygnacja (handler i tak ma 30s cooldown na LRU).
 *
 * @returns {import("ioredis").Redis} Niepołączony klient (status "wait").
 */
function createRedis() {
  const client = new Redis(process.env.REDIS_URL, {
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => (times > 5 ? null : Math.min(times * 200, 2000)),
  });
  client.on("error", (err) => {
    if (err?.message) {
      console.warn("[remote-cache-handler] Redis error:", err.message);
    }
  });
  // Po wyczerpaniu retryStrategy (awaria > ~5 s) ioredis emituje "end" i klient jest
  // martwy NA ZAWSZE. Bez tego resetu getRedis()/setupSubscriber() w nieskończoność
  // zwracałyby trupa (redisConnecting trzyma rozwiązany promise ze starym klientem)
  // i handler nigdy nie wróciłby do Redis aż do restartu procesu.
  client.on("end", () => {
    if (redisClient === client) {
      redisClient = null;
      redisConnecting = null;
      redisUnavailableUntil = Date.now() + 30_000;
      console.warn("[remote-cache-handler] Redis connection ended — LRU only, reconnect after 30s");
    }
    if (redisSubClient === client) {
      redisSubClient = null;
      redisSubConnecting = null;
      console.warn("[remote-cache-handler] Pub/Sub connection ended — will re-subscribe");
    }
  });
  return client;
}

/**
 * Zwraca współdzielonego klienta Redis lub null (faza build, brak REDIS_URL,
 * albo cooldown po nieudanym połączeniu). Null = handler działa na samym LRU.
 *
 * @returns {Promise<import("ioredis").Redis | null>}
 */
async function getRedis() {
  if (isBuildPhase || !process.env.REDIS_URL) {
    return null;
  }

  if (Date.now() < redisUnavailableUntil) {
    return null;
  }

  if (redisClient && redisClient.status === "ready") {
    return redisClient;
  }

  if (!redisConnecting) {
    redisConnecting = (async () => {
      const client = createRedis();
      await client.connect();
      redisClient = client;
      return client;
    })();
  }

  try {
    return await redisConnecting;
  } catch (err) {
    redisConnecting = null;
    redisUnavailableUntil = Date.now() + 30_000;
    console.warn(
      "[remote-cache-handler] Redis unavailable, using LRU only for 30s:",
      err.message || "connection failed",
    );
    return null;
  }
}

/**
 * Uruchamia (raz) subskrybenta Pub/Sub czyszczącego L1 po invalidacjach z innych instancji.
 * Wymaga osobnego połączenia — klient w trybie subscribe nie może wykonywać innych komend.
 *
 * @returns {Promise<void>}
 */
async function setupSubscriber() {
  if (isBuildPhase || !process.env.REDIS_URL || (redisSubClient && redisSubClient.status === "ready")) {
    return;
  }

  if (!redisSubConnecting) {
    redisSubConnecting = (async () => {
      const client = createRedis();
      await client.connect();
      client.on("message", (channel, message) => {
        if (channel !== INVALIDATE_CHANNEL) {
          return;
        }
        try {
          const payload = v8.deserialize(Buffer.from(message, "base64"));
          if (payload.tags?.length) {
            invalidateLruByTags(payload.tags);
          }
          if (payload.keys?.length) {
            for (const key of payload.keys) {
              lru.delete(key);
            }
          }
        } catch {
          // ignore malformed messages
        }
      });
      await client.subscribe(INVALIDATE_CHANNEL);
      redisSubClient = client;
    })();
  }

  try {
    await redisSubConnecting;
  } catch (err) {
    redisSubConnecting = null;
    console.warn("[remote-cache-handler] Pub/Sub setup failed:", err.message);
  }
}

/**
 * Rozgłasza invalidację do pozostałych instancji (czyszczenie ich L1).
 *
 * @param {{tags?: string[], keys?: string[]}} payload - Tagi i/lub klucze wpisów do usunięcia z LRU.
 * @returns {Promise<void>}
 */
async function publishInvalidation(payload) {
  try {
    const redis = await getRedis();
    if (!redis) {
      return;
    }
    await redis.publish(
      INVALIDATE_CHANNEL,
      v8.serialize(payload).toString("base64"),
    );
  } catch (err) {
    console.warn("[remote-cache-handler] publish failed:", err.message);
  }
}

/**
 * Czy wpis przekroczył swój czas rewalidacji (twardy miss).
 *
 * @param {{timestamp: number, revalidate: number}} entry
 * @returns {boolean}
 */
function isExpired(entry) {
  return Date.now() > entry.timestamp + entry.revalidate * 1000;
}

/**
 * Czy wpis jest nieświeży względem soft tagów ścieżki (revalidatePath).
 *
 * @param {{timestamp: number}} entry
 * @param {string[]} softTags - Soft tagi przekazane przez Next.js do get().
 * @returns {boolean}
 */
function isSoftTagStale(entry, softTags) {
  for (const tag of softTags) {
    const tagTs = localTagTimestamps.get(tag) ?? 0;
    if (tagTs > entry.timestamp) {
      return true;
    }
  }
  return false;
}

/**
 * Czy wpis jest nieświeży względem własnych tagów (updateTag / revalidateTag).
 *
 * @param {{timestamp: number}} entry
 * @param {string[]} tags - Tagi wpisu.
 * @returns {boolean}
 */
function isTagStale(entry, tags) {
  for (const tag of tags) {
    const tagTs = localTagTimestamps.get(tag) ?? 0;
    if (tagTs > entry.timestamp) {
      return true;
    }
  }
  return false;
}

/**
 * Zbiera cały ReadableStream do jednego Buffera (payload wpisu przed zapisem do Redis).
 *
 * @param {ReadableStream} stream
 * @returns {Promise<Buffer>}
 */
async function readStreamToBuffer(stream) {
  const reader = stream.getReader();
  const chunks = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

/**
 * Opakowuje Buffer w jednorazowy ReadableStream (format zwrotu wymagany przez Next.js).
 *
 * @param {Buffer} buffer
 * @returns {ReadableStream}
 */
function bufferToStream(buffer) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(buffer);
      controller.close();
    },
  });
}

/**
 * Deserializuje wpis z Redis (binarny v8) do struktury Next.js.
 * Pola `_buffer`/`_size` są wewnętrzne (LRU + cloneEntryForReturn) i nie trafiają do Next.js.
 *
 * @param {Buffer} raw - Surowe bajty z redis.getBuffer().
 * @returns {object} Wpis cache z value jako ReadableStream.
 */
function deserializeEntry(raw) {
  const serialized = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const parsed = v8.deserialize(serialized);
  const buffer = Buffer.isBuffer(parsed.value) ? parsed.value : Buffer.from(parsed.value);

  return {
    value: bufferToStream(buffer),
    tags: parsed.tags,
    stale: parsed.stale,
    timestamp: parsed.timestamp,
    expire: parsed.expire,
    revalidate: parsed.revalidate,
    _buffer: buffer,
    _size: buffer.length,
  };
}

/**
 * Serializuje wpis do binarnego v8 z dodatkowym `_meta` (layer/resource/locale/tags/createdAt)
 * ułatwiającym inspekcję w Redis Insight.
 *
 * Uwaga produkcyjna: format v8.serialize jest związany z wersją Node — wszystkie instancje
 * muszą działać na tej samej wersji runtime (jeden artefakt .next to zakłada).
 *
 * @param {object} entry - Wpis cache z Next.js.
 * @param {Buffer} buffer - Zebrany payload wpisu.
 * @returns {Buffer} Bajty do zapisania w Redis.
 */
function serializeEntry(entry, buffer) {
  const meta = parseTagsMeta(entry.tags);
  return v8.serialize({
    value: buffer,
    tags: entry.tags,
    stale: entry.stale,
    timestamp: entry.timestamp,
    expire: entry.expire,
    revalidate: entry.revalidate,
    _meta: {
      ...meta,
      tags: entry.tags,
      createdAt: new Date(entry.timestamp).toISOString(),
    },
  });
}

/**
 * Zwraca kopię wpisu ze świeżym ReadableStream — stream jest jednorazowy,
 * więc każdy zwrot do Next.js musi dostać nowy.
 *
 * @param {object} entry - Wpis z `_buffer` (z LRU lub po deserializacji).
 * @returns {object} Wpis gotowy do zwrotu z get().
 */
function cloneEntryForReturn(entry) {
  const buffer = entry._buffer;
  if (!buffer) {
    return entry;
  }

  return {
    value: bufferToStream(buffer),
    tags: entry.tags,
    stale: entry.stale,
    timestamp: entry.timestamp,
    expire: entry.expire,
    revalidate: entry.revalidate,
  };
}

/**
 * Usuwa z L1 wszystkie wpisy oznaczone którymkolwiek z podanych tagów.
 *
 * @param {string[]} tags
 */
function invalidateLruByTags(tags) {
  const keysToDelete = [];

  lru.forEach((entry, key) => {
    if (entry.tags?.some((tag) => tags.includes(tag))) {
      keysToDelete.push(key);
    }
  });

  for (const key of keysToDelete) {
    lru.delete(key);
  }
}

/**
 * Czeka (polling), aż instancja trzymająca lock zapisze wynik do Redis.
 * Przerywa wcześniej, gdy lock zniknie (render padł albo się zakończył).
 *
 * @param {import("ioredis").Redis} redis
 * @param {string} cacheKey - Surowy klucz cache z Next.js.
 * @param {string[]} softTags
 * @returns {Promise<object | undefined>} Świeży wpis albo undefined (czas minął / brak wyniku).
 */
async function waitForRemoteEntry(redis, cacheKey, softTags) {
  for (let attempt = 0; attempt < SINGLE_FLIGHT_MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, SINGLE_FLIGHT_POLL_MS));

    const stored = await redis.getBuffer(redisEntryKey(cacheKey));
    if (stored) {
      const entry = deserializeEntry(stored);
      if (!isExpired(entry) && !isSoftTagStale(entry, softTags) && !isTagStale(entry, entry.tags)) {
        return entry;
      }
    }

    const lockExists = await redis.exists(redisLockKey(cacheKey));
    if (!lockExists) {
      break;
    }
  }

  return undefined;
}

/**
 * Próbuje przejąć lock single-flight (SET NX z TTL). Wartość locka = instanceId,
 * dzięki czemu releaseRenderLock może zweryfikować właściciela.
 *
 * @param {import("ioredis").Redis} redis
 * @param {string} cacheKey - Surowy klucz cache z Next.js.
 * @returns {Promise<boolean>} true = lock przejęty, ta instancja renderuje.
 */
async function tryAcquireRenderLock(redis, cacheKey) {
  const result = await redis.set(redisLockKey(cacheKey), instanceId, "EX", LOCK_TTL_SECONDS, "NX");
  return result === "OK";
}

/**
 * Zwalnia lock TYLKO jeśli nadal należy do tej instancji (atomowy compare-and-delete w Lua).
 * Bez tego render dłuższy niż LOCK_TTL_SECONDS kasowałby lock przejęty już przez inną instancję.
 *
 * @param {import("ioredis").Redis} redis
 * @param {string} cacheKey - Surowy klucz cache z Next.js.
 * @returns {Promise<void>}
 */
async function releaseRenderLock(redis, cacheKey) {
  try {
    await redis.eval(RELEASE_LOCK_SCRIPT, 1, redisLockKey(cacheKey), instanceId);
  } catch {
    // lock may have expired
  }
}

export default {
  /**
   * Odczyt wpisu: L1 (LRU) → L2 (Redis) → single-flight (czekanie na inną instancję
   * lub przejęcie locka i zwrot undefined, żeby Next.js wyrenderował i zawołał set()).
   *
   * @param {string} cacheKey - Klucz cache z Next.js.
   * @param {string[]} softTags - Soft tagi ścieżki (revalidatePath).
   * @returns {Promise<object | undefined>} Wpis cache albo undefined (miss).
   */
  async get(cacheKey, softTags) {
    await setupSubscriber();

    const entryKey = redisEntryKey(cacheKey);

    const pendingPromise = pendingSets.get(cacheKey);
    if (pendingPromise) {
      await pendingPromise;
    }

    const lruEntry = lru.get(entryKey);
    if (
      lruEntry &&
      !isExpired(lruEntry) &&
      !isSoftTagStale(lruEntry, softTags) &&
      !isTagStale(lruEntry, lruEntry.tags)
    ) {
      return cloneEntryForReturn(lruEntry);
    }

    try {
      const redis = await getRedis();
      if (!redis) {
        return undefined;
      }

      const stored = await redis.getBuffer(entryKey);
      if (stored) {
        const entry = deserializeEntry(stored);
        if (!isExpired(entry) && !isSoftTagStale(entry, softTags) && !isTagStale(entry, entry.tags)) {
          lru.set(entryKey, entry);
          return cloneEntryForReturn(entry);
        }
      }

      const lockHeld = await redis.exists(redisLockKey(cacheKey));
      if (lockHeld) {
        const waitedEntry = await waitForRemoteEntry(redis, cacheKey, softTags);
        if (waitedEntry) {
          lru.set(entryKey, waitedEntry);
          return cloneEntryForReturn(waitedEntry);
        }
      }

      const acquired = await tryAcquireRenderLock(redis, cacheKey);
      if (!acquired) {
        const waitedEntry = await waitForRemoteEntry(redis, cacheKey, softTags);
        if (waitedEntry) {
          lru.set(entryKey, waitedEntry);
          return cloneEntryForReturn(waitedEntry);
        }
      }

      return undefined;
    } catch (err) {
      console.error("[remote-cache-handler] get error:", err.message);
      return undefined;
    }
  },

  /**
   * Zapis wpisu: LRU + Redis (pipeline: payload z TTL, sadd do indeksów tagów,
   * przedłużenie TTL indeksów). Na końcu zwalnia lock single-flight tej instancji.
   *
   * @param {string} cacheKey - Klucz cache z Next.js.
   * @param {Promise<object>} pendingEntry - Wpis (value jako ReadableStream).
   * @returns {Promise<void>}
   */
  async set(cacheKey, pendingEntry) {
    let resolvePending;
    const pendingPromise = new Promise((resolve) => {
      resolvePending = resolve;
    });
    pendingSets.set(cacheKey, pendingPromise);

    const redis = await getRedis();
    const entryKey = redisEntryKey(cacheKey);

    try {
      const entry = await pendingEntry;
      const buffer = await readStreamToBuffer(entry.value);

      const storedEntry = {
        ...entry,
        _buffer: buffer,
        _size: buffer.length,
      };

      lru.set(entryKey, storedEntry);

      if (!redis) {
        return;
      }

      const ttl = Math.max(entry.expire, 60);
      const pipeline = redis.multi();

      pipeline.set(entryKey, serializeEntry(entry, buffer), "EX", ttl);

      for (const tag of entry.tags) {
        pipeline.sadd(redisIndexKey(tag), entryKey);
        // Indeks żyje co najmniej tak długo jak najtrwalszy wpis + margines; bez TTL
        // akumulowałby martwe membery po naturalnym wygaśnięciu wpisów.
        // NX = ustaw TTL, gdy klucz go nie ma (GT pomija klucze bez TTL — traktuje je
        // jako nieskończone); GT = przedłuż tylko w górę, krótszy wpis nie skróci życia.
        pipeline.expire(redisIndexKey(tag), ttl + 60, "NX");
        pipeline.expire(redisIndexKey(tag), ttl + 60, "GT");
      }

      await pipeline.exec();
    } catch (err) {
      console.error("[remote-cache-handler] set error:", err.message);
    } finally {
      if (redis) {
        await releaseRenderLock(redis, cacheKey);
      }
      resolvePending();
      pendingSets.delete(cacheKey);
    }
  },

  /**
   * Synchronizuje lokalne timestampy invalidacji z Redis — wołane przez Next.js przed
   * obsługą requestu. Backstop dla instancji, które przegapiły Pub/Sub.
   *
   * Przy okazji przycina metadane: tagi, których meta:revalidated-at:* wygasł (TTL),
   * są usuwane z meta:revalidated-tags i z lokalnej mapy — set i mapa nie rosną wiecznie.
   *
   * @returns {Promise<void>}
   */
  async refreshTags() {
    try {
      const redis = await getRedis();
      if (!redis) {
        return;
      }

      const tagKeys = await redis.smembers(REVALIDATED_TAGS_SET);
      if (tagKeys.length === 0) {
        return;
      }

      const values = await redis.mget(tagKeys.map((tag) => redisRevalidatedAtKey(tag)));
      const expiredTags = [];

      for (let i = 0; i < tagKeys.length; i++) {
        if (values[i]) {
          localTagTimestamps.set(tagKeys[i], Number(values[i]));
        } else {
          expiredTags.push(tagKeys[i]);
        }
      }

      if (expiredTags.length > 0) {
        for (const tag of expiredTags) {
          localTagTimestamps.delete(tag);
        }
        await redis.srem(REVALIDATED_TAGS_SET, ...expiredTags);
      }
    } catch (err) {
      console.error("[remote-cache-handler] refreshTags error:", err.message);
    }
  },

  /**
   * Zwraca najpóźniejszy znany timestamp invalidacji dla podanych tagów
   * (Next.js porównuje go z timestampem wpisu).
   *
   * @param {string[]} tags
   * @returns {Promise<number>} Timestamp w ms (0 = nigdy nie invalidowane).
   */
  async getExpiration(tags) {
    const timestamps = tags.map((tag) => localTagTimestamps.get(tag) ?? 0);
    return Math.max(...timestamps, 0);
  },

  /**
   * Invalidacja tagów (updateTag / revalidateTag):
   * 1. Lokalnie: timestampy + czyszczenie L1.
   * 2. Redis (pipeline): timestamp invalidacji z TTL, rejestr tagów, kasowanie indeksów
   *    i wszystkich wpisów z indeksów.
   * 3. Pub/Sub: pozostałe instancje czyszczą swoje L1.
   *
   * @param {string[]} tags - Tagi do invalidacji.
   * @param {object} durations - Profile czasowe z Next.js (nieużywane — kasujemy twardo).
   * @returns {Promise<void>}
   */
  async updateTags(tags, durations) {
    const now = Date.now();

    for (const tag of tags) {
      localTagTimestamps.set(tag, now);
    }

    invalidateLruByTags(tags);

    try {
      const redis = await getRedis();
      if (!redis) {
        await publishInvalidation({ tags });
        return;
      }

      const keysToDelete = new Set();

      for (const tag of tags) {
        const keys = await redis.smembers(redisIndexKey(tag));
        for (const key of keys) {
          keysToDelete.add(key);
          lru.delete(key);
        }
      }

      const pipeline = redis.multi();

      for (const tag of tags) {
        // TTL na meta — timestamp starszy niż najdłuższe życie wpisu nie ma czego
        // unieważniać; bez TTL meta-klucze akumulowałyby się w nieskończoność.
        pipeline.set(redisRevalidatedAtKey(tag), String(now), "EX", TAG_META_TTL_SECONDS);
        pipeline.sadd(REVALIDATED_TAGS_SET, tag);
        pipeline.del(redisIndexKey(tag));
      }

      for (const key of keysToDelete) {
        pipeline.del(key);
      }

      await pipeline.exec();
      await publishInvalidation({ tags, keys: [...keysToDelete] });
    } catch (err) {
      console.error("[remote-cache-handler] updateTags error:", err.message);
    }
  },
};
