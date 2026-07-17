import { envInt, TAG_META_TTL_SECONDS, ISR_MAX_ENTRY_BYTES } from '../lib/config.js';
import { cacheLog } from '../lib/log.js';
import { getRedis } from '../lib/redisClient.js';
import { deserializeStoredEntry, serializeStoredEntry } from './entry.js';
import { isrEntryKey, isrTagKey } from './keys.js';
import { areTagsExpired, tagsFromEntry } from './tags.js';
import type {
  CacheValue,
  GetContext,
  HandlerContext,
  SetContext,
  StoredEntry,
  TagRecord,
} from './types.js';

/** Default entry lifetime when the route provides no explicit `expire`. */
const ENTRY_TTL_SECONDS = envInt('ISR_ENTRY_TTL_SECONDS', 24 * 60 * 60);
const LOG_PREFIX = 'isr-cache-handler';

/**
 * Custom `cacheHandler` for Next.js incremental / full route cache.
 *
 * Next.js creates a **new instance per request** when it constructs
 * `IncrementalCache` (comment in upstream: "incremental-cache is request
 * specific … per-cache handler"). The framework passes `revalidatedTags` from
 * the current request headers so on-demand revalidation in the same request is
 * visible to `get()`.
 *
 * Do not open Redis or other heavy resources here — use module-scope singletons
 * (`getRedis`). `resetRequestCache()` is called between phases of the same
 * request; this implementation is a no-op because we have no per-request memory
 * cache.
 *
 * @see https://github.com/vercel/next.js/blob/v16.2.0/packages/next/src/server/lib/incremental-cache/index.ts
 * @see https://github.com/vercel/next.js/blob/v16.2.0/packages/next/src/server/next-server.ts
 */
export default class RedisIsrCacheHandler {
  /** Tags already revalidated within the current request (on-demand revalidation). */
  private revalidatedTags: string[];

  constructor(ctx?: HandlerContext) {
    this.revalidatedTags = ctx?.revalidatedTags ?? [];
  }

  /**
   * Every cache lookup goes to Redis (GET entry + MGET tag records). With
   * `cacheMaxMemorySize: 0` there is no in-process ISR layer, so even a "hot"
   * page pays a network round-trip on each refresh — unlike the default disk /
   * memory handler where hits are effectively instant on the same instance.
   */
  async get(cacheKey: string, ctx: GetContext): Promise<StoredEntry | null> {
    try {
      const redis = await getRedis();
      if (!redis) {
        return null;
      }

      const raw = await redis.getBuffer(isrEntryKey(cacheKey));
      if (!raw) {
        return null;
      }

      const entry = deserializeStoredEntry(raw);

      const tags =
        ctx.kind === 'FETCH'
          ? [...(ctx.tags ?? []), ...(ctx.softTags ?? [])]
          : tagsFromEntry(entry.value);

      if (ctx.kind === 'FETCH' && tags.some((tag) => this.revalidatedTags.includes(tag))) {
        return null;
      }

      if (tags.length > 0) {
        const rawRecords = await redis.mget(tags.map(isrTagKey));
        const records = rawRecords.map((r) => (r ? (JSON.parse(r) as TagRecord) : null));
        if (areTagsExpired(records, entry.lastModified)) {
          return null;
        }
      }

      return { lastModified: entry.lastModified, value: entry.value as never };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cacheLog(LOG_PREFIX, 'warn', `get failed, treating as miss: ${message}`);
      return null;
    }
  }

  async set(cacheKey: string, data: CacheValue | null, ctx: SetContext): Promise<void> {
    try {
      const redis = await getRedis();
      if (!redis) {
        return;
      }

      if (!data) {
        await redis.del(isrEntryKey(cacheKey));
        return;
      }

      const value = { ...data } as CacheValue;
      if (ctx.fetchCache) {
        value.tags = ctx.tags ?? [];
      }

      const lastModified = Date.now();
      const ttl = ctx.cacheControl?.expire ?? ENTRY_TTL_SECONDS;
      const payload = serializeStoredEntry(lastModified, value);
      if (payload.byteLength > ISR_MAX_ENTRY_BYTES) {
        cacheLog(
          LOG_PREFIX,
          'warn',
          `set skipped for ${cacheKey}: entry exceeds ISR_MAX_ENTRY_BYTES (${ISR_MAX_ENTRY_BYTES})`,
        );
        return;
      }
      await redis.set(isrEntryKey(cacheKey), payload, 'EX', ttl);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cacheLog(LOG_PREFIX, 'warn', `set failed, entry not shared: ${message}`);
    }
  }

  async revalidateTag(tags: string | string[], durations?: { expire?: number }): Promise<void> {
    const tagList = typeof tags === 'string' ? [tags] : tags;
    if (tagList.length === 0) {
      return;
    }

    try {
      const redis = await getRedis();
      if (!redis) {
        return;
      }

      const now = Date.now();
      const pipeline = redis.pipeline();

      for (const tag of tagList) {
        const record: TagRecord = durations
          ? {
              stale: now,
              ...(durations.expire !== undefined ? { expired: now + durations.expire * 1000 } : {}),
            }
          : { expired: now };
        pipeline.set(isrTagKey(tag), JSON.stringify(record), 'EX', TAG_META_TTL_SECONDS);
      }

      await pipeline.exec();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      cacheLog(LOG_PREFIX, 'error', `revalidateTag failed: ${message}`);
    }
  }

  resetRequestCache(): void {}
}
