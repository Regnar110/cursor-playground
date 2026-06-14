import * as cacheDebug from "../cache-debug.mjs";
import { getRedis } from "./redis-client.mjs";
import {
  DEBUG_BOX,
  instanceId,
  localTagTimestamps,
  lru,
  pendingSets,
  redisStatusSnapshot,
} from "./state.mjs";

/** @param {object} entry @param {string} entryKey @param {string[]} [softTags] */
export function debugEntryFields(entry, entryKey, softTags = []) {
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

/** @param {string} entryKey @param {object} entry */
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
export function lruSetAndSync(entryKey, entry) {
  lru.set(entryKey, entry);
  void syncL1EntryToRedis(entryKey, entry).catch(() => {});
}

/** @param {string} entryKey */
export function lruDeleteAndSync(entryKey) {
  lru.delete(entryKey);
  void syncL1RemoveFromRedis(entryKey).catch(() => {});
}

/** @param {string[]} tags */
export function invalidateLruByTags(tags) {
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

/** @param {string} entryKey @param {{ cacheLayer?: string | null }} meta */
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

/** @param {string} entryKey @param {{ cacheLayer?: string | null }} [meta] */
export function trackRenderLock(entryKey, meta = {}) {
  cacheDebug.trackPendingLock(entryKey, meta);
  void syncPendingLockToRedis(entryKey, meta).catch(() => {});
}

/** @param {string} entryKey */
export function clearRenderLock(entryKey) {
  cacheDebug.clearPendingLock(entryKey);
  void syncPendingLockRemoveFromRedis(entryKey).catch(() => {});
}

export function registerDebugHooks() {
  cacheDebug.setDebugContext({ instanceId, debugBox: DEBUG_BOX });

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

  cacheDebug.registerRedisSync(async (event) => {
    const redis = await getRedis();
    if (!redis) return;
    const listKey = cacheDebug.debugEventsKey(DEBUG_BOX);
    await redis.rpush(listKey, JSON.stringify(event));
    await redis.ltrim(listKey, -cacheDebug.DEBUG_EVENTS_LIST_MAX, -1);
    await redis.expire(listKey, cacheDebug.DEBUG_REDIS_TTL_SECONDS);
  });
}
