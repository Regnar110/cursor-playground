import { localTagTimestamps } from "./state.mjs";

/**
 * Whether the entry exceeded its revalidate window (hard miss).
 *
 * @param {{timestamp: number, revalidate: number}} entry
 * @returns {boolean}
 */
export function isExpired(entry) {
  return Date.now() > entry.timestamp + entry.revalidate * 1000;
}

/**
 * Whether the entry is stale relative to soft path tags (revalidatePath).
 *
 * @param {{timestamp: number}} entry
 * @param {string[]} softTags - Soft tags passed by Next.js to get().
 * @returns {boolean}
 */
export function isSoftTagStale(entry, softTags) {
  for (const tag of softTags) {
    const tagTs = localTagTimestamps.get(tag) ?? 0;
    if (tagTs > entry.timestamp) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the entry is stale relative to its own tags (updateTag / revalidateTag).
 *
 * @param {{timestamp: number}} entry
 * @param {string[]} tags - Entry tags.
 * @returns {boolean}
 */
export function isTagStale(entry, tags) {
  for (const tag of tags) {
    const tagTs = localTagTimestamps.get(tag) ?? 0;
    if (tagTs > entry.timestamp) {
      return true;
    }
  }
  return false;
}

/** @param {{timestamp: number}} entry @param {string[]} softTags @param {string[]} tags */
export function isEntryFresh(entry, softTags, tags) {
  return !isExpired(entry) && !isSoftTagStale(entry, softTags) && !isTagStale(entry, tags);
}
