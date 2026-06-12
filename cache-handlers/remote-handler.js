const v8 = require("v8");
const { LRUCache } = require("lru-cache");
const Redis = require("ioredis");

/**
 * Schemat kluczy Redis (Redis Insight grupuje po ":"):
 *
 * {cacheKey z ; zamiast :}            — payload; klucz Next.js, ":" → ";" (JSON nie rozbija drzewa)
 * lock:{cacheKey z ;}                 — single-flight lock (tymczasowy)
 * index:data:cache-lab:pl:pl          — SET cacheKey (zakodowanych); drzewo index:data / index:ui
 * meta:revalidated-at:data:cache-lab:pl:pl — timestamp invalidacji tagu
 * meta:revalidated-tags               — SET nazw tagów
 */
const REVALIDATED_TAGS_SET = "meta:revalidated-tags";
const INVALIDATE_CHANNEL = "pubsub:invalidate";

/**
 * cacheKey Next.js to JSON z ":" w środku (np. {"country":"us"}). Redis Insight rozbija
 * klucze po ":", więc surowy cacheKey rozpadałby się na śmieciowe gałęzie. Zamieniamy ":"
 * na ";", żeby cały cacheKey był jednym czytelnym kluczem. Tagi (index / meta) są budowane
 * z osobnych stringów ("data:posts:pl:pl") i pozostają nietknięte.
 */
function encodeCacheKey(cacheKey) {
  return cacheKey.replace(/:/g, ";");
}

/** Kanoniczny identyfikator wpisu — używany jako klucz Redis, klucz LRU i member w index SET */
function redisEntryKey(cacheKey) {
  return encodeCacheKey(cacheKey);
}

function redisLockKey(cacheKey) {
  return `lock:${encodeCacheKey(cacheKey)}`;
}

/** tag = "data:posts:pl:pl" → "meta:revalidated-at:data:posts:pl:pl" */
function redisRevalidatedAtKey(tag) {
  return `meta:revalidated-at:${tag}`;
}

/** tag = "data:posts:pl:pl" → "index:data:posts:pl:pl" (drzewo index:data / index:ui) */
function redisIndexKey(tag) {
  return `index:${tag}`;
}

function parseTagsMeta(tags) {
  const primary = tags?.find((t) => t.includes(":") && t.split(":").length >= 4) ?? tags?.[0] ?? "";
  const parts = primary.split(":");

  return {
    layer: parts[0] === "data" || parts[0] === "ui" ? parts[0] : "unknown",
    resource: parts[1] ?? "unknown",
    locale: parts.length >= 4 ? `${parts[2]}/${parts[3]}` : "global",
  };
}

const LOCK_TTL_SECONDS = 30;
const SINGLE_FLIGHT_POLL_MS = 100;
const SINGLE_FLIGHT_MAX_ATTEMPTS = 50;

const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";
const instanceId = `pid-${process.pid}`;

/** L1: in-process LRU — krótki TTL, invalidowany przez Pub/Sub */
const lru = new LRUCache({
  max: 500,
  maxSize: 50 * 1024 * 1024,
  sizeCalculation: (entry) => entry._size ?? 1024,
  ttl: 15_000,
});

const pendingSets = new Map();
const localTagTimestamps = new Map();

let redisClient = null;
let redisSubClient = null;
let redisConnecting = null;
let redisSubConnecting = null;
let redisUnavailableUntil = 0;

/**
 * lazyConnect — łączymy ręcznie przez connect(), żeby kontrolować fallback na LRU.
 * enableOfflineQueue:false — komendy bez połączenia od razu rzucają błąd zamiast wisieć w kolejce.
 * retryStrategy — kilka prób, potem rezygnacja (handler i tak ma 30s cooldown na LRU).
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
  return client;
}

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

function isExpired(entry) {
  return Date.now() > entry.timestamp + entry.revalidate * 1000;
}

function isSoftTagStale(entry, softTags) {
  for (const tag of softTags) {
    const tagTs = localTagTimestamps.get(tag) ?? 0;
    if (tagTs > entry.timestamp) {
      return true;
    }
  }
  return false;
}

function isTagStale(entry, tags) {
  for (const tag of tags) {
    const tagTs = localTagTimestamps.get(tag) ?? 0;
    if (tagTs > entry.timestamp) {
      return true;
    }
  }
  return false;
}

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

function bufferToStream(buffer) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(buffer);
      controller.close();
    },
  });
}

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

async function tryAcquireRenderLock(redis, cacheKey) {
  const result = await redis.set(redisLockKey(cacheKey), instanceId, "EX", LOCK_TTL_SECONDS, "NX");
  return result === "OK";
}

async function releaseRenderLock(redis, cacheKey) {
  try {
    await redis.del(redisLockKey(cacheKey));
  } catch {
    // lock may have expired
  }
}

module.exports = {
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
      for (let i = 0; i < tagKeys.length; i++) {
        if (values[i]) {
          localTagTimestamps.set(tagKeys[i], Number(values[i]));
        }
      }
    } catch (err) {
      console.error("[remote-cache-handler] refreshTags error:", err.message);
    }
  },

  async getExpiration(tags) {
    const timestamps = tags.map((tag) => localTagTimestamps.get(tag) ?? 0);
    return Math.max(...timestamps, 0);
  },

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
        pipeline.set(redisRevalidatedAtKey(tag), String(now));
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
