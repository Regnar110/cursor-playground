/** @param {string} name @param {number} fallback */
export function envInt(name, fallback) {
  const parsed = parseInt(process.env[name], 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const REVALIDATED_TAGS_SET = "meta:revalidated-tags";
export const INVALIDATE_CHANNEL = "pubsub:invalidate";

/** TTL single-flight lock; render longer than this window loses the lock (see releaseRenderLock). */
export const LOCK_TTL_SECONDS = envInt("SINGLE_FLIGHT_LOCK_TTL", 30);
/** Interval between Redis polls while waiting for another instance's result. */
export const SINGLE_FLIGHT_POLL_MS = envInt("SINGLE_FLIGHT_POLLING_MS", 100);
/** Max single-flight poll attempts (~5 s at defaults: 50 × 100 ms). */
export const SINGLE_FLIGHT_MAX_ATTEMPTS = envInt("SINGLE_FLIGHT_ATTEMPTS", 50);

/**
 * Invalidation metadata TTL (meta:revalidated-at:*).
 *
 * The tag timestamp is a backstop for entries saved before invalidation that were not
 * deleted (write race, offline instance at updateTags). Such entries expire on their
 * own TTL anyway, so a timestamp older than the longest reasonable entry lifetime has
 * nothing left to invalidate — it can safely disappear. Prevents meta-keys from growing forever.
 */
export const TAG_META_TTL_SECONDS = envInt("TAG_META_TTL_SECONDS", 7 * 24 * 60 * 60);

/** Build phase — no Redis during `next build`. */
export const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

/**
 * Compare-and-delete lock: remove lock:* ONLY if still owned by this instance.
 * Protects against: instance A renders > LOCK_TTL_SECONDS → lock expires → instance B
 * acquires lock → A finishes and would delete B's lock without this check.
 */
export const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

export const REDIS_COOLDOWN_MS = 30_000;
