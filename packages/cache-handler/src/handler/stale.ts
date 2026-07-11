import { localTagTimestamps } from "./state.js";

/**
 * Stale-while-revalidate: entries older than `revalidate` are still served —
 * Next.js compares `timestamp + revalidate` itself and triggers a background
 * refresh (see use-cache-wrapper). The handler only rejects entries past
 * `expire`, the hard end of an entry's life.
 */
export function isExpired(entry: { timestamp: number; expire: number }): boolean {
  return Date.now() > entry.timestamp + entry.expire * 1000;
}

export function isSoftTagStale(entry: { timestamp: number }, softTags: string[]): boolean {
  for (const tag of softTags) {
    const tagTs = localTagTimestamps.get(tag) ?? 0;
    if (tagTs > entry.timestamp) {
      return true;
    }
  }
  return false;
}

export function isTagStale(entry: { timestamp: number }, tags: string[]): boolean {
  for (const tag of tags) {
    const tagTs = localTagTimestamps.get(tag) ?? 0;
    if (tagTs > entry.timestamp) {
      return true;
    }
  }
  return false;
}

export function isEntryFresh(
  entry: { timestamp: number; expire: number },
  softTags: string[],
  tags: string[],
): boolean {
  return !isExpired(entry) && !isSoftTagStale(entry, softTags) && !isTagStale(entry, tags);
}
