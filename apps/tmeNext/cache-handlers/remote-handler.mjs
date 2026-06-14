/**
 * Remote cache handler for Next.js 16 (`use cache: remote`).
 *
 * Architecture:
 * - L1: in-process LRU cache with short TTL — limits round-trips to Redis on hot load
 * - L2: Redis — shared across Next.js application instances
 * - Pub/Sub — invalidates L1 cache entries across all instances on invalidation
 * - Single-flight lock — on cache MISS only one instance renders, rest wait for result
 * - Tag timestamps (meta:revalidated-at:*) — persistent backstop when an instance
 *   misses a Pub/Sub message (no connection, Redis restart, etc.)
 *
 * Redis key layout (Redis Insight groups by ":"):
 *
 * {cacheKey with ; not :}                   — payload; Next.js key with ":" → ";"
 * lock:{cacheKey with ;}                    — single-flight lock (temporary, owner-checked)
 * index:data:posts:pl:pl                    — SET of encoded cache keys; index:data / index:ui tree
 * meta:revalidated-at:data:posts:pl:pl      — tag invalidation timestamp (TTL = TAG_META_TTL_SECONDS)
 * meta:revalidated-tags                     — SET of tag names (trimmed in refreshTags)
 *
 * Implementation lives in ./handler/*
 */
export { default } from "./handler/create-handler.mjs";
