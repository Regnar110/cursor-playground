/**
 * Next.js cacheKey is JSON with ":" inside (e.g. {"country":"pl"}). Redis Insight splits
 * keys by ":", so a raw cacheKey falls apart into garbage tag trees. Colons are replaced
 * with ";" to keep the cacheKey as one readable key. Tags (index/meta) are built from
 * separate strings ("data:posts:pl:pl") and stay intact.
 *
 * @param {string} cacheKey - Raw key from Next.js.
 * @returns {string} Key with ";" instead of ":".
 */
export function encodeCacheKey(cacheKey) {
  return cacheKey.replace(/:/g, ";");
}

/**
 * Canonical entry identifier — Redis key, LRU key, and member inside index SET (1:1).
 *
 * @param {string} cacheKey - Raw Next.js cache key.
 * @returns {string} Redis entry key.
 */
export function redisEntryKey(cacheKey) {
  return encodeCacheKey(cacheKey);
}

/**
 * Single-flight lock key for one entry.
 *
 * @param {string} cacheKey - Raw Next.js cache key.
 * @returns {string} Redis lock key.
 */
export function redisLockKey(cacheKey) {
  return `lock:${encodeCacheKey(cacheKey)}`;
}

/**
 * Tag invalidation timestamp key.
 * tag = data:posts:pl:pl → meta:revalidated-at:data:posts:pl:pl
 *
 * @param {string} tag - Application tag (data:* / ui:*).
 * @returns {string} Redis meta key.
 */
export function redisRevalidatedAtKey(tag) {
  return `meta:revalidated-at:${tag}`;
}

/**
 * Tag index key.
 * tag = "data:posts:pl:pl" → "index:data:posts:pl:pl" (index:data / index:ui tree)
 *
 * @param {string} tag - Application tag (data:* / ui:*).
 * @returns {string} Redis index key.
 */
export function redisIndexKey(tag) {
  return `index:${tag}`;
}
