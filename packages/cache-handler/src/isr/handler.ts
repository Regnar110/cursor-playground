import { envInt, TAG_META_TTL_SECONDS } from '../lib/config.js';
import { getRedis } from '../lib/redisClient.js';
import { isrEntryKey, isrTagKey } from './keys.js';
import { deserializeValue, serializeValue } from './serialize.js';
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

export default class RedisIsrCacheHandler {
  /** Tags already revalidated within the current request (on-demand revalidation). */
  private revalidatedTags: string[];

  constructor(ctx?: HandlerContext) {
    this.revalidatedTags = ctx?.revalidatedTags ?? [];
  }

  async get(cacheKey: string, ctx: GetContext): Promise<StoredEntry | null> {
    try {
      const redis = await getRedis();
      if (!redis) {
        return null;
      }

      const raw = await redis.get(isrEntryKey(cacheKey));
      if (!raw) {
        return null;
      }

      const entry = JSON.parse(raw) as StoredEntry;

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

      return { lastModified: entry.lastModified, value: deserializeValue(entry.value) as never };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[isr-cache-handler] get failed, treating as miss:', message);
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

      const value = serializeValue(data);
      if (ctx.fetchCache) {
        value.tags = ctx.tags ?? [];
      }

      const entry: StoredEntry = { lastModified: Date.now(), value };
      const ttl = ctx.cacheControl?.expire ?? ENTRY_TTL_SECONDS;
      await redis.set(isrEntryKey(cacheKey), JSON.stringify(entry), 'EX', ttl);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn('[isr-cache-handler] set failed, entry not shared:', message);
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
      const pipeline = redis.multi();

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
      console.error('[isr-cache-handler] revalidateTag failed:', message);
    }
  }

  resetRequestCache(): void {}
}
