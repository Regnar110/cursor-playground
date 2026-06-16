import * as cacheDebug from "../cache-debug.js";
import type { StoredEntry } from "../types.js";
import { lru } from "./state.js";

export function lruSetAndSync(entryKey: string, entry: StoredEntry): void {
  lru.set(entryKey, entry);
  void cacheDebug.syncL1EntryToRedis(entryKey, entry).catch(() => {});
}

export function lruDeleteAndSync(entryKey: string): void {
  lru.delete(entryKey);
  void cacheDebug.syncL1RemoveFromRedis(entryKey).catch(() => {});
}

export function invalidateLruByTags(tags: string[]): void {
  const keysToDelete: string[] = [];

  lru.forEach((entry, key) => {
    if (entry.tags?.some((tag) => tags.includes(tag))) {
      keysToDelete.push(key);
    }
  });

  for (const key of keysToDelete) {
    lruDeleteAndSync(key);
  }
}
