import v8 from "node:v8";
import { createRequire } from "node:module";
import { join } from "node:path";
import { afterEach, beforeEach, jest } from "@jest/globals";
import type { CacheEntry, CacheHandler } from "../../src/types.js";

const PKG_ROOT = process.cwd();
const requireCjs = createRequire(join(PKG_ROOT, "package.json"));

export const TAG = "data:posts:pl:pl";
export const CACHE_KEY = 'abc:["posts",{"country":"pl","lang":"pl"}]';
export const ENCODED_KEY = CACHE_KEY.replace(/:/g, ";");

interface FakeRedisSubscriber {
  emit: (event: string, ...args: unknown[]) => void;
}

interface FakeRedisInstance {
  subscribedChannel: string | null;
  die: () => void;
}

export interface FakeRedisState {
  store: Map<string, Buffer>;
  sets: Map<string, Set<string>>;
  ttls: Map<string, number>;
  published: Array<{ channel: string; message: string }>;
  subscribers: FakeRedisSubscriber[];
  instances: FakeRedisInstance[];
  failConnect: boolean;
}

export interface FakeRedisModule {
  state: FakeRedisState;
  reset: () => void;
  new (url: string, opts: unknown): unknown;
}

export let FakeRedis: FakeRedisModule;
export let handler: CacheHandler;

export function loadHandler(): CacheHandler {
  jest.resetModules();
  FakeRedis = requireCjs(join(PKG_ROOT, "__tests__/fake-redis.cjs")) as FakeRedisModule;
  return requireCjs(join(PKG_ROOT, "src/lib/createHandler.ts")).default as CacheHandler;
}

function streamFrom(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(Buffer.from(text));
      controller.close();
    },
  });
}

export async function readAll(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const chunks: Buffer[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString();
}

export function makeEntry({
  payload = "hello",
  tags = [TAG],
  revalidate = 300,
  expire = 3600,
  timestamp = Date.now(),
}: {
  payload?: string;
  tags?: string[];
  revalidate?: number;
  expire?: number;
  timestamp?: number;
} = {}): CacheEntry {
  return { value: streamFrom(payload), tags, stale: 60, timestamp, expire, revalidate };
}

export function seedRedisEntry(
  encodedKey: string,
  {
    payload = "remote",
    tags = [TAG],
    revalidate = 300,
    expire = 3600,
    timestamp = Date.now(),
  }: {
    payload?: string;
    tags?: string[];
    revalidate?: number;
    expire?: number;
    timestamp?: number;
  } = {},
): void {
  FakeRedis.state.store.set(
    encodedKey,
    v8.serialize({ value: Buffer.from(payload), tags, stale: 60, timestamp, expire, revalidate }),
  );
}

export function setupHandlerTests(): void {
  beforeEach(() => {
    process.env.REDIS_HOST = "fake";
    process.env.REDIS_PORT = "6379";
    process.env.REDIS_DB = "0";
    process.env.REDIS_PASSWORD = "test";
    delete process.env.REMOTE_CACHE_DEBUG_ENABLED;
    delete process.env.NEXT_PHASE;
    handler = loadHandler();
    FakeRedis.reset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });
}
