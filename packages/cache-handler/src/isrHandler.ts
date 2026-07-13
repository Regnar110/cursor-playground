/**
 * Redis-backed incremental cache handler (`cacheHandler` in next.config).
 *
 * Covers what the `use cache` handler (remoteHandler) does NOT: the full route
 * cache (ISR HTML/RSC payloads), route handler responses, the fetch cache and
 * optimized images. By default Next.js keeps these on the local disk of each
 * instance, so a multi-instance deployment serves diverging snapshots. Storing
 * them in Redis gives every instance the same view and makes revalidateTag /
 * revalidatePath effective cluster-wide.
 *
 * Semantics mirror Next's built-in FileSystemCache:
 * - entries carry `lastModified`; a tag invalidated AFTER that moment hides the entry
 * - page/route entries derive their tags from the `x-next-cache-tags` header
 * - fetch entries are checked against tags + softTags provided by the caller
 */
import { envInt, TAG_META_TTL_SECONDS } from './lib/config.js';
import { getRedis } from './lib/redisClient.js';
import { redisEntryKeyNamespacePrefix } from './lib/redisKeys.js';

const CACHE_TAGS_HEADER = 'x-next-cache-tags';

/** Default entry lifetime when the route provides no explicit `expire`. */
const ENTRY_TTL_SECONDS = envInt('ISR_ENTRY_TTL_SECONDS', 24 * 60 * 60);

type TagRecord = { stale?: number; expired?: number };

interface StoredEntry {
  lastModified: number;
  value: SerializedValue;
}

/** IncrementalCacheValue with Buffers/Maps replaced by base64/plain objects. */
type SerializedValue = Record<string, unknown> & { kind: string };

interface HandlerContext {
  revalidatedTags?: string[];
}

interface GetContext {
  kind: string;
  tags?: string[];
  softTags?: string[];
}

interface SetContext {
  fetchCache?: boolean;
  tags?: string[];
  cacheControl?: { revalidate?: number | false; expire?: number };
}

function entryKey(cacheKey: string): string {
  return redisEntryKeyNamespacePrefix(`isr:entry:${cacheKey}`);
}

function tagKey(tag: string): string {
  return redisEntryKeyNamespacePrefix(`isr:tag:${tag}`);
}

function toBase64(buffer: unknown): string | undefined {
  return Buffer.isBuffer(buffer) ? buffer.toString('base64') : undefined;
}

function fromBase64(value: unknown): Buffer | undefined {
  return typeof value === 'string' ? Buffer.from(value, 'base64') : undefined;
}

/** Converts an IncrementalCacheValue into a JSON-safe shape. */
function serializeValue(value: Record<string, unknown> & { kind: string }): SerializedValue {
  switch (value.kind) {
    case 'APP_PAGE': {
      const segmentData = value.segmentData as Map<string, Buffer> | undefined;
      return {
        ...value,
        rscData: toBase64(value.rscData),
        segmentData: segmentData
          ? Object.fromEntries([...segmentData].map(([path, buf]) => [path, buf.toString('base64')]))
          : undefined,
      };
    }
    case 'APP_ROUTE':
      return { ...value, body: toBase64(value.body) };
    case 'IMAGE':
      return { ...value, buffer: toBase64(value.buffer) };
    default:
      return value;
  }
}

/** Restores Buffers/Maps in an entry read back from Redis. */
function deserializeValue(value: SerializedValue): Record<string, unknown> & { kind: string } {
  switch (value.kind) {
    case 'APP_PAGE': {
      const segments = value.segmentData as Record<string, string> | undefined;
      return {
        ...value,
        rscData: fromBase64(value.rscData),
        segmentData: segments
          ? new Map(Object.entries(segments).map(([path, b64]) => [path, Buffer.from(b64, 'base64')]))
          : undefined,
      };
    }
    case 'APP_ROUTE':
      return { ...value, body: fromBase64(value.body) };
    case 'IMAGE':
      return { ...value, buffer: fromBase64(value.buffer) };
    default:
      return value;
  }
}

/** Tags of a page/route entry live in the x-next-cache-tags response header. */
function tagsFromEntry(value: SerializedValue): string[] {
  const headers = value.headers as Record<string, unknown> | undefined;
  const header = headers?.[CACHE_TAGS_HEADER];
  return typeof header === 'string' && header.length > 0 ? header.split(',') : [];
}

/** Same rule as Next's tags-manifest: invalidation after entry creation hides it. */
function areTagsExpired(records: (TagRecord | null)[], entryLastModified: number): boolean {
  const now = Date.now();
  return records.some((record) => {
    const expiredAt = record?.expired;
    return typeof expiredAt === 'number' && expiredAt <= now && expiredAt > entryLastModified;
  });
}

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

      const raw = await redis.get(entryKey(cacheKey));
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
        const rawRecords = await redis.mget(tags.map(tagKey));
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

  async set(
    cacheKey: string,
    data: (Record<string, unknown> & { kind: string }) | null,
    ctx: SetContext,
  ): Promise<void> {
    try {
      const redis = await getRedis();
      if (!redis) {
        return;
      }

      if (!data) {
        await redis.del(entryKey(cacheKey));
        return;
      }

      const value = serializeValue(data);
      if (ctx.fetchCache) {
        value.tags = ctx.tags ?? [];
      }

      const entry: StoredEntry = { lastModified: Date.now(), value };
      const ttl = ctx.cacheControl?.expire ?? ENTRY_TTL_SECONDS;
      await redis.set(entryKey(cacheKey), JSON.stringify(entry), 'EX', ttl);
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
        pipeline.set(tagKey(tag), JSON.stringify(record), 'EX', TAG_META_TTL_SECONDS);
      }

      await pipeline.exec();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[isr-cache-handler] revalidateTag failed:', message);
    }
  }

  resetRequestCache(): void {}
}
