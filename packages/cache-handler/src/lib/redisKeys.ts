export function redisEntryKeyNamespacePrefix(cacheKey: string): string {
  if (process.env.REDIS_CACHE_PREFIX) {
      return `${process.env.REDIS_CACHE_PREFIX}:${cacheKey}`;
  }
  return cacheKey;
}

export function encodeCacheKey(cacheKey: string): string {
  return cacheKey.replace(/:/g, ';');
}

export function redisEntryKey(cacheKey: string): string {
  return redisEntryKeyNamespacePrefix(encodeCacheKey(cacheKey));
}

export function redisLockKey(cacheKey: string): string {
  return redisEntryKeyNamespacePrefix(`lock:${encodeCacheKey(cacheKey)}`);
}

export function redisRevalidatedAtKey(tag: string): string {
  return redisEntryKeyNamespacePrefix(`meta:revalidated-at:${tag}`);
}

export function redisIndexKey(tag: string): string {
  return redisEntryKeyNamespacePrefix(`index:${tag}`);
}
