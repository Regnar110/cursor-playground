import Redis from "ioredis";
import * as cacheDebug from "../cache-debug.mjs";
import { envInt, isBuildPhase, REDIS_COOLDOWN_MS } from "./config.mjs";
import {
  redisClient,
  redisConnecting,
  redisSubClient,
  redisUnavailableUntil,
  resetMainRedisConnection,
  resetSubRedisConnection,
  setRedisClient,
  setRedisConnecting,
} from "./state.mjs";

/**
 * Builds ioredis client options from REDIS_* env vars.
 *
 * @returns {import("ioredis").RedisOptions | null} null when REDIS_HOST is not set.
 */
function redisOptions() {
  if (!process.env.REDIS_HOST) {
    return null;
  }

  const options = {
    host: process.env.REDIS_HOST,
    port: envInt("REDIS_PORT", 6379),
    db: envInt("REDIS_DB", 0),
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    retryStrategy: (times) => (times > 5 ? null : Math.min(times * 200, 2000)),
  };

  if (process.env.REDIS_PASSWORD) {
    options.password = process.env.REDIS_PASSWORD;
  }

  return options;
}

/**
 * Creates an ioredis client tuned for fast LRU fallback:
 * - lazyConnect — manual connect() to control fallback
 * - enableOfflineQueue:false — commands fail immediately without a connection
 * - retryStrategy — a few attempts, then give up (30 s cooldown on LRU-only mode)
 *
 * @returns {import("ioredis").Redis} Unconnected client (status "wait").
 */
function createRedis() {
  const options = redisOptions();
  if (!options) {
    throw new Error("REDIS_HOST is not configured");
  }

  const client = new Redis(options);
  client.on("error", (err) => {
    if (err?.message) {
      console.warn("[remote-cache-handler] Redis error:", err.message);
    }
  });
  // After retryStrategy is exhausted (~5 s outage), ioredis emits "end" and the client
  // is dead forever. Reset refs so the next request builds a fresh connection.
  client.on("end", () => {
    if (redisClient === client) {
      resetMainRedisConnection(Date.now() + REDIS_COOLDOWN_MS);
      console.warn("[remote-cache-handler] Redis connection ended — LRU only, reconnect after 30s");
      cacheDebug.log(
        "REDIS",
        "END",
        "Main Redis connection died — handler switches to LRU-only for 30 s, then reconnects",
        { role: "main" },
      );
    }
    if (redisSubClient === client) {
      resetSubRedisConnection();
      console.warn("[remote-cache-handler] Pub/Sub connection ended — will re-subscribe");
      cacheDebug.log(
        "REDIS",
        "END",
        "Pub/Sub connection died — will re-subscribe on next cached request",
        { role: "pubsub" },
      );
    }
  });
  return client;
}

/**
 * Returns shared Redis client or null (build phase, no REDIS_HOST, or cooldown after failure).
 * null === handler works on LRU only.
 *
 * @returns {Promise<import("ioredis").Redis | null>}
 */
export async function getRedis() {
  if (isBuildPhase || !process.env.REDIS_HOST) {
    return null;
  }

  if (Date.now() < redisUnavailableUntil) {
    return null;
  }

  if (redisClient && redisClient.status === "ready") {
    return redisClient;
  }

  if (!redisConnecting) {
    setRedisConnecting(
      (async () => {
        const client = createRedis();
        await client.connect();
        setRedisClient(client);
        return client;
      })(),
    );
  }

  try {
    return await redisConnecting;
  } catch (err) {
    setRedisConnecting(null);
    resetMainRedisConnection(Date.now() + REDIS_COOLDOWN_MS);
    console.warn(
      "[remote-cache-handler] Redis unavailable, using LRU only for 30s:",
      err.message || "connection failed",
    );
    return null;
  }
}

export { createRedis, redisUnavailableUntil };
