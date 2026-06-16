/** @param {string} name @param {number} fallback */
export function envInt(name: string, fallback: number): number {
  const parsed = parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const REVALIDATED_TAGS_SET = "meta:revalidated-tags";
export const INVALIDATE_CHANNEL = "pubsub:invalidate";

export const LOCK_TTL_SECONDS = envInt("SINGLE_FLIGHT_LOCK_TTL", 30);
export const SINGLE_FLIGHT_POLL_MS = envInt("SINGLE_FLIGHT_POLLING_MS", 100);
export const SINGLE_FLIGHT_MAX_ATTEMPTS = envInt("SINGLE_FLIGHT_ATTEMPTS", 50);
export const TAG_META_TTL_SECONDS = envInt("TAG_META_TTL_SECONDS", 7 * 24 * 60 * 60);

export const isBuildPhase = process.env.NEXT_PHASE === "phase-production-build";

export const RELEASE_LOCK_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

export const REDIS_COOLDOWN_MS = 30_000;
