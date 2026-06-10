const { LRUCache } = require("lru-cache");
const { createClient } = require("redis");

const REDIS_KEY_PREFIX = "next-cache:";
const TAG_KEY_PREFIX = "tag:";
const REVALIDATED_TAGS_SET = "revalidated-tags";
const CACHE_TAG_INDEX_PREFIX = "cache-tag:";
const LOCK_PREFIX = "cache-lock:";
const INVALIDATE_CHANNEL = "cache:invalidate";

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

async function getRedis() {
  if (isBuildPhase || !process.env.REDIS_URL) {
    return null;
  }

  if (Date.now() < redisUnavailableUntil) {
    return null;
  }

  if (redisClient?.isOpen) {
    return redisClient;
  }

  if (!redisConnecting) {
    redisConnecting = (async () => {
      const client = createClient({ url: process.env.REDIS_URL });
      client.on("error", (err) => {
        if (err.message) {
          console.warn("[remote-cache-handler] Redis error:", err.message);
        }
      });
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
  if (isBuildPhase || !process.env.REDIS_URL || redisSubClient?.isOpen) {
    return;
  }

  if (!redisSubConnecting) {
    redisSubConnecting = (async () => {
      const client = createClient({ url: process.env.REDIS_URL });
      client.on("error", (err) => {
        if (err.message) {
          console.warn("[remote-cache-handler] Redis sub error:", err.message);
        }
      });
      await client.connect();
      await client.subscribe(INVALIDATE_CHANNEL, (message) => {
        try {
          const payload = JSON.parse(message);
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
    await redis.publish(INVALIDATE_CHANNEL, JSON.stringify(payload));
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
  const parsed = JSON.parse(raw);
  const buffer = Buffer.from(parsed.value, "base64");

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
  return JSON.stringify({
    value: buffer.toString("base64"),
    tags: entry.tags,
    stale: entry.stale,
    timestamp: entry.timestamp,
    expire: entry.expire,
    revalidate: entry.revalidate,
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

    const stored = await redis.get(REDIS_KEY_PREFIX + cacheKey);
    if (stored) {
      const entry = deserializeEntry(stored);
      if (!isExpired(entry) && !isSoftTagStale(entry, softTags) && !isTagStale(entry, entry.tags)) {
        return entry;
      }
    }

    const lockExists = await redis.exists(LOCK_PREFIX + cacheKey);
    if (!lockExists) {
      break;
    }
  }

  return undefined;
}

async function tryAcquireRenderLock(redis, cacheKey) {
  const result = await redis.set(LOCK_PREFIX + cacheKey, instanceId, {
    NX: true,
    EX: LOCK_TTL_SECONDS,
  });
  return result === "OK";
}

async function releaseRenderLock(redis, cacheKey) {
  try {
    await redis.del(LOCK_PREFIX + cacheKey);
  } catch {
    // lock may have expired
  }
}

module.exports = {
  async get(cacheKey, softTags) {
    await setupSubscriber();

    const pendingPromise = pendingSets.get(cacheKey);
    if (pendingPromise) {
      await pendingPromise;
    }

    const lruEntry = lru.get(cacheKey);
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

      const stored = await redis.get(REDIS_KEY_PREFIX + cacheKey);
      if (stored) {
        const entry = deserializeEntry(stored);
        if (!isExpired(entry) && !isSoftTagStale(entry, softTags) && !isTagStale(entry, entry.tags)) {
          lru.set(cacheKey, entry);
          return cloneEntryForReturn(entry);
        }
      }

      const lockHeld = await redis.exists(LOCK_PREFIX + cacheKey);
      if (lockHeld) {
        const waitedEntry = await waitForRemoteEntry(redis, cacheKey, softTags);
        if (waitedEntry) {
          lru.set(cacheKey, waitedEntry);
          return cloneEntryForReturn(waitedEntry);
        }
      }

      const acquired = await tryAcquireRenderLock(redis, cacheKey);
      if (!acquired) {
        const waitedEntry = await waitForRemoteEntry(redis, cacheKey, softTags);
        if (waitedEntry) {
          lru.set(cacheKey, waitedEntry);
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

    try {
      const entry = await pendingEntry;
      const buffer = await readStreamToBuffer(entry.value);

      const storedEntry = {
        ...entry,
        _buffer: buffer,
        _size: buffer.length,
      };

      lru.set(cacheKey, storedEntry);

      if (!redis) {
        return;
      }

      const ttl = Math.max(entry.expire, 60);
      const pipeline = redis.multi();

      pipeline.set(REDIS_KEY_PREFIX + cacheKey, serializeEntry(entry, buffer), { EX: ttl });

      for (const tag of entry.tags) {
        pipeline.sAdd(CACHE_TAG_INDEX_PREFIX + tag, cacheKey);
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

      const tagKeys = await redis.sMembers(REVALIDATED_TAGS_SET);
      if (tagKeys.length === 0) {
        return;
      }

      const values = await redis.mGet(tagKeys.map((tag) => TAG_KEY_PREFIX + tag));
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
        const keys = await redis.sMembers(CACHE_TAG_INDEX_PREFIX + tag);
        for (const key of keys) {
          keysToDelete.add(key);
          lru.delete(key);
        }
      }

      const pipeline = redis.multi();

      for (const tag of tags) {
        pipeline.set(TAG_KEY_PREFIX + tag, String(now));
        pipeline.sAdd(REVALIDATED_TAGS_SET, tag);
        pipeline.del(CACHE_TAG_INDEX_PREFIX + tag);
      }

      for (const key of keysToDelete) {
        pipeline.del(REDIS_KEY_PREFIX + key);
      }

      await pipeline.exec();
      await publishInvalidation({ tags, keys: [...keysToDelete] });
    } catch (err) {
      console.error("[remote-cache-handler] updateTags error:", err.message);
    }
  },
};
