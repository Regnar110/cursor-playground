import Redis, { type RedisOptions } from "ioredis";
import * as cacheDebug from "../cacheDebug.js";
import { envInt, isBuildPhase, REDIS_COOLDOWN_MS } from "./config.js";
import {
  redisClient,
  redisConnecting,
  redisSubClient,
  redisUnavailableUntil,
  resetMainRedisConnection,
  resetSubRedisConnection,
  setRedisClient,
  setRedisConnecting,
} from "./state.js";

function redisOptions(): RedisOptions | null {
  if (
    !process.env.REDIS_HOST ||
    !process.env.REDIS_PORT ||
    !process.env.REDIS_PASSWORD
  ) {
    return null;
  }

  return {
    host: process.env.REDIS_HOST,
    port: envInt("REDIS_PORT", 6379),
    password: process.env.REDIS_PASSWORD,
    db: envInt("REDIS_DB", 0),
    lazyConnect: true,
    enableOfflineQueue: false,
    maxRetriesPerRequest: 2,
    retryStrategy: (times: number) => (times > 5 ? null : Math.min(times * 200, 2000)),
  };
}

export function createRedis(): Redis {
  const options = redisOptions();
  if (!options) {
    throw new Error("REDIS_HOST is not configured");
  }

  const client = new Redis(options);
  client.on("error", (err: Error) => {
    if (err?.message) {
      console.warn("[remote-cache-handler] Redis error:", err.message);
    }
  });
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

export async function getRedis(): Promise<Redis | null> {
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
    const message = err instanceof Error ? err.message : "connection failed";
    console.warn("[remote-cache-handler] Redis unavailable, using LRU only for 30s:", message);
    return null;
  }
}

export { redisUnavailableUntil };
