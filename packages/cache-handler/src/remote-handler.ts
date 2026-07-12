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
 */
export { default } from './lib/createHandler.ts';
