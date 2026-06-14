import * as cacheDebug from "../cache-debug.mjs";
import {
  REVALIDATED_TAGS_SET,
  TAG_META_TTL_SECONDS,
} from "./config.mjs";
import {
  invalidateLruByTags,
  lruDeleteAndSync,
} from "./l1-cache.mjs";
import { publishInvalidation } from "./pubsub.mjs";
import { getRedis } from "./redis-client.mjs";
import { redisIndexKey, redisRevalidatedAtKey } from "./redis-keys.mjs";
import { localTagTimestamps } from "./state.mjs";

/** @returns {Promise<void>} */
export async function refreshTags() {
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
      "Synchronized invalidation timestamps from Redis before request",
      {
        syncedTags: synced,
        expiredTagsRemoved: expiredTags.length,
        expiredTags: expiredTags.length ? expiredTags : [],
      },
    );
  } catch (err) {
    console.error("[remote-cache-handler] refreshTags error:", err.message);
  }
}

/** @param {string[]} tags */
export async function getExpiration(tags) {
  const timestamps = tags.map((tag) => localTagTimestamps.get(tag) ?? 0);
  return Math.max(...timestamps, 0);
}

/**
 * @param {string[]} tags
 * @param {object} _durations
 */
export async function updateTags(tags, _durations) {
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
}
