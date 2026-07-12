import { localTagTimestamps } from './state.js';

export function isExpired(entry: { timestamp: number; revalidate: number }): boolean {
    return Date.now() > entry.timestamp + entry.revalidate * 1000;
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
    entry: { timestamp: number; revalidate: number },
    softTags: string[],
    tags: string[],
): boolean {
    return !isExpired(entry) && !isSoftTagStale(entry, softTags) && !isTagStale(entry, tags);
}
