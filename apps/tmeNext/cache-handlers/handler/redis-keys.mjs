/** @param {string} cacheKey */
export function encodeCacheKey(cacheKey) {
  return cacheKey.replace(/:/g, ";");
}

/** @param {string} cacheKey */
export function redisEntryKey(cacheKey) {
  return encodeCacheKey(cacheKey);
}

/** @param {string} cacheKey */
export function redisLockKey(cacheKey) {
  return `lock:${encodeCacheKey(cacheKey)}`;
}

/** @param {string} tag */
export function redisRevalidatedAtKey(tag) {
  return `meta:revalidated-at:${tag}`;
}

/** @param {string} tag */
export function redisIndexKey(tag) {
  return `index:${tag}`;
}
