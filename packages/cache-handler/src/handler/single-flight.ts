import type { Redis } from "ioredis";
import * as cacheDebug from "../cache-debug.js";
import {
  LOCK_TTL_SECONDS,
  RELEASE_LOCK_SCRIPT,
  SINGLE_FLIGHT_MAX_ATTEMPTS,
  SINGLE_FLIGHT_POLL_MS,
} from "./config.js";
import { deserializeEntry } from "./entry.js";
import { redisEntryKey, redisLockKey } from "./redis-keys.js";
import { instanceId } from "./state.js";
import { isEntryFresh } from "./stale.js";
import type { StoredEntry } from "../types.js";

export async function waitForRemoteEntry(
  redis: Redis,
  cacheKey: string,
  softTags: string[],
): Promise<StoredEntry | undefined> {
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
          { ...cacheDebug.debugEntryFields(entry, redisEntryKey(cacheKey)), attempt: attempt + 1 },
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

export async function tryAcquireRenderLock(redis: Redis, cacheKey: string): Promise<boolean> {
  const result = await redis.set(redisLockKey(cacheKey), instanceId, "EX", LOCK_TTL_SECONDS, "NX");
  return result === "OK";
}

export async function releaseRenderLock(redis: Redis, cacheKey: string): Promise<void> {
  try {
    await redis.eval(RELEASE_LOCK_SCRIPT, 1, redisLockKey(cacheKey), instanceId);
  } catch {
    // lock may have expired
  }
}

export { LOCK_TTL_SECONDS };
