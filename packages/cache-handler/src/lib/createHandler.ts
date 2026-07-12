import * as cacheDebug from '../cacheDebug.js';
import {
    cloneEntryForReturn,
    deserializeEntry,
    readStreamToBuffer,
    serializeEntry,
} from './entry.js';
import { lruSetAndSync } from './l1Cache.js';
import { setupSubscriber } from './pubsub.js';
import { getRedis, redisUnavailableUntil } from './redisClient.js';
import { redisEntryKey, redisIndexKey, redisLockKey } from './redisKeys.js';
import {
    LOCK_TTL_SECONDS,
    releaseRenderLock,
    tryAcquireRenderLock,
    waitForRemoteEntry,
} from './singleFlight.js';
import {
    instanceId,
    localTagTimestamps,
    lru,
    pendingSets,
    redisStatusSnapshot,
} from './state.js';
import { isEntryFresh } from './stale.js';
import { getExpiration, refreshTags, updateTags } from './tagOperations.js';
import type { CacheEntry, CacheHandler, StoredEntry } from '../types.js';

cacheDebug.registerDebugHooks(
    lru,
    localTagTimestamps,
    instanceId,
    redisStatusSnapshot,
    pendingSets,
);

async function get(cacheKey: string, softTags: string[]): Promise<CacheEntry | undefined> {
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
                'GET',
                'HIT',
                'Returned fresh entry from L1 (in-process LRU)',
                {
                    layer: 'L1',
                    ...cacheDebug.debugEntryFields(lruEntry, entryKey, softTags),
                },
            );
            return cloneEntryForReturn(lruEntry);
        }

        cacheDebug.log(
            'GET',
            'STALE',
            'L1 entry rejected — '
            + cacheDebug.describeStaleReason(lruEntry, localTagTimestamps, softTags),
            {
                layer: 'L1',
                ...cacheDebug.debugEntryFields(lruEntry, entryKey, softTags),
            },
        );
    }

    try {
        const redis = await getRedis();
        if (!redis) {
            const cooldown = redisUnavailableUntil > Date.now();
            cacheDebug.log(
                'GET',
                'MISS',
                cooldown
                    ? 'Redis in cooldown after outage — miss (Next.js will render, L1-only until reconnect)'
                    : 'Redis unavailable or not configured — miss (Next.js will render)',
                { key: entryKey, layer: cooldown ? 'cooldown' : 'none' },
            );
            return undefined;
        }

        const stored = await redis.getBuffer(entryKey);
        if (stored) {
            const entry = deserializeEntry(stored);
            if (isEntryFresh(entry, softTags, entry.tags)) {
                lruSetAndSync(entryKey, entry);
                cacheDebug.log(
                    'GET',
                    'HIT',
                    'Returned fresh entry from L2 (Redis) and promoted to L1',
                    {
                        layer: 'L2',
                        ...cacheDebug.debugEntryFields(entry, entryKey, softTags),
                    },
                );
                return cloneEntryForReturn(entry);
            }

            cacheDebug.log(
                'GET',
                'STALE',
                'Redis entry rejected — '
                + cacheDebug.describeStaleReason(entry, localTagTimestamps, softTags),
                {
                    layer: 'L2',
                    ...cacheDebug.debugEntryFields(entry, entryKey, softTags),
                },
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
            cacheDebug.trackRenderLock(entryKey, { cacheLayer });
            cacheDebug.log(
                'GET',
                'ACQUIRED',
                'This instance acquired the render lock — Next.js will render and call set()',
                {
                    instance: instanceId,
                    key: entryKey,
                    lockTtlSec: LOCK_TTL_SECONDS,
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
            'GET',
            'MISS',
            'No cache entry and no lock acquired — Next.js will render on this instance',
            { key: entryKey },
        );
        return undefined;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[remote-cache-handler] get error:', message);
        cacheDebug.log('GET', 'MISS', `get() error: ${message}`, { key: entryKey });
        return undefined;
    }
}

async function set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void> {
    let resolvePending!: () => void;
    const pendingPromise = new Promise<void>(resolve => {
        resolvePending = resolve;
    });
    pendingSets.set(cacheKey, pendingPromise);

    const redis = await getRedis();
    const entryKey = redisEntryKey(cacheKey);

    try {
        const entry = await pendingEntry;
        const buffer = await readStreamToBuffer(entry.value);

        const storedEntry: StoredEntry = {
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
            cacheDebug.log('SET', 'WRITE', 'Stored entry in L1 only — Redis unavailable', writeFields);
            return;
        }

        const ttl = Math.max(entry.expire, 60);

        /**
         * start redis transaction
         */
        const pipeline = redis.multi();

        /**
         * Add serializedEntry to redis without nesting in set's
         */
        pipeline.set(entryKey, serializeEntry(entry, buffer), 'EX', ttl);

        for (const tag of entry.tags) {
            /**
             * Add entry key to set. If set not existed then creates it without TTL (presistent)
             */
            pipeline.sadd(redisIndexKey(tag), entryKey);

            /**
             * set TTL for entry only if key has no TTL set yet
             */
            pipeline.expire(redisIndexKey(tag), ttl + 60, 'NX');

            /**
             * set TTL for entry only if new value is greater than previous
             */
            pipeline.expire(redisIndexKey(tag), ttl + 60, 'GT');
        }

        /**
         * execute redis transaction
         */
        await pipeline.exec();

        cacheDebug.log('SET', 'WRITE', 'Stored entry in L1 and Redis (indexed by tags)', {
            ...writeFields,
            redis: 'yes',
            ttlSec: ttl,
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error('[remote-cache-handler] set error:', message);
        cacheDebug.log('SET', 'MISS', `set() error: ${message}`, { key: entryKey });
    } finally {
        const redisForRelease = redis ?? (await getRedis());
        if (redisForRelease) {
            await releaseRenderLock(redisForRelease, cacheKey);
            cacheDebug.log(
                'SET',
                'RELEASED',
                'Released single-flight render lock (if still owned by this instance)',
                { key: entryKey },
            );
        }
        cacheDebug.clearRenderLock(entryKey);
        resolvePending();
        pendingSets.delete(cacheKey);
    }
}

const handler: CacheHandler = {
    get,
    getExpiration,
    refreshTags,
    set,
    updateTags,
};

export default handler;
