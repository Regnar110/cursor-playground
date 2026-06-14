import v8 from "node:v8";
import crypto from "node:crypto";
import { LRUCache } from "lru-cache";
import Redis from "ioredis";
import * as cacheDebug from "./cache-debug.mjs";

/**
 * Remote cache handler for Next.js 16 (`use cache: remote`).
 *
 * Architecture:
 * - L1: in-process LRU cache with short TTL — limits round-trips to Redis on hot load
 * - L2: Redis — shared across Next.js application instances
 * - Pub/Sub — invalidates L1 cache entries across all instances on invalidation
 * - Single-flight lock — on cache MISS only one instance renders, rest wait for result
 * - Tag timestamps (meta:revalidated-at:*) — persistent backstop when an instance
 *   misses a Pub/Sub message (no connection, Redis restart, etc.)
 *
 * Redis key layout (Redis Insight groups by ":"):
 *
 * {cacheKey with ; not :}                   — payload; Next.js key with ":" → ";"
 * lock:{cacheKey with ;}                    — single-flight lock (temporary, owner-checked)
 * index:data:posts:pl:pl                    — SET of encoded cache keys; index:data / index:ui tree
 * meta:revalidated-at:data:posts:pl:pl      — tag invalidation timestamp (TTL = TAG_META_TTL_SECONDS)
 * meta:revalidated-tags                     — SET of tag names (trimmed in refreshTags)
 */
const REVALIDATED_TAGS_SET = "meta:revalidated-tags";
const INVALIDATE_CHANNEL = "pubsub:invalidate";

/** @param {string} name @param {number} fallback */
function envInt(name, fallback) {
  const parsed = parseInt(process.env[name], 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** TTL single-flight lock; render longer than this window loses the lock (see releaseRenderLock). */
const LOCK_TTL_SECONDS = envInt("SINGLE_FLIGHT_LOCK_TTL", 30);
/** Interval between Redis polls while waiting for another instance's result. */
const SINGLE_FLIGHT_POLL_MS = envInt("SINGLE_FLIGHT_POLLING_MS", 100);
/** Max single-flight poll attempts (~5 s at defaults: 50 × 100 ms). */
const SINGLE_FLIGHT_MAX_ATTEMPTS = envInt("SINGLE_FLIGHT_ATTEMPTS", 50);

/**
 * Invalidation metadata TTL (meta:revalidated-at:*).
 *
 * The tag timestamp is a backstop for entries saved before invalidation that were not
 * deleted (write race, offline instance at updateTags). Such entries expire on their
 * own TTL anyway, so a timestamp older than the longest reasonable entry lifetime has
 * nothing left to invalidate — it can safely disappear. Prevents meta-keys from growing forever.
 */
const TAG_META_TTL_SECONDS = envInt("TAG_META_TTL_SECONDS", 7 * 24 * 60 * 60);

/**
 * Next.js cacheKey is JSON with ":" inside (e.g. {"country":"pl"}). Redis Insight splits
 * keys by ":", so a raw cacheKey falls apart into garbage tag trees. Colons are replaced
 * with ";" to keep the cacheKey as one readable key. Tags (index/meta) are built from
 * separate strings ("data:posts:pl:pl") and stay intact.
 *
 * @param {string} cacheKey - Raw key from Next.js.
 * @returns {string} Key with ";" instead of ":".
 */
function encodeCacheKey(cacheKey) {
  return cacheKey.replace(/:/g, ";");
}

/**
 * Canonical entry identifier — Redis key, LRU key, and member inside index SET (1:1).
 *
 * @param {string} cacheKey - Raw Next.js cache key.
 * @returns {string} Redis entry key.
 */
function redisEntryKey(cacheKey) {
  return encodeCacheKey(cacheKey);
}

/**
 * Single-flight lock key for one entry.
 *
 * @param {string} cacheKey - Raw Next.js cache key.
 * @returns {string} Redis lock key.
 */
function redisLockKey(cacheKey) {
  return `lock:${encodeCacheKey(cacheKey)}`;
}

/**
 * Tag invalidation timestamp key.
 * tag = data:posts:pl:pl → meta:revalidated-at:data:posts:pl:pl
 *
 * @param {string} tag - Application tag (data:* / ui:*).
 * @returns {string} Redis meta key.
 */
function redisRevalidatedAtKey(tag) {
  return `meta:revalidated-at:${tag}`;
}

/**
 * Tag index key.
 * tag = "data:posts:pl:pl" → "index:data:posts:pl:pl" (index:data / index:ui tree)
 *
 * @param {string} tag - Application tag (data:* / ui:*).
 * @returns {string} Redis index key.
 */
function redisIndexKey(tag) {
  return `index:${tag}`;
}

/**
 * Extracts metadata (layer / resource / locale) from entry tags for the `_meta` field
 * in the payload — easier debugging in Redis Insight.
 *
 * @param {string[]} tags - Cache entry tags.
 * @returns {{layer: string, resource: string, locale: string}} Descriptive metadata.
 */
function parseTagsMeta(tags) {
  const primary =
    tags?.find((t) => t.includes(":") && t.split(":").length >= 4) ?? tags?.[0] ?? "";
  const parts = primary.split(":");

  return {
    layer: parts[0] === "data" || parts[0] === "ui" ? parts[0] : "unknown",
    resource: parts[1] ?? "unknown",
    locale: parts.length >= 4 ? `${parts[2]}/${parts[3]}` : "global",
  };
}

/** Build phase — no Redis during `next build`. */
const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

/**
 * Unique instance identifier — value of lock:* for single-flight.
 * PID alone is not enough — different hosts can share the same PID.
 */
const instanceId = `pid-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;

/** Container id (Docker HOSTNAME) — shared debug namespace for all Node workers. */
const DEBUG_BOX = process.env.HOSTNAME?.trim() || `local-${process.pid}`;

cacheDebug.setDebugContext({ instanceId, debugBox: DEBUG_BOX });

/**
 * Compare-and-delete lock: remove lock:* ONLY if still owned by this instance.
 * Protects against: instance A renders > LOCK_TTL_SECONDS → lock expires → instance B
 * acquires lock → A finishes and would delete B's lock without this check.
 */
const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

/** L1: in-process LRU — short TTL, invalidated via Pub/Sub */
const lru = new LRUCache({
  max: envInt("REMOTE_CACHE_LRU_MAX_ENTRIES", 500),
  maxSize: envInt("REMOTE_CACHE_LRU_MAX_SIZE_MB", 50) * 1024 * 1024,
  sizeCalculation: (entry) =>
    entry._size ?? envInt("REMOTE_CACHE_LRU_DEFAULT_ENTRY_SIZE_BYTES", 1024),
  ttl: envInt("REMOTE_CACHE_LRU_TTL_MS", 15_000),
});

/** In-flight writes (cacheKey → Promise) — get() waits for set() on the same key. */
const pendingSets = new Map();

/**
 * Local copy of invalidation timestamps (tag → ms). Synced with Redis in refreshTags().
 * Trimmed when meta:revalidated-at:{tag} expires — the map does not grow forever.
 */
const localTagTimestamps = new Map();

let redisClient = null;
let redisSubClient = null;
let redisConnecting = null;
let redisSubConnecting = null;
let redisUnavailableUntil = 0;

function redisStatusSnapshot() {
  const cooldownMs =
    redisUnavailableUntil > Date.now() ? redisUnavailableUntil - Date.now() : null;
  let status = "disabled";
  if (isBuildPhase || !process.env.REDIS_HOST) {
    status = "disabled";
  } else if (cooldownMs) {
    status = "cooldown (LRU only)";
  } else if (redisClient?.status === "ready") {
    status = "connected";
  } else if (redisConnecting) {
    status = "connecting";
  } else {
    status = "disconnected";
  }
  return {
    status,
    cooldownMs,
    pubSubReady: redisSubClient?.status === "ready",
  };
}

/** @param {object} entry @param {string} entryKey @param {string[]} [softTags] */
function debugEntryFields(entry, entryKey, softTags = []) {
  const tagList = entry.tags ?? [];
  const cacheLayer = cacheDebug.classifyCacheLayer(tagList, softTags);
  return {
    key: entryKey,
    tags: cacheDebug.formatTags(tagList),
    ...(cacheLayer ? { cacheLayer } : {}),
    age: cacheDebug.formatAge(Date.now() - entry.timestamp),
    created: cacheDebug.formatTime(entry.timestamp),
    sizeBytes: entry._size ?? 0,
  };
}

/**
 * @param {string} entryKey
 * @param {object} entry
 */
async function syncL1EntryToRedis(entryKey, entry) {
  if (!cacheDebug.isDebugEnabled()) return;
  const redis = await getRedis();
  if (!redis) return;
  const payload = JSON.stringify({
    key: entryKey,
    tags: entry.tags ?? [],
    timestamp: entry.timestamp,
    size: entry._size ?? 0,
    instanceId,
    cacheLayer: cacheDebug.classifyCacheLayer(entry.tags ?? []),
  });
  await redis.hset(cacheDebug.debugL1Key(DEBUG_BOX), entryKey, payload);
  await redis.expire(cacheDebug.debugL1Key(DEBUG_BOX), cacheDebug.DEBUG_REDIS_TTL_SECONDS);
}

/** @param {string} entryKey */
async function syncL1RemoveFromRedis(entryKey) {
  if (!cacheDebug.isDebugEnabled()) return;
  const redis = await getRedis();
  if (!redis) return;
  await redis.hdel(cacheDebug.debugL1Key(DEBUG_BOX), entryKey);
}

/** @param {string} entryKey @param {object} entry */
function lruSetAndSync(entryKey, entry) {
  lru.set(entryKey, entry);
  void syncL1EntryToRedis(entryKey, entry).catch(() => {});
}

/** @param {string} entryKey */
function lruDeleteAndSync(entryKey) {
  lru.delete(entryKey);
  void syncL1RemoveFromRedis(entryKey).catch(() => {});
}

/** @param {string} entryKey @param {{ cacheLayer?: string | null }} meta */
function trackRenderLock(entryKey, meta = {}) {
  cacheDebug.trackPendingLock(entryKey, meta);
  void syncPendingLockToRedis(entryKey, meta).catch(() => {});
}

/** @param {string} entryKey */
function clearRenderLock(entryKey) {
  cacheDebug.clearPendingLock(entryKey);
  void syncPendingLockRemoveFromRedis(entryKey).catch(() => {});
}

async function syncPendingLockToRedis(entryKey, meta) {
  if (!cacheDebug.isDebugEnabled()) return;
  const redis = await getRedis();
  if (!redis) return;
  const payload = JSON.stringify({
    key: entryKey,
    acquiredAt: Date.now(),
    instanceId: meta.instanceId ?? instanceId,
    cacheLayer: meta.cacheLayer ?? null,
  });
  await redis.hset(cacheDebug.debugPendingKey(DEBUG_BOX), entryKey, payload);
  await redis.expire(cacheDebug.debugPendingKey(DEBUG_BOX), cacheDebug.DEBUG_REDIS_TTL_SECONDS);
}

/** @param {string} entryKey */
async function syncPendingLockRemoveFromRedis(entryKey) {
  if (!cacheDebug.isDebugEnabled()) return;
  const redis = await getRedis();
  if (!redis) return;
  await redis.hdel(cacheDebug.debugPendingKey(DEBUG_BOX), entryKey);
}

cacheDebug.registerSnapshotProvider(() => {
  const now = Date.now();
  /** @type {{ key: string; tags: string[]; ageMs: number; size: number; createdAt: string }[]} */
  const l1Entries = [];
  lru.forEach((entry, key) => {
    l1Entries.push({
      key,
      tags: entry.tags ?? [],
      ageMs: now - entry.timestamp,
      size: entry._size ?? 0,
      createdAt: cacheDebug.formatTime(entry.timestamp),
    });
  });
  l1Entries.sort((a, b) => b.ageMs - a.ageMs);

  const tagTimestamps = [...localTagTimestamps.entries()]
    .map(([tag, invalidatedAt]) => ({
      tag,
      invalidatedAt,
      ageMs: now - invalidatedAt,
    }))
    .sort((a, b) => b.invalidatedAt - a.invalidatedAt);

  return {
    instanceId,
    redis: redisStatusSnapshot(),
    l1: {
      size: lru.size,
      max: lru.max,
      calculatedSize: lru.calculatedSize ?? 0,
      maxSize: lru.maxSize ?? 0,
      ttlMs: lru.ttl ?? 0,
    },
    l1Entries,
    tagTimestamps,
    pendingSets: pendingSets.size,
  };
});

/**
 * Builds ioredis client options from REDIS_* env vars.
 *
 * @returns {import("ioredis").RedisOptions | null} null when REDIS_HOST is not set.
 */
function redisOptions() {
  if (!process.env.REDIS_HOST) {
    return null;
  }

  const options = {
    host: process.env.REDIS_HOST,
    port: envInt("REDIS_PORT", 6379),
    db: envInt("REDIS_DB", 0),
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => (times > 5 ? null : Math.min(times * 200, 2000)),
  };

  if (process.env.REDIS_PASSWORD) {
    options.password = process.env.REDIS_PASSWORD;
  }

  return options;
}

/**
 * Creates an ioredis client tuned for fast LRU fallback:
 * - lazyConnect — manual connect() to control fallback
 * - enableOfflineQueue:false — commands fail immediately without a connection
 * - retryStrategy — a few attempts, then give up (30 s cooldown on LRU-only mode)
 *
 * @returns {import("ioredis").Redis} Unconnected client (status "wait").
 */
function createRedis() {
  const options = redisOptions();
  if (!options) {
    throw new Error("REDIS_HOST is not configured");
  }

  const client = new Redis(options);
  client.on("error", (err) => {
    if (err?.message) {
      console.warn("[remote-cache-handler] Redis error:", err.message);
    }
  });
  // After retryStrategy is exhausted (~5 s outage), ioredis emits "end" and the client
  // is dead forever. Reset refs so the next request builds a fresh connection.
  client.on("end", () => {
    if (redisClient === client) {
      redisClient = null;
      redisConnecting = null;
      redisUnavailableUntil = Date.now() + 30_000;
      console.warn("[remote-cache-handler] Redis connection ended — LRU only, reconnect after 30s");
      cacheDebug.log(
        "REDIS",
        "END",
        "Main Redis connection died — handler switches to LRU-only for 30 s, then reconnects",
        { role: "main" },
      );
    }
    if (redisSubClient === client) {
      redisSubClient = null;
      redisSubConnecting = null;
      console.warn("[remote-cache-handler] Pub/Sub connection ended — will re-subscribe");
      cacheDebug.log(
        "REDIS",
        "END",
        "Pub/Sub connection died — will re-subscribe on next cached request",
        { role: "pubsub" },
      );
    }
  });
  return client;
}

/**
 * Returns shared Redis client or null (build phase, no REDIS_HOST, or cooldown after failure).
 * null === handler works on LRU only.
 *
 * @returns {Promise<import("ioredis").Redis | null>}
 */
async function getRedis() {
  if (isBuildPhase || !process.env.REDIS_HOST) {
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

cacheDebug.registerRedisSync(async (event) => {
  const redis = await getRedis();
  if (!redis) return;
  const listKey = cacheDebug.debugEventsKey(DEBUG_BOX);
  await redis.rpush(listKey, JSON.stringify(event));
  await redis.ltrim(listKey, -cacheDebug.DEBUG_EVENTS_LIST_MAX, -1);
  await redis.expire(listKey, cacheDebug.DEBUG_REDIS_TTL_SECONDS);
});

/**
 * Starts Pub/Sub subscriber (once) that clears L1 after invalidations from other instances.
 * Requires a separate connection — a subscriber client cannot run other commands.
 *
 * @returns {Promise<void>}
 */
async function setupSubscriber() {
  if (isBuildPhase || !process.env.REDIS_HOST || (redisSubClient && redisSubClient.status === "ready")) {
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
            const before = lru.size;
            invalidateLruByTags(payload.tags);
            cacheDebug.log(
              "PUBSUB",
              "CLEAR",
              `Pub/Sub invalidation cleared L1 entries tagged ${cacheDebug.formatTags(payload.tags)}`,
              {
                tags: payload.tags,
                l1Before: before,
                l1After: lru.size,
                keys: payload.keys?.length ? payload.keys : [],
              },
            );
          }
          if (payload.keys?.length) {
            for (const key of payload.keys) {
              lruDeleteAndSync(key);
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
 * Broadcasts invalidation to other instances (clear their L1).
 *
 * @param {{tags?: string[], keys?: string[]}} payload - Tags and/or entry keys to remove from LRU.
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
 * Whether the entry exceeded its revalidate window (hard miss).
 *
 * @param {{timestamp: number, revalidate: number}} entry
 * @returns {boolean}
 */
function isExpired(entry) {
  return Date.now() > entry.timestamp + entry.revalidate * 1000;
}

/**
 * Whether the entry is stale relative to soft path tags (revalidatePath).
 *
 * @param {{timestamp: number}} entry
 * @param {string[]} softTags - Soft tags passed by Next.js to get().
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
 * Whether the entry is stale relative to its own tags (updateTag / revalidateTag).
 *
 * @param {{timestamp: number}} entry
 * @param {string[]} tags - Entry tags.
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
 * Reads entire ReadableStream into one Buffer (entry payload before writing to Redis).
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
 * Wraps a Buffer in a one-shot ReadableStream (return format required by Next.js).
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
 * Deserializes a Redis entry (v8 binary) into a Next.js structure.
 * `_buffer`/`_size` are internal (LRU + cloneEntryForReturn) and are not passed to Next.js.
 *
 * @param {Buffer} raw - Raw bytes from redis.getBuffer().
 * @returns {object} Cache entry with value as ReadableStream.
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
 * Serializes entry to v8 binary with `_meta` (layer/resource/locale/tags/createdAt)
 * for easier inspection in Redis Insight.
 *
 * Production note: v8.serialize format is tied to Node version — all instances must
 * run the same runtime (one .next artifact assumes this).
 *
 * @param {object} entry - Cache entry from Next.js.
 * @param {Buffer} buffer - Gathered entry payload.
 * @returns {Buffer} Bytes to write to Redis.
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
 * Returns a copy of the entry with a fresh ReadableStream — streams are one-shot,
 * so each return to Next.js must get a new one.
 *
 * @param {object} entry - Entry with `_buffer` (from LRU or after deserialization).
 * @returns {object} Entry ready to return from get().
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
 * Removes from L1 all entries tagged with any of the given tags.
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
    lruDeleteAndSync(key);
  }
}

/**
 * Polls until the instance holding the lock writes the result to Redis.
 * Stops early when the lock disappears (render crashed or finished).
 *
 * @param {import("ioredis").Redis} redis
 * @param {string} cacheKey - Raw Next.js cache key.
 * @param {string[]} softTags
 * @returns {Promise<object | undefined>} Fresh entry or undefined (timeout / no result).
 */
async function waitForRemoteEntry(redis, cacheKey, softTags) {
  cacheDebug.log(
    "WAIT",
    "WAIT",
    "Another instance holds the render lock — polling Redis for the result",
    { key: redisEntryKey(cacheKey) },
  );

  for (let attempt = 0; attempt < SINGLE_FLIGHT_MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, SINGLE_FLIGHT_POLL_MS));

    const stored = await redis.getBuffer(redisEntryKey(cacheKey));
    if (stored) {
      const entry = deserializeEntry(stored);
      if (!isExpired(entry) && !isSoftTagStale(entry, softTags) && !isTagStale(entry, entry.tags)) {
        cacheDebug.log(
          "WAIT",
          "HIT",
          "Single-flight wait succeeded — using entry written by another instance",
          { ...debugEntryFields(entry, redisEntryKey(cacheKey)), attempt: attempt + 1 },
        );
        return entry;
      }
    }

    const lockExists = await redis.exists(redisLockKey(cacheKey));
    if (!lockExists) {
      cacheDebug.log(
        "WAIT",
        "MISS",
        "Lock disappeared but no valid entry appeared — stop waiting",
        { attempt: attempt + 1 },
      );
      break;
    }
  }

  cacheDebug.log("WAIT", "MISS", "Single-flight wait timed out — this instance may render");
  return undefined;
}

/**
 * Tries to acquire single-flight lock (SET NX with TTL). Lock value = instanceId
 * so releaseRenderLock can verify ownership.
 *
 * @param {import("ioredis").Redis} redis
 * @param {string} cacheKey - Raw Next.js cache key.
 * @returns {Promise<boolean>} true = lock acquired, this instance renders.
 */
async function tryAcquireRenderLock(redis, cacheKey) {
  const result = await redis.set(redisLockKey(cacheKey), instanceId, "EX", LOCK_TTL_SECONDS, "NX");
  return result === "OK";
}

/**
 * Releases lock ONLY if this instance still owns it (compare-and-delete).
 *
 * @param {import("ioredis").Redis} redis
 * @param {string} cacheKey - Raw Next.js cache key.
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
   * Read entry: L1 (LRU) → L2 (Redis) → single-flight (wait for another instance
   * or acquire lock and return undefined so Next.js renders and calls set()).
   *
   * @param {string} cacheKey - Cache key from Next.js.
   * @param {string[]} softTags - Soft path tags (revalidatePath).
   * @returns {Promise<object | undefined>} Cache entry or undefined (miss).
   */
  async get(cacheKey, softTags) {
    await setupSubscriber();

    const entryKey = redisEntryKey(cacheKey);

    const pendingPromise = pendingSets.get(cacheKey);
    if (pendingPromise) {
      await pendingPromise;
    }

    const lruEntry = lru.get(entryKey);
    if (lruEntry) {
      if (
        !isExpired(lruEntry) &&
        !isSoftTagStale(lruEntry, softTags) &&
        !isTagStale(lruEntry, lruEntry.tags)
      ) {
        cacheDebug.log(
          "GET",
          "HIT",
          "Returned fresh entry from L1 (in-process LRU)",
          { layer: "L1", ...debugEntryFields(lruEntry, entryKey, softTags) },
        );
        return cloneEntryForReturn(lruEntry);
      }

      cacheDebug.log(
        "GET",
        "STALE",
        "L1 entry rejected — " +
          cacheDebug.describeStaleReason(lruEntry, localTagTimestamps, softTags),
        { layer: "L1", ...debugEntryFields(lruEntry, entryKey, softTags) },
      );
    }

    try {
      const redis = await getRedis();
      if (!redis) {
        const cooldown = redisUnavailableUntil > Date.now();
        cacheDebug.log(
          "GET",
          "MISS",
          cooldown
            ? "Redis in cooldown after outage — miss (Next.js will render, L1-only until reconnect)"
            : "Redis unavailable or not configured — miss (Next.js will render)",
          { layer: cooldown ? "cooldown" : "none", key: entryKey },
        );
        return undefined;
      }

      const stored = await redis.getBuffer(entryKey);
      if (stored) {
        const entry = deserializeEntry(stored);
        if (
          !isExpired(entry) &&
          !isSoftTagStale(entry, softTags) &&
          !isTagStale(entry, entry.tags)
        ) {
          lruSetAndSync(entryKey, entry);
          cacheDebug.log(
            "GET",
            "HIT",
            "Returned fresh entry from L2 (Redis) and promoted to L1",
            { layer: "L2", ...debugEntryFields(entry, entryKey, softTags) },
          );
          return cloneEntryForReturn(entry);
        }

        cacheDebug.log(
          "GET",
          "STALE",
          "Redis entry rejected — " +
            cacheDebug.describeStaleReason(entry, localTagTimestamps, softTags),
          { layer: "L2", ...debugEntryFields(entry, entryKey, softTags) },
        );
      }

      const lockHeld = await redis.exists(redisLockKey(cacheKey));
      if (lockHeld) {
        const waitedEntry = await waitForRemoteEntry(redis, cacheKey, softTags);
        if (waitedEntry) {
          lruSetAndSync(entryKey, waitedEntry);
          return cloneEntryForReturn(waitedEntry);
        }
      }

      const acquired = await tryAcquireRenderLock(redis, cacheKey);
      if (acquired) {
        const cacheLayer = cacheDebug.classifyCacheLayer([], softTags);
        trackRenderLock(entryKey, { cacheLayer });
        cacheDebug.log(
          "GET",
          "ACQUIRED",
          "This instance acquired the render lock — Next.js will render and call set()",
          {
            key: entryKey,
            lockTtlSec: LOCK_TTL_SECONDS,
            instance: instanceId,
            ...(softTags.length ? { softTags } : {}),
            ...(cacheLayer ? { cacheLayer } : {}),
          },
        );
        return undefined;
      }

      const waitedEntry = await waitForRemoteEntry(redis, cacheKey, softTags);
      if (waitedEntry) {
        lruSetAndSync(entryKey, waitedEntry);
        return cloneEntryForReturn(waitedEntry);
      }

      cacheDebug.log(
        "GET",
        "MISS",
        "No cache entry and no lock acquired — Next.js will render on this instance",
        { key: entryKey },
      );
      return undefined;
    } catch (err) {
      console.error("[remote-cache-handler] get error:", err.message);
      cacheDebug.log("GET", "MISS", `get() error: ${err.message}`, { key: entryKey });
      return undefined;
    }
  },

  /**
   * Write entry: LRU + Redis (pipeline: payload with TTL, sadd to tag indexes,
   * extend index TTL). Finally releases this instance's single-flight lock.
   *
   * @param {string} cacheKey - Raw Next.js cache key.
   * @param {Promise<object>} pendingEntry - Entry (value as ReadableStream).
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

      lruSetAndSync(entryKey, storedEntry);

      const cacheLayer = cacheDebug.classifyCacheLayer(entry.tags ?? []);
      const writeFields = {
        key: entryKey,
        tags: cacheDebug.formatTags(entry.tags),
        ...(cacheLayer ? { cacheLayer } : {}),
        sizeBytes: buffer.length,
        ttlSec: Math.max(entry.expire, 60),
      };

      if (!redis) {
        cacheDebug.log(
          "SET",
          "WRITE",
          "Stored entry in L1 only — Redis unavailable",
          writeFields,
        );
        return;
      }

      const ttl = Math.max(entry.expire, 60);
      const pipeline = redis.multi();

      pipeline.set(entryKey, serializeEntry(entry, buffer), "EX", ttl);

      for (const tag of entry.tags) {
        pipeline.sadd(redisIndexKey(tag), entryKey);
        pipeline.expire(redisIndexKey(tag), ttl + 60, "NX");
        pipeline.expire(redisIndexKey(tag), ttl + 60, "GT");
      }

      await pipeline.exec();

      cacheDebug.log(
        "SET",
        "WRITE",
        "Stored entry in L1 and Redis (indexed by tags)",
        {
          ...writeFields,
          ttlSec: ttl,
          redis: "yes",
        },
      );
    } catch (err) {
      console.error("[remote-cache-handler] set error:", err.message);
      cacheDebug.log("SET", "MISS", `set() error: ${err.message}`, { key: entryKey });
    } finally {
      const redisForRelease = redis ?? (await getRedis());
      if (redisForRelease) {
        await releaseRenderLock(redisForRelease, cacheKey);
        cacheDebug.log(
          "SET",
          "RELEASED",
          "Released single-flight render lock (if still owned by this instance)",
          { key: entryKey },
        );
      }
      clearRenderLock(entryKey);
      resolvePending();
      pendingSets.delete(cacheKey);
    }
  },

  /**
   * Syncs local invalidation timestamps with Redis — called by Next.js before each request.
   * Backstop for instances that missed Pub/Sub. Also trims expired meta:revalidated-at:* tags.
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
      let synced = 0;

      for (let i = 0; i < tagKeys.length; i++) {
        if (values[i]) {
          localTagTimestamps.set(tagKeys[i], Number(values[i]));
          synced++;
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

      cacheDebug.log(
        "REFRESH",
        "SYNC",
        `Synchronized invalidation timestamps from Redis before request`,
        {
          syncedTags: synced,
          expiredTagsRemoved: expiredTags.length,
          expiredTags: expiredTags.length ? expiredTags : [],
        },
      );
    } catch (err) {
      console.error("[remote-cache-handler] refreshTags error:", err.message);
    }
  },

  /**
   * Returns the latest known invalidation timestamp for the given tags
   * (Next.js compares it with the entry timestamp).
   *
   * @param {string[]} tags
   * @returns {Promise<number>} Timestamp in ms (0 = never invalidated).
   */
  async getExpiration(tags) {
    const timestamps = tags.map((tag) => localTagTimestamps.get(tag) ?? 0);
    return Math.max(...timestamps, 0);
  },

  /**
   * Tag invalidation (updateTag / revalidateTag):
   * 1. Local: timestamps + L1 cleanup
   * 2. Redis (pipeline): invalidation timestamp with TTL, tag registry, delete indexes and entries
   * 3. Pub/Sub: other instances clean up their L1
   *
   * @param {string[]} tags - Tags to invalidate.
   * @param {object} durations - Time profiles from Next.js (unused — hard delete).
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
        cacheDebug.log(
          "INVALIDATE",
          "CLEAR",
          "Invalidated tags locally (L1 + timestamps) — Redis unavailable, Pub/Sub skipped",
          { tags, redis: "no" },
        );
        await publishInvalidation({ tags });
        return;
      }

      const keysToDelete = new Set();

      for (const tag of tags) {
        const keys = await redis.smembers(redisIndexKey(tag));
        for (const key of keys) {
          keysToDelete.add(key);
          lruDeleteAndSync(key);
        }
      }

      const pipeline = redis.multi();

      for (const tag of tags) {
        pipeline.set(redisRevalidatedAtKey(tag), String(now), "EX", TAG_META_TTL_SECONDS);
        pipeline.sadd(REVALIDATED_TAGS_SET, tag);
        pipeline.del(redisIndexKey(tag));
      }

      for (const key of keysToDelete) {
        pipeline.del(key);
      }

      await pipeline.exec();
      await publishInvalidation({ tags, keys: [...keysToDelete] });

      cacheDebug.log(
        "INVALIDATE",
        "CLEAR",
        `Invalidated ${tags.length} tag(s) — deleted ${keysToDelete.size} Redis entries and broadcast Pub/Sub`,
        {
          tags,
          deletedEntries: keysToDelete.size,
          T_invalid: cacheDebug.formatTime(now),
          metaTtlSec: TAG_META_TTL_SECONDS,
        },
      );
    } catch (err) {
      console.error("[remote-cache-handler] updateTags error:", err.message);
    }
  },

  /** Merged debug view (local + Redis sync from all workers in this container). */
  async getDebugPayload() {
    return cacheDebug.buildDebugPayload({
      getRedis,
      debugBox: DEBUG_BOX,
    });
  },
};
