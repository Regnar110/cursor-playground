import * as cacheDebug from "../cache-debug.mjs";
import {
  cloneEntryForReturn,
  deserializeEntry,
  readStreamToBuffer,
  serializeEntry,
} from "./entry.mjs";
import {
  clearRenderLock,
  debugEntryFields,
  lruSetAndSync,
  registerDebugHooks,
  trackRenderLock,
} from "./l1-cache.mjs";
import { setupSubscriber } from "./pubsub.mjs";
import { getRedis, redisUnavailableUntil } from "./redis-client.mjs";
import { redisEntryKey, redisIndexKey, redisLockKey } from "./redis-keys.mjs";
import {
  LOCK_TTL_SECONDS,
  releaseRenderLock,
  tryAcquireRenderLock,
  waitForRemoteEntry,
} from "./single-flight.mjs";
import { DEBUG_BOX, instanceId, localTagTimestamps, lru, pendingSets } from "./state.mjs";
import { isEntryFresh } from "./stale.mjs";
import { getExpiration, refreshTags, updateTags } from "./tag-operations.mjs";

registerDebugHooks();

/**
 * Read entry: L1 (LRU) → L2 (Redis) → single-flight (wait for another instance
 * or acquire lock and return undefined so Next.js renders and calls set()).
 *
 * @param {string} cacheKey - Cache key from Next.js.
 * @param {string[]} softTags - Soft path tags (revalidatePath).
 * @returns {Promise<object | undefined>} Cache entry or undefined (miss).
 */
async function get(cacheKey, softTags) {
  await setupSubscriber();

  const entryKey = redisEntryKey(cacheKey);

  const pendingPromise = pendingSets.get(cacheKey);
  if (pendingPromise) {
    await pendingPromise;
  }

  const lruEntry = lru.get(entryKey);
  if (lruEntry) {
    if (isEntryFresh(lruEntry, softTags, lruEntry.tags)) {
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
      if (isEntryFresh(entry, softTags, entry.tags)) {
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
}

/**
 * Write entry: LRU + Redis (pipeline: payload with TTL, sadd to tag indexes,
 * extend index TTL). Finally releases this instance's single-flight lock.
 *
 * @param {string} cacheKey - Raw Next.js cache key.
 * @param {Promise<object>} pendingEntry - Entry (value as ReadableStream).
 * @returns {Promise<void>}
 */
async function set(cacheKey, pendingEntry) {
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
      cacheDebug.log("SET", "WRITE", "Stored entry in L1 only — Redis unavailable", writeFields);
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

    cacheDebug.log("SET", "WRITE", "Stored entry in L1 and Redis (indexed by tags)", {
      ...writeFields,
      ttlSec: ttl,
      redis: "yes",
    });
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
}

/** Merged debug view (local + Redis sync from all workers in this container). */
async function getDebugPayload() {
  return cacheDebug.buildDebugPayload({
    getRedis,
    debugBox: DEBUG_BOX,
  });
}

export default {
  get,
  set,
  refreshTags,
  getExpiration,
  updateTags,
  getDebugPayload,
};
