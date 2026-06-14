import * as cacheDebug from "../cache-debug.mjs";
import {
  LOCK_TTL_SECONDS,
  RELEASE_LOCK_SCRIPT,
  SINGLE_FLIGHT_MAX_ATTEMPTS,
  SINGLE_FLIGHT_POLL_MS,
} from "./config.mjs";
import { deserializeEntry } from "./entry.mjs";
import { debugEntryFields } from "./l1-cache.mjs";
import { redisEntryKey, redisLockKey } from "./redis-keys.mjs";
import { instanceId } from "./state.mjs";
import { isEntryFresh } from "./stale.mjs";

/**
 * @param {import("ioredis").Redis} redis
 * @param {string} cacheKey
 * @param {string[]} softTags
 */
export async function waitForRemoteEntry(redis, cacheKey, softTags) {
  cacheDebug.log(
    "WAIT",
    "WAIT",
    "Another instance holds the render lock — polling Redis for the result",
    { key: redisEntryKey(cacheKey) },
  );

  for (let attempt = 0; attempt < SINGLE_FLIGHT_MAX_ATTEMPTS; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, SINGLE_FLIGHT_POLL_MS));

    const stored = await redis.getBuffer(redisEntryKey(cacheKey));
    if (stored) {
      const entry = deserializeEntry(stored);
      if (isEntryFresh(entry, softTags, entry.tags)) {
        cacheDebug.log(
          "WAIT",
          "HIT",
          "Single-flight wait succeeded — using entry written by another instance",
          { ...debugEntryFields(entry, redisEntryKey(cacheKey)), attempt: attempt + 1 },
        );
        return entry;
      }
    }

    const lockExists = await redis.exists(redisLockKey(cacheKey));
    if (!lockExists) {
      cacheDebug.log(
        "WAIT",
        "MISS",
        "Lock disappeared but no valid entry appeared — stop waiting",
        { attempt: attempt + 1 },
      );
      break;
    }
  }

  cacheDebug.log("WAIT", "MISS", "Single-flight wait timed out — this instance may render");
  return undefined;
}

/**
 * @param {import("ioredis").Redis} redis
 * @param {string} cacheKey
 */
export async function tryAcquireRenderLock(redis, cacheKey) {
  const result = await redis.set(redisLockKey(cacheKey), instanceId, "EX", LOCK_TTL_SECONDS, "NX");
  return result === "OK";
}

/**
 * @param {import("ioredis").Redis} redis
 * @param {string} cacheKey
 */
export async function releaseRenderLock(redis, cacheKey) {
  try {
    await redis.eval(RELEASE_LOCK_SCRIPT, 1, redisLockKey(cacheKey), instanceId);
  } catch {
    // lock may have expired
  }
}

export { LOCK_TTL_SECONDS };
