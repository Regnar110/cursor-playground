import { randomBytes } from 'node:crypto';
import { LRUCache } from 'lru-cache';
import { envInt, isBuildPhase } from './config.js';
import type { StoredEntry } from '../types.js';
import type { Redis } from 'ioredis';

export const instanceId = `pid-${process.pid}-${randomBytes(6).toString('hex')}`;

export const DEBUG_BOX = process.env.HOSTNAME?.trim() || `local-${process.pid}`;

export const lru = new LRUCache<string, StoredEntry>({
    max: envInt('REMOTE_CACHE_LRU_MAX_ENTRIES', 500),
    maxSize: envInt('REMOTE_CACHE_LRU_MAX_SIZE_MB', 50) * 1024 * 1024,
    sizeCalculation: entry =>
        entry._size ?? envInt('REMOTE_CACHE_LRU_DEFAULT_ENTRY_SIZE_BYTES', 1024),
    ttl: envInt('REMOTE_CACHE_LRU_TTL_MS', 15_000),
});

export const pendingSets = new Map<string, Promise<void>>();

export const localTagTimestamps = new Map<string, number>();

export let redisClient: null | Redis = null;
export let redisSubClient: null | Redis = null;
export let redisConnecting: null | Promise<Redis> = null;
export let redisSubConnecting: null | Promise<void> = null;
export let redisUnavailableUntil = 0;

export function setRedisClient(client: null | Redis): void {
    redisClient = client;
}

export function setRedisConnecting(connecting: null | Promise<Redis>): void {
    redisConnecting = connecting;
}

export function setRedisSubClient(client: null | Redis): void {
    redisSubClient = client;
}

export function setRedisSubConnecting(connecting: null | Promise<void>): void {
    redisSubConnecting = connecting;
}

export function setRedisUnavailableUntil(until: number): void {
    redisUnavailableUntil = until;
}

export function resetMainRedisConnection(cooldownUntil: number): void {
    redisClient = null;
    redisConnecting = null;
    redisUnavailableUntil = cooldownUntil;
}

export function resetSubRedisConnection(): void {
    redisSubClient = null;
    redisSubConnecting = null;
}

export function redisStatusSnapshot() {
    const cooldownMs
        = redisUnavailableUntil > Date.now() ? redisUnavailableUntil - Date.now() : null;
    let status = 'disabled';
    if (isBuildPhase || !process.env.REDIS_HOST) {
        status = 'disabled';
    } else if (cooldownMs) {
        status = 'cooldown (LRU only)';
    } else if (redisClient?.status === 'ready') {
        status = 'connected';
    } else if (redisConnecting) {
        status = 'connecting';
    } else {
        status = 'disconnected';
    }
    return {
        cooldownMs,
        pubSubReady: redisSubClient?.status === 'ready',
        status,
    };
}

export { isBuildPhase };
