/**
 * Debug mode for remote cache handler.
 *
 * Enable with REMOTE_CACHE_DEBUG=<secret-token> (non-empty string).
 * When disabled: zero overhead — log() is a no-op, no state retained.
 *
 * Consumption:
 * - stderr: multi-line readable blocks (docker compose logs)
 * - GET /api/cache-debug?token=<secret> — JSON or text/plain timeline + snapshot
 * - GET /cache-debug?token=<secret> — HTML dashboard (per instance)
 */

const MAX_EVENTS = envInt("REMOTE_CACHE_DEBUG_MAX_EVENTS", 200);

/** Shared across duplicate module instances (handler bundle vs app route bundle). */
const debugState = (globalThis.__remoteCacheDebugState ??= {
  events: /** @type {DebugEvent[]} */ ([]),
  snapshotProvider: /** @type {(() => DebugSnapshot) | null} */ (null),
  /** @type {((event: DebugEvent & { instanceId?: string; debugBox?: string }) => Promise<void>) | null} */
  redisSync: null,
  /** @type {{ instanceId: string; debugBox: string } | null} */
  context: null,
  /** render lock acquired, awaiting set() — key → metadata */
  pendingLocks: /** @type {Map<string, { key: string; acquiredAt: number; instanceId: string }>} */ (new Map()),
});

/**
 * @typedef {Object} DebugEvent
 * @property {number} ts
 * @property {string} op - GET | SET | REFRESH | INVALIDATE | PUBSUB | REDIS | WAIT
 * @property {string} outcome - HIT | MISS | STALE | WRITE | SYNC | ...
 * @property {string} summary - one human-readable sentence
 * @property {Record<string, string | number | boolean | string[] | null | undefined>} [fields]
 */

/**
 * @typedef {Object} DebugSnapshot
 * @property {string} instanceId
 * @property {object} redis
 * @property {object} l1
 * @property {object[]} l1Entries
 * @property {object[]} tagTimestamps
 * @property {number} pendingSets
 * @property {object[]} [pendingLocks]
 * @property {string} [debugBox]
 */

export const DEBUG_EVENTS_LIST_MAX = MAX_EVENTS;

function envInt(name, fallback) {
  const parsed = parseInt(process.env[name], 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/** @returns {string | null} Secret token when debug is on. */
export function debugSecret() {
  const value = process.env.REMOTE_CACHE_DEBUG?.trim();
  return value ? value : null;
}

/** @returns {boolean} */
export function isDebugEnabled() {
  return debugSecret() !== null;
}

/**
 * @param {string | null | undefined} token
 * @returns {boolean}
 */
export function authorizeDebugToken(token) {
  const secret = debugSecret();
  if (!secret || !token) {
    return false;
  }
  if (secret.length !== token.length) {
    return false;
  }
  let mismatch = 0;
  for (let i = 0; i < secret.length; i++) {
    mismatch |= secret.charCodeAt(i) ^ token.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * @param {() => DebugSnapshot} provider
 */
export function registerSnapshotProvider(provider) {
  if (isDebugEnabled()) {
    debugState.snapshotProvider = provider;
  }
}

/**
 * @param {{ instanceId: string; debugBox: string }} ctx
 */
export function setDebugContext(ctx) {
  if (isDebugEnabled()) {
    debugState.context = ctx;
  }
}

/**
 * @param {(event: DebugEvent & { instanceId?: string; debugBox?: string }) => Promise<void>} syncFn
 */
export function registerRedisSync(syncFn) {
  if (isDebugEnabled()) {
    debugState.redisSync = syncFn;
  }
}

export const DEBUG_REDIS_TTL_SECONDS = 3600;

/**
 * @param {string} debugBox
 */
export function debugEventsKey(debugBox) {
  return `meta:debug-events:${debugBox}`;
}

/**
 * @param {string} debugBox
 */
export function debugL1Key(debugBox) {
  return `meta:debug-l1:${debugBox}`;
}

/**
 * @param {string} debugBox
 */
export function debugPendingKey(debugBox) {
  return `meta:debug-pending:${debugBox}`;
}

/**
 * DATA / UI / SOFT (path) layer from entry tags and soft tags.
 *
 * @param {string[]} [entryTags]
 * @param {string[]} [softTags]
 * @returns {"DATA" | "UI" | "SOFT" | "DATA+UI" | null}
 */
export function classifyCacheLayer(entryTags = [], softTags = []) {
  const hasData = entryTags.some((t) => t.startsWith("data:"));
  const hasUi = entryTags.some((t) => t.startsWith("ui:"));
  const hasSoft = softTags.length > 0;
  if (hasSoft && !hasData && !hasUi) return "SOFT";
  if (hasData && hasUi) return "DATA+UI";
  if (hasUi) return "UI";
  if (hasData) return "DATA";
  if (hasSoft) return "SOFT";
  return null;
}

/**
 * @param {string} key
 * @param {{ instanceId?: string; cacheLayer?: string | null }} [meta]
 */
export function trackPendingLock(key, meta = {}) {
  if (!isDebugEnabled()) return;
  debugState.pendingLocks.set(key, {
    key,
    acquiredAt: Date.now(),
    instanceId: meta.instanceId ?? debugState.context?.instanceId ?? "unknown",
    cacheLayer: meta.cacheLayer ?? null,
  });
}

/** @param {string} key */
export function clearPendingLock(key) {
  debugState.pendingLocks.delete(key);
}

/** @returns {{ key: string; acquiredAt: number; instanceId: string; cacheLayer?: string | null; ageMs: number }[]} */
export function getPendingLocks() {
  const now = Date.now();
  return [...debugState.pendingLocks.values()].map((row) => ({
    ...row,
    ageMs: now - row.acquiredAt,
  }));
}

/**
 * @param {string} op
 * @param {string} outcome
 * @param {string} summary
 * @param {DebugEvent["fields"]} [fields]
 */
export function log(op, outcome, summary, fields) {
  if (!isDebugEnabled()) {
    return;
  }

  /** @type {DebugEvent} */
  const event = {
    ts: Date.now(),
    op,
    outcome,
    summary,
    fields: fields ? sanitizeFields(fields) : undefined,
  };

  debugState.events.push(event);
  if (debugState.events.length > MAX_EVENTS) {
    debugState.events.shift();
  }

  const enriched = {
    ...event,
    instanceId: debugState.context?.instanceId,
    debugBox: debugState.context?.debugBox,
  };
  void debugState.redisSync?.(enriched).catch(() => {});

  console.log(formatEventBlock(event));
}

/**
 * Merge local ring buffer with Redis list (all workers in this container).
 *
 * @param {import("ioredis").Redis} redis
 * @param {string} debugBox
 * @param {DebugEvent[]} localEvents
 */
export async function mergeEventsFromRedis(redis, debugBox, localEvents) {
  const raw = await redis.lrange(debugEventsKey(debugBox), 0, -1);
  /** @type {DebugEvent[]} */
  const fromRedis = [];
  for (const line of raw) {
    try {
      fromRedis.push(JSON.parse(line));
    } catch {
      // skip
    }
  }
  const seen = new Set();
  const merged = [];
  for (const e of [...fromRedis, ...localEvents]) {
    const id = `${e.ts}|${e.op}|${e.outcome}|${e.instanceId ?? ""}|${e.fields?.key ?? ""}`;
    if (seen.has(id)) continue;
    seen.add(id);
    merged.push(e);
  }
  merged.sort((a, b) => a.ts - b.ts);
  if (merged.length > MAX_EVENTS) {
    return merged.slice(-MAX_EVENTS);
  }
  return merged;
}

/**
 * L1 mirror in Redis — populated by all Node workers in the container.
 *
 * @param {import("ioredis").Redis} redis
 * @param {string} debugBox
 */
export async function loadL1FromRedis(redis, debugBox) {
  const raw = await redis.hgetall(debugL1Key(debugBox));
  const now = Date.now();
  /** @type {{ key: string; tags: string[]; ageMs: number; size: number; createdAt: string; instanceId?: string; cacheLayer?: string | null }[]} */
  const entries = [];
  for (const value of Object.values(raw)) {
    try {
      const row = JSON.parse(value);
      entries.push({
        key: row.key,
        tags: row.tags ?? [],
        ageMs: now - (row.timestamp ?? now),
        size: row.size ?? 0,
        createdAt: formatTime(row.timestamp ?? now),
        instanceId: row.instanceId,
        cacheLayer: row.cacheLayer ?? classifyCacheLayer(row.tags ?? []),
      });
    } catch {
      // skip
    }
  }
  entries.sort((a, b) => b.ageMs - a.ageMs);
  return entries;
}

/**
 * @param {import("ioredis").Redis} redis
 * @param {string} debugBox
 */
export async function loadPendingLocksFromRedis(redis, debugBox) {
  const raw = await redis.hgetall(debugPendingKey(debugBox));
  const now = Date.now();
  return Object.values(raw).map((value) => {
    const row = JSON.parse(value);
    return {
      key: row.key,
      acquiredAt: row.acquiredAt ?? now,
      instanceId: row.instanceId ?? "unknown",
      cacheLayer: row.cacheLayer ?? null,
      ageMs: now - (row.acquiredAt ?? now),
    };
  });
}

/**
 * @param {DebugEvent["fields"]} fields
 */
function sanitizeFields(fields) {
  /** @type {DebugEvent["fields"]} */
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      out[key] = value.map(String);
    } else if (typeof value === "object" && value !== null) {
      out[key] = JSON.stringify(value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * @param {string} key
 * @param {number} [maxLen=72]
 */
export function shortKey(key, maxLen = 72) {
  if (!key) return "(empty)";
  if (key.length <= maxLen) return key;
  return `${key.slice(0, maxLen - 1)}…`;
}

/**
 * @param {number} ms
 */
export function formatAge(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  if (ms < 3_600_000) return `${(ms / 60_000).toFixed(1)} min`;
  return `${(ms / 3_600_000).toFixed(1)} h`;
}

/**
 * @param {number} ts
 */
export function formatTime(ts) {
  return new Date(ts).toISOString();
}

/**
 * @param {string[]} tags
 */
export function formatTags(tags) {
  if (!tags?.length) return "(none)";
  return tags.join(", ");
}

/**
 * @param {{timestamp: number}} entry
 * @param {Map<string, number>} tagTimestamps
 * @param {string[]} [softTags]
 */
export function describeStaleReason(entry, tagTimestamps, softTags = []) {
  const reasons = [];
  const now = Date.now();

  if (entry.revalidate != null && now > entry.timestamp + entry.revalidate * 1000) {
    reasons.push(`expired (revalidate ${entry.revalidate}s exceeded)`);
  }

  for (const tag of entry.tags ?? []) {
    const tagTs = tagTimestamps.get(tag) ?? 0;
    if (tagTs > entry.timestamp) {
      reasons.push(
        `tag "${tag}" invalidated at ${formatTime(tagTs)} > entry ${formatTime(entry.timestamp)}`,
      );
    }
  }

  for (const tag of softTags) {
    const tagTs = tagTimestamps.get(tag) ?? 0;
    if (tagTs > entry.timestamp) {
      reasons.push(`soft-tag "${tag}" invalidated after entry was created`);
    }
  }

  return reasons.length ? reasons.join("; ") : "unknown";
}

/**
 * @param {DebugEvent} event
 */
export function formatEventLine(event) {
  const time = new Date(event.ts).toISOString().slice(11, 23);
  const pad = (s, n) => s.padEnd(n);
  return `[${time}] ${pad(event.op, 10)} ${pad(event.outcome, 8)} ${event.summary}`;
}

/**
 * @param {DebugEvent} event
 */
export function formatEventBlock(event) {
  const lines = [
    "┌─ cache " + event.op + " ─ " + event.outcome + " ─────────────────────────",
    "│  " + event.summary,
  ];

  if (event.fields) {
    const width = 62;
    for (const [key, value] of Object.entries(event.fields)) {
      const text = Array.isArray(value) ? value.join(", ") : String(value);
      if (text.length <= width - key.length - 2) {
        lines.push(`│  ${key}: ${text}`);
      } else {
        lines.push(`│  ${key}:`);
        wrapText(text, width).forEach((part) => lines.push(`│    ${part}`));
      }
    }
  }

  lines.push(`│  at ${formatTime(event.ts)}`);
  lines.push("└" + "─".repeat(56));
  return lines.join("\n");
}

/**
 * @param {string} text
 * @param {number} width
 */
function wrapText(text, width) {
  const parts = [];
  for (let i = 0; i < text.length; i += width) {
    parts.push(text.slice(i, i + width));
  }
  return parts.length ? parts : [""];
}

/** @returns {DebugSnapshot | null} */
export function getSnapshot() {
  if (!isDebugEnabled() || !debugState.snapshotProvider) {
    return null;
  }
  const snap = debugState.snapshotProvider();
  return {
    ...snap,
    pendingLocks: getPendingLocks(),
    debugBox: debugState.context?.debugBox,
  };
}

/**
 * Full debug payload — merges events and L1 mirror from Redis (all workers in container).
 *
 * @param {{ getRedis?: () => Promise<import("ioredis").Redis | null>; debugBox?: string }} opts
 */
export async function buildDebugPayload(opts = {}) {
  const localSnap = debugState.snapshotProvider?.() ?? null;
  let events = getEvents();
  /** @type {DebugSnapshot["l1Entries"]} */
  let l1Entries = localSnap?.l1Entries ?? [];

  const redis = opts.getRedis ? await opts.getRedis() : null;
  const debugBox = opts.debugBox ?? debugState.context?.debugBox;

  /** @type {{ key: string; acquiredAt: number; instanceId: string; cacheLayer?: string | null; ageMs: number }[]} */
  let pendingLocks = getPendingLocks();

  if (redis && debugBox) {
    events = await mergeEventsFromRedis(redis, debugBox, events);
    l1Entries = await loadL1FromRedis(redis, debugBox);
    try {
      const fromRedis = await loadPendingLocksFromRedis(redis, debugBox);
      const mergedPending = new Map();
      for (const row of [...fromRedis, ...pendingLocks]) {
        mergedPending.set(row.key, row);
      }
      pendingLocks = [...mergedPending.values()];
    } catch {
      // keep local pending locks only
    }
  }

  /** @type {DebugSnapshot | null} */
  const snapshot = localSnap
    ? {
        ...localSnap,
        l1Entries,
        pendingLocks,
        debugBox,
        l1: {
          ...localSnap.l1,
          size: l1Entries.length > 0 ? l1Entries.length : localSnap.l1.size,
        },
      }
    : null;

  return {
    enabled: true,
    legend: DEBUG_LEGEND,
    snapshot,
    events,
  };
}

/** @returns {DebugEvent[]} */
export function getEvents() {
  if (!isDebugEnabled()) {
    return [];
  }
  return [...debugState.events];
}

/** @param {{ snapshot?: DebugSnapshot | null; events?: DebugEvent[] } | undefined} [payload] @returns {string} */
export function formatTextReport(payload) {
  const snap = payload?.snapshot ?? getSnapshot();
  const events = payload?.events ?? getEvents();
  const lines = [
    "══════════════════════════════════════════════════════════════",
    "  REMOTE CACHE DEBUG — text report",
    "══════════════════════════════════════════════════════════════",
    "",
  ];

  if (snap) {
    lines.push(`Instance:  ${snap.instanceId}`);
    lines.push(
      `Redis:     ${snap.redis.status}${snap.redis.cooldownMs ? ` (cooldown ${formatAge(snap.redis.cooldownMs)} left)` : ""}`,
    );
    lines.push(
      `L1 LRU:    ${snap.l1.size}/${snap.l1.max} entries · ${snap.l1.calculatedSize}/${snap.l1.maxSize} bytes · TTL ${snap.l1.ttlMs} ms`,
    );
    lines.push(`Pending:   ${snap.pendingSets} in-flight set()`);
    if (snap.pendingLocks?.length) {
      lines.push(`Locks:     ${snap.pendingLocks.length} render lock(s) acquired, awaiting set()`);
    }
    if (snap.debugBox) {
      lines.push(`Debug box: ${snap.debugBox} (Redis sync across Node workers)`);
    }
    lines.push("── Tag invalidation timestamps (local) ──");
    if (snap.tagTimestamps.length === 0) {
      lines.push("  (none)");
    } else {
      for (const row of snap.tagTimestamps) {
        lines.push(`  ${row.tag}  →  ${formatTime(row.invalidatedAt)}  (${formatAge(row.ageMs)} ago)`);
      }
    }
    lines.push("");
    if (snap.pendingLocks?.length) {
      lines.push("── Pending render locks (ACQUIRED, no SET yet) ──");
      for (const row of snap.pendingLocks) {
        lines.push(
          `  ${shortKey(row.key, 48)}  instance=${row.instanceId}  age=${formatAge(row.ageMs)}${row.cacheLayer ? `  layer=${row.cacheLayer}` : ""}`,
        );
      }
      lines.push("");
    }
    lines.push("");
    lines.push("── L1 entries ──");
    if (snap.l1Entries.length === 0) {
      lines.push("  (empty)");
    } else {
      for (const row of snap.l1Entries) {
        lines.push(
          `  ${shortKey(row.key, 48)}  tags=${formatTags(row.tags)}  age=${formatAge(row.ageMs)}  ${row.size} B`,
        );
      }
    }
    lines.push("");
  }

  lines.push("── Recent events (newest last) ──");
  if (events.length === 0) {
    lines.push("  (no events yet — hit a cached page)");
  } else {
    for (const event of events) {
      lines.push(formatEventLine(event));
      if (event.fields) {
        for (const [key, value] of Object.entries(event.fields)) {
          lines.push(`           ${key}: ${Array.isArray(value) ? value.join(", ") : value}`);
        }
      }
    }
  }
  lines.push("");
  return lines.join("\n");
}

/** Debug legend for API / UI consumers. */
export const DEBUG_LEGEND = {
  ops: {
    GET: "cache read (get)",
    SET: "cache write after render (set)",
    REFRESH: "sync tag timestamps before request (refreshTags)",
    INVALIDATE: "tag invalidation (updateTags)",
    PUBSUB: "L1 cleanup from Pub/Sub message",
    REDIS: "Redis connection lifecycle",
    WAIT: "single-flight polling",
  },
  outcomes: {
    HIT: "entry returned to Next.js",
    MISS: "no entry — Next.js will render",
    STALE: "entry rejected (expired or invalidated)",
    WRITE: "entry stored in L1 and/or Redis",
    SYNC: "timestamps synchronized",
    CLEAR: "L1 entries removed",
    ACQUIRED: "this instance holds the render lock",
    RELEASED: "render lock released",
    WAIT: "waiting for another instance",
    COOLDOWN: "Redis unavailable, LRU-only mode",
    CONNECT: "Redis or Pub/Sub connected",
    END: "Redis connection died",
  },
};
