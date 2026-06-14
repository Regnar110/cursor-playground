import { localTagTimestamps } from "./state.mjs";

/** @param {{timestamp: number, revalidate: number}} entry */
export function isExpired(entry) {
  return Date.now() > entry.timestamp + entry.revalidate * 1000;
}

/** @param {{timestamp: number}} entry @param {string[]} softTags */
export function isSoftTagStale(entry, softTags) {
  for (const tag of softTags) {
    const tagTs = localTagTimestamps.get(tag) ?? 0;
    if (tagTs > entry.timestamp) {
      return true;
    }
  }
  return false;
}

/** @param {{timestamp: number}} entry @param {string[]} tags */
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
