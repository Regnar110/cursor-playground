import { redisEntryKeyNamespacePrefix } from '../lib/redisKeys.js';

export function isrEntryKey(cacheKey: string): string {
  return redisEntryKeyNamespacePrefix(`isr:entry:${cacheKey}`);
}

export function isrTagKey(tag: string): string {
  return redisEntryKeyNamespacePrefix(`isr:tag:${tag}`);
}
