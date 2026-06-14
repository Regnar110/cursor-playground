import v8 from "node:v8";
import * as cacheDebug from "../cache-debug.mjs";
import { INVALIDATE_CHANNEL, isBuildPhase } from "./config.mjs";
import { lruDeleteAndSync, invalidateLruByTags } from "./l1-cache.mjs";
import { createRedis, getRedis } from "./redis-client.mjs";
import {
  lru,
  redisSubClient,
  redisSubConnecting,
  setRedisSubClient,
  setRedisSubConnecting,
} from "./state.mjs";

/**
 * @param {{tags?: string[], keys?: string[]}} payload
 */
export async function publishInvalidation(payload) {
  try {
    const redis = await getRedis();
    if (!redis) {
      return;
    }
    await redis.publish(INVALIDATE_CHANNEL, v8.serialize(payload).toString("base64"));
  } catch (err) {
    console.warn("[remote-cache-handler] publish failed:", err.message);
  }
}

/** @returns {Promise<void>} */
export async function setupSubscriber() {
  if (isBuildPhase || !process.env.REDIS_HOST || (redisSubClient && redisSubClient.status === "ready")) {
    return;
  }

  if (!redisSubConnecting) {
    setRedisSubConnecting(
      (async () => {
        const client = createRedis();
        await client.connect();
        client.on("message", (channel, message) => {
          if (channel !== INVALIDATE_CHANNEL) {
            return;
          }
          try {
            const payload = v8.deserialize(Buffer.from(message, "base64"));
            if (payload.tags?.length) {
              const before = lru.size;
              invalidateLruByTags(payload.tags);
              cacheDebug.log(
                "PUBSUB",
                "CLEAR",
                `Pub/Sub invalidation cleared L1 entries tagged ${cacheDebug.formatTags(payload.tags)}`,
                {
                  tags: payload.tags,
                  l1Before: before,
                  l1After: lru.size,
                  keys: payload.keys?.length ? payload.keys : [],
                },
              );
            }
            if (payload.keys?.length) {
              for (const key of payload.keys) {
                lruDeleteAndSync(key);
              }
            }
          } catch {
            // ignore malformed messages
          }
        });
        await client.subscribe(INVALIDATE_CHANNEL);
        setRedisSubClient(client);
      })(),
    );
  }

  try {
    await redisSubConnecting;
  } catch (err) {
    setRedisSubConnecting(null);
    console.warn("[remote-cache-handler] Pub/Sub setup failed:", err.message);
  }
}
