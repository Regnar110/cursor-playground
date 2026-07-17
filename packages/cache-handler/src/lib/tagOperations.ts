import * as cacheDebug from '../cacheDebug.js';
import { REVALIDATED_TAGS_SET, TAG_META_TTL_SECONDS } from './config.js';
import { invalidateLruByTags, lruDeleteAndSync } from './l1Cache.js';
import { publishInvalidation } from './pubsub.js';
import { getRedis } from './redisClient.js';
import { redisIndexKey, redisRevalidatedAtKey } from './redisKeys.js';
import { localTagTimestamps } from './state.js';

export async function refreshTags(): Promise<void> {
    try {
        const redis = await getRedis();
        if (!redis) {
            return;
        }

        const tagKeys = await redis.smembers(REVALIDATED_TAGS_SET);
        if (tagKeys.length === 0) {
            return;
        }

        const values = await redis.mget(tagKeys.map(tag => redisRevalidatedAtKey(tag)));
        const expiredTags: string[] = [];
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
            'REFRESH',
            'SYNC',
            'Synchronized invalidation timestamps from Redis before request',
            {
                expiredTags: expiredTags.length ? expiredTags : [],
                expiredTagsRemoved: expiredTags.length,
                syncedTags: synced,
            },
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[remote-cache-handler] refreshTags error:', message);
    }
}

export async function getExpiration(tags: string[]): Promise<number> {
    const timestamps = tags.map(tag => localTagTimestamps.get(tag) ?? 0);
    return Math.max(...timestamps, 0);
}

export async function updateTags(
    tags: string[],
    _durations?: { expire?: number },
): Promise<void> {
    const now = Date.now();

    for (const tag of tags) {
        localTagTimestamps.set(tag, now);
    }

    invalidateLruByTags(tags);

    try {
        const redis = await getRedis();
        if (!redis) {
            cacheDebug.log(
                'INVALIDATE',
                'CLEAR',
                'Invalidated tags locally (L1 + timestamps) — Redis unavailable, Pub/Sub skipped',
                { redis: 'no', tags },
            );
            await publishInvalidation({ tags });
            return;
        }

        const keysToDelete = new Set<string>();

        for (const tag of tags) {
            const keys = await redis.smembers(redisIndexKey(tag));
            for (const key of keys) {
                keysToDelete.add(key);
                lruDeleteAndSync(key);
            }
        }

        const pipeline = redis.pipeline();

        for (const tag of tags) {
            pipeline.set(redisRevalidatedAtKey(tag), String(now), 'EX', TAG_META_TTL_SECONDS);
            pipeline.sadd(REVALIDATED_TAGS_SET, tag);
            pipeline.del(redisIndexKey(tag));
        }

        for (const key of keysToDelete) {
            pipeline.del(key);
        }

        await pipeline.exec();
        await publishInvalidation({ keys: [...keysToDelete], tags });

        cacheDebug.log(
            'INVALIDATE',
            'CLEAR',
            `Invalidated ${tags.length} tag(s) — deleted ${keysToDelete.size} Redis entries and broadcast Pub/Sub`,
            {
                deletedEntries: keysToDelete.size,
                metaTtlSec: TAG_META_TTL_SECONDS,
                T_invalid: cacheDebug.formatTime(now),
                tags,
            },
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[remote-cache-handler] updateTags error:', message);
    }
}
