/**
 * Debug telemetry for remote cache handler (write-only).
 *
 * Enable with REMOTE_CACHE_DEBUG_ENABLED=true.
 * When disabled: zero overhead — log() is a no-op, no state retained.
 *
 * Observability:
 * - stderr: multi-line readable blocks (docker compose logs)
 * - Redis: meta:debug-events:*, meta:debug-l1:*, meta:debug-pending:*
 */

/*
 * Cache debug log legend.
 *
 * Each log entry has an `op` (what was happening) and an `outcome` (what happened).
 *
 * **Operations:**
 * - `GET`        — cache read (get)
 * - `SET`        — cache write after render (set)
 * - `REFRESH`    — sync tag timestamps before request (refreshTags)
 * - `INVALIDATE` — tag invalidation (updateTags)
 * - `PUBSUB`     — L1 cleanup from Pub/Sub message
 * - `REDIS`      — Redis connection lifecycle
 * - `WAIT`       — single-flight polling
 *
 * **Outcomes:**
 * - `HIT`      — entry returned to Next.js
 * - `MISS`     — no entry, Next.js will render
 * - `STALE`    — entry rejected (expired or invalidated)
 * - `WRITE`    — entry stored in L1 and/or Redis
 * - `SYNC`     — timestamps synchronized
 * - `CLEAR`    — L1 entries removed
 * - `ACQUIRED` — this instance holds the render lock
 * - `RELEASED` — render lock released
 * - `WAIT`     — waiting for another instance
 * - `COOLDOWN` — Redis unavailable, LRU-only mode
 * - `CONNECT`  — Redis or Pub/Sub connected
 * - `END`      — Redis connection died
 */

import { getRedis } from './lib/redis-client.js';
import { redisEntryKeyNamespacePrefix } from './lib/redis-keys.ts'; 
import type { LRUCache } from 'lru-cache';
import type { CacheLayer, DebugEvent, DebugEventFields, StoredEntry } from './types.js';

const MAX_EVENTS = envInt('REMOTE_CACHE_DEBUG_MAX_EVENTS', 200);

/** Shared debug namespace for all Node workers in the container. */
const DEBUG_BOX = process.env.HOSTNAME?.trim() || `local-${process.pid}`;

interface DebugSnapshot {
    instanceId: string;
    l1: {
        size: number;
        max: number;
        calculatedSize: number;
        maxSize: number;
        ttlMs: number;
    };
    l1Entries: {
        key: string;
        tags: string[];
        ageMs: number;
        size: number;
        createdAt: string;
    }[];
    pendingSets: number;
    redis: { status: string; cooldownMs: null | number; pubSubReady: boolean };
    tagTimestamps: { tag: string; invalidatedAt: number; ageMs: number }[];
}

interface DebugState {
    context: { instanceId: string; debugBox: string } | null;
    events: DebugEvent[];
    pendingLocks: Map<
        string,
        { key: string; acquiredAt: number; instanceId: string; cacheLayer?: null | string }
    >;
    redisSync: ((event: DebugEvent) => Promise<void>) | null;
    snapshotProvider: (() => DebugSnapshot) | null;
}

declare global {

    var __remoteCacheDebugState: DebugState | undefined;
}

const debugState: DebugState = (globalThis.__remoteCacheDebugState ??= {
    context: null,
    events: [],
    pendingLocks: new Map(),
    redisSync: null,
    snapshotProvider: null,
});

export const DEBUG_EVENTS_LIST_MAX = MAX_EVENTS;

function envInt(name: string, fallback: number): number {
    const parsed = parseInt(process.env[name] ?? '', 10);
    return Number.isFinite(parsed) ? parsed : fallback;
}

export function isDebugEnabled(): boolean {
    return process.env.REMOTE_CACHE_DEBUG_ENABLED === 'true';
}

function setDebugContext(ctx: { instanceId: string; debugBox: string }): void {
    if (isDebugEnabled()) {
        debugState.context = ctx;
    }
}

function registerSnapshotProvider(provider: () => DebugSnapshot): void {
    if (isDebugEnabled()) {
        debugState.snapshotProvider = provider;
    }
}

function registerRedisSync(syncFn: (event: DebugEvent) => Promise<void>): void {
    if (isDebugEnabled()) {
        debugState.redisSync = syncFn;
    }
}

export const DEBUG_REDIS_TTL_SECONDS = 3600;

function debugEventsKey(debugBox: string): string {
    return redisEntryKeyNamespacePrefix(`meta:debug-events:${debugBox}`);
}

function debugL1Key(debugBox: string): string {
    return redisEntryKeyNamespacePrefix(`meta:debug-l1:${debugBox}`);
}

function debugPendingKey(debugBox: string): string {
    return redisEntryKeyNamespacePrefix(`meta:debug-pending:${debugBox}`);
}

export function registerDebugHooks(
    lru: LRUCache<string, StoredEntry>,
    localTagTimestamps: Map<string, number>,
    instanceId: string,
    redisStatusSnapshot: () => {
        status: string;
        cooldownMs: null | number;
        pubSubReady: boolean;
    },
    pendingSets: Map<string, Promise<void>>,
): void {
    setDebugContext({ debugBox: DEBUG_BOX, instanceId });

    registerSnapshotProvider(() => {
        const now = Date.now();
        const l1Entries: DebugSnapshot['l1Entries'] = [];
        lru.forEach((entry, key) => {
            l1Entries.push({
                ageMs: now - entry.timestamp,
                createdAt: formatTime(entry.timestamp),
                key,
                size: entry._size ?? 0,
                tags: entry.tags ?? [],
            });
        });
        l1Entries.sort((a, b) => b.ageMs - a.ageMs);

        const tagTimestamps = [...localTagTimestamps.entries()]
            .map(([tag, invalidatedAt]) => ({
                ageMs: now - invalidatedAt,
                invalidatedAt,
                tag,
            }))
            .sort((a, b) => b.invalidatedAt - a.invalidatedAt);

        return {
            instanceId,
            l1: {
                calculatedSize: lru.calculatedSize ?? 0,
                max: lru.max,
                maxSize: lru.maxSize ?? 0,
                size: lru.size,
                ttlMs: lru.ttl ?? 0,
            },
            l1Entries,
            pendingSets: pendingSets.size,
            redis: redisStatusSnapshot(),
            tagTimestamps,
        };
    });

    registerRedisSync(async event => {
        const redis = await getRedis();
        if (!redis) return;
        const listKey = debugEventsKey(DEBUG_BOX);
        await redis.rpush(listKey, JSON.stringify(event));
        await redis.ltrim(listKey, -DEBUG_EVENTS_LIST_MAX, -1);
        await redis.expire(listKey, DEBUG_REDIS_TTL_SECONDS);
    });
}

export function classifyCacheLayer(
    entryTags: string[] = [],
    softTags: string[] = [],
): CacheLayer | null {
    const hasData = entryTags.some(t => t.startsWith('data:'));
    const hasUi = entryTags.some(t => t.startsWith('ui:'));
    const hasSoft = softTags.length > 0;
    if (hasSoft && !hasData && !hasUi) return 'SOFT';
    if (hasData && hasUi) return 'DATA+UI';
    if (hasUi) return 'UI';
    if (hasData) return 'DATA';
    if (hasSoft) return 'SOFT';
    return null;
}

function trackPendingLock(
    key: string,
    meta: { instanceId?: string; cacheLayer?: null | string } = {},
): void {
    if (!isDebugEnabled()) return;
    debugState.pendingLocks.set(key, {
        acquiredAt: Date.now(),
        cacheLayer: meta.cacheLayer ?? null,
        instanceId: meta.instanceId ?? debugState.context?.instanceId ?? 'unknown',
        key,
    });
}

function clearPendingLock(key: string): void {
    debugState.pendingLocks.delete(key);
}

export function log(
    op: string,
    outcome: string,
    summary: string,
    fields?: DebugEventFields,
): void {
    if (!isDebugEnabled()) {
        return;
    }

    const event: DebugEvent = {
        fields: fields ? sanitizeFields(fields) : undefined,
        op,
        outcome,
        summary,
        ts: Date.now(),
    };

    debugState.events.push(event);
    if (debugState.events.length > MAX_EVENTS) {
        debugState.events.shift();
    }

    const enriched: DebugEvent = {
        ...event,
        debugBox: debugState.context?.debugBox,
        instanceId: debugState.context?.instanceId,
    };
    void debugState.redisSync?.(enriched).catch(() => {});

    console.log(formatEventBlock(event));
}

/** @internal Exported for unit tests. */
export function getEvents(): DebugEvent[] {
    if (!isDebugEnabled()) {
        return [];
    }
    return [...debugState.events];
}

function sanitizeFields(fields: DebugEventFields): DebugEventFields {
    const out: DebugEventFields = {};
    for (const [key, value] of Object.entries(fields)) {
        if (value === undefined) continue;
        if (Array.isArray(value)) {
            out[key] = value.map(String);
        } else if (typeof value === 'object' && value !== null) {
            out[key] = JSON.stringify(value);
        } else {
            out[key] = value;
        }
    }
    return out;
}

function formatAge(ms: number): string {
    if (ms < 1000) return `${ms} ms`;
    if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
    if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
    return `${(ms / 3_600_000).toFixed(1)} h`;
}

export function formatTime(ts: number): string {
    return new Date(ts).toISOString();
}

export function formatTags(tags: string[] | undefined): string {
    if (!tags?.length) return '(none)';
    return tags.join(', ');
}

export function describeStaleReason(
    entry: { timestamp: number; revalidate?: number; tags?: string[] },
    tagTimestamps: Map<string, number>,
    softTags: string[] = [],
): string {
    const reasons: string[] = [];
    const now = Date.now();

    if (entry.revalidate != null && now > entry.timestamp + entry.revalidate * 1000) {
        reasons.push(`expired (revalidate ${entry.revalidate}s exceeded)`);
    }

    for (const tag of entry.tags ?? []) {
        const tagTs = tagTimestamps.get(tag) ?? 0;
        if (tagTs > entry.timestamp) {
            reasons.push(
                `tag '${tag}' invalidated at ${formatTime(tagTs)} > entry ${formatTime(entry.timestamp)}`,
            );
        }
    }

    for (const tag of softTags) {
        const tagTs = tagTimestamps.get(tag) ?? 0;
        if (tagTs > entry.timestamp) {
            reasons.push(`soft-tag '${tag}' invalidated after entry was created`);
        }
    }

    return reasons.length ? reasons.join('; ') : 'unknown';
}

export function formatEventBlock(event: DebugEvent): string {
    const lines = [
        '┌─ cache ' + event.op + ' ─ ' + event.outcome + ' ─────────────────────────',
        '│  ' + event.summary,
    ];

    if (event.fields) {
        const width = 62;
        for (const [key, value] of Object.entries(event.fields)) {
            const text = Array.isArray(value) ? value.join(', ') : String(value);
            if (text.length <= width - key.length - 2) {
                lines.push(`│  ${key}: ${text}`);
            } else {
                lines.push(`│  ${key}:`);
                wrapText(text, width).forEach(part => lines.push(`│    ${part}`));
            }
        }
    }

    lines.push(`│  at ${formatTime(event.ts)}`);
    lines.push('└' + '─'.repeat(56));
    return lines.join('\n');
}

function wrapText(text: string, width: number): string[] {
    const parts: string[] = [];
    for (let i = 0; i < text.length; i += width) {
        parts.push(text.slice(i, i + width));
    }
    return parts.length ? parts : [''];
}

export function debugEntryFields(
    entry: StoredEntry,
    entryKey: string,
    softTags: string[] = [],
) {
    const tagList = entry.tags ?? [];
    const cacheLayer = classifyCacheLayer(tagList, softTags);
    return {
        key: entryKey,
        tags: formatTags(tagList),
        ...(cacheLayer ? { cacheLayer } : {}),
        age: formatAge(Date.now() - entry.timestamp),
        created: formatTime(entry.timestamp),
        sizeBytes: entry._size ?? 0,
    };
}

async function syncL1RemoveFromRedis(entryKey: string): Promise<void> {
    if (!isDebugEnabled()) return;
    const redis = await getRedis();
    if (!redis) return;
    await redis.hdel(debugL1Key(DEBUG_BOX), entryKey);
}

export async function syncL1EntryToRedis(entryKey: string, entry: StoredEntry): Promise<void> {
    if (!isDebugEnabled()) return;
    const redis = await getRedis();
    if (!redis) return;
    const payload = JSON.stringify({
        cacheLayer: classifyCacheLayer(entry.tags ?? []),
        instanceId: debugState.context?.instanceId ?? 'unknown',
        key: entryKey,
        size: entry._size ?? 0,
        tags: entry.tags ?? [],
        timestamp: entry.timestamp,
    });
    await redis.hset(debugL1Key(DEBUG_BOX), entryKey, payload);
    await redis.expire(debugL1Key(DEBUG_BOX), DEBUG_REDIS_TTL_SECONDS);
}

async function syncPendingLockToRedis(
    entryKey: string,
    meta: { instanceId?: string; cacheLayer?: null | string },
): Promise<void> {
    if (!isDebugEnabled()) return;
    const redis = await getRedis();
    if (!redis) return;
    const payload = JSON.stringify({
        acquiredAt: Date.now(),
        cacheLayer: meta.cacheLayer ?? null,
        instanceId: meta.instanceId ?? debugState.context?.instanceId ?? 'unknown',
        key: entryKey,
    });
    await redis.hset(debugPendingKey(DEBUG_BOX), entryKey, payload);
    await redis.expire(debugPendingKey(DEBUG_BOX), DEBUG_REDIS_TTL_SECONDS);
}

async function syncPendingLockRemoveFromRedis(entryKey: string): Promise<void> {
    if (!isDebugEnabled()) return;
    const redis = await getRedis();
    if (!redis) return;
    await redis.hdel(debugPendingKey(DEBUG_BOX), entryKey);
}

export function trackRenderLock(
    entryKey: string,
    meta: { cacheLayer?: null | string } = {},
): void {
    trackPendingLock(entryKey, meta);
    void syncPendingLockToRedis(entryKey, meta).catch(() => {});
}

export function clearRenderLock(entryKey: string): void {
    clearPendingLock(entryKey);
    void syncPendingLockRemoveFromRedis(entryKey).catch(() => {});
}

export { syncL1RemoveFromRedis };
