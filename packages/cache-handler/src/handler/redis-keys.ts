export function encodeCacheKey(cacheKey: string): string {
  return cacheKey.replace(/:/g, ";");
}

export function redisEntryKey(cacheKey: string): string {
  return encodeCacheKey(cacheKey);
}

export function redisLockKey(cacheKey: string): string {
  return `lock:${encodeCacheKey(cacheKey)}`;
}

export function redisRevalidatedAtKey(tag: string): string {
  return `meta:revalidated-at:${tag}`;
}

export function redisIndexKey(tag: string): string {
  return `index:${tag}`;
}
