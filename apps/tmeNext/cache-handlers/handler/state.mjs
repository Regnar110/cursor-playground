import crypto from "node:crypto";
import { LRUCache } from "lru-cache";
import { envInt, isBuildPhase } from "./config.mjs";

/**
 * Unique instance identifier — value of lock:* for single-flight.
 * PID alone is not enough — different hosts can share the same PID.
 */
export const instanceId = `pid-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;

/** Container id (Docker HOSTNAME) — shared debug namespace for all Node workers. */
export const DEBUG_BOX = process.env.HOSTNAME?.trim() || `local-${process.pid}`;

/** L1: in-process LRU — short TTL, invalidated via Pub/Sub */
export const lru = new LRUCache({
  max: envInt("REMOTE_CACHE_LRU_MAX_ENTRIES", 500),
  maxSize: envInt("REMOTE_CACHE_LRU_MAX_SIZE_MB", 50) * 1024 * 1024,
  sizeCalculation: (entry) =>
    entry._size ?? envInt("REMOTE_CACHE_LRU_DEFAULT_ENTRY_SIZE_BYTES", 1024),
  ttl: envInt("REMOTE_CACHE_LRU_TTL_MS", 15_000),
});

/** In-flight writes (cacheKey → Promise) — get() waits for set() on the same key. */
export const pendingSets = new Map();

/**
 * Local copy of invalidation timestamps (tag → ms). Synced with Redis in refreshTags().
 * Trimmed when meta:revalidated-at:{tag} expires — the map does not grow forever.
 */
export const localTagTimestamps = new Map();

/** @type {import("ioredis").Redis | null} */
export let redisClient = null;

/** @type {import("ioredis").Redis | null} */
export let redisSubClient = null;

/** @type {Promise<import("ioredis").Redis> | null} */
export let redisConnecting = null;

/** @type {Promise<void> | null} */
export let redisSubConnecting = null;

export let redisUnavailableUntil = 0;

/** @param {import("ioredis").Redis | null} client */
export function setRedisClient(client) {
  redisClient = client;
}

/** @param {Promise<import("ioredis").Redis> | null} connecting */
export function setRedisConnecting(connecting) {
  redisConnecting = connecting;
}

/** @param {import("ioredis").Redis | null} client */
export function setRedisSubClient(client) {
  redisSubClient = client;
}

/** @param {Promise<void> | null} connecting */
export function setRedisSubConnecting(connecting) {
  redisSubConnecting = connecting;
}

/** @param {number} until */
export function setRedisUnavailableUntil(until) {
  redisUnavailableUntil = until;
}

export function resetMainRedisConnection(cooldownUntil) {
  redisClient = null;
  redisConnecting = null;
  redisUnavailableUntil = cooldownUntil;
}

export function resetSubRedisConnection() {
  redisSubClient = null;
  redisSubConnecting = null;
}

export function redisStatusSnapshot() {
  const cooldownMs =
    redisUnavailableUntil > Date.now() ? redisUnavailableUntil - Date.now() : null;
  let status = "disabled";
  if (isBuildPhase || !process.env.REDIS_HOST) {
    status = "disabled";
  } else if (cooldownMs) {
    status = "cooldown (LRU only)";
  } else if (redisClient?.status === "ready") {
    status = "connected";
  } else if (redisConnecting) {
    status = "connecting";
  } else {
    status = "disconnected";
  }
  return {
    status,
    cooldownMs,
    pubSubReady: redisSubClient?.status === "ready",
  };
}
