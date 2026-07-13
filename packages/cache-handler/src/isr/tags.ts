import type { CacheValue, TagRecord } from './types.js';

const CACHE_TAGS_HEADER = 'x-next-cache-tags';

/** Tags of a page/route entry live in the x-next-cache-tags response header. */
export function tagsFromEntry(value: CacheValue): string[] {
  const headers = value.headers as Record<string, unknown> | undefined;
  const header = headers?.[CACHE_TAGS_HEADER];
  return typeof header === 'string' && header.length > 0 ? header.split(',') : [];
}

/**
 * Same rule as Next's built-in tags manifest: an entry is hidden when a tag was
 * invalidated after the entry was written.
 */
export function areTagsExpired(records: (TagRecord | null)[], entryLastModified: number): boolean {
  const now = Date.now();
  return records.some((record) => {
    const expiredAt = record?.expired;
    return typeof expiredAt === 'number' && expiredAt <= now && expiredAt > entryLastModified;
  });
}
