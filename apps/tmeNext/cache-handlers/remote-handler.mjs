/**
 * Remote cache handler for Next.js 16 (`use cache: remote`).
 *
 * Entry point — implementation lives in ./handler/*:
 * - config.mjs         env + constants
 * - redis-keys.mjs     key encoding (":" → ";", lock/index/meta prefixes)
 * - entry.mjs          v8 serialize/deserialize, streams
 * - state.mjs          per-process singleton (LRU, Redis refs, tag timestamps)
 * - stale.mjs          expiry + tag invalidation checks
 * - redis-client.mjs   ioredis lifecycle + cooldown fallback
 * - l1-cache.mjs       LRU ops + debug mirror
 * - pubsub.mjs         cross-instance L1 invalidation
 * - single-flight.mjs  render lock acquire/wait/release
 * - tag-operations.mjs refreshTags / updateTags / getExpiration
 * - create-handler.mjs get / set orchestration
 *
 * Architecture:
 * - L1: in-process LRU → L2: Redis → single-flight lock on miss
 * - Pub/Sub + meta:revalidated-at:* for invalidation backstop
 */
export { default } from "./handler/create-handler.mjs";
