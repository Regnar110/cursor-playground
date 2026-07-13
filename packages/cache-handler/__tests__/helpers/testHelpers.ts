import v8 from 'node:v8';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { CacheEntry, CacheHandler } from '../../src/types.js';

const PKG_ROOT = process.cwd();
const requireCjs = createRequire(join(PKG_ROOT, 'package.json'));

export const TAG = 'data:posts:pl:pl';
export const CACHE_KEY = 'abc:["posts",{"country":"pl","lang":"pl"}]';
export const ENCODED_KEY = CACHE_KEY.replace(/:/g, ';');

interface FakeRedisSubscriber {
    emit: (event: string, ...args: unknown[]) => void;
}

interface FakeRedisInstance {
    die: () => void;
    subscribedChannel: null | string;
}

export interface FakeRedisState {
    failConnect: boolean;
    instances: FakeRedisInstance[];
    published: Array<{ channel: string; message: string }>;
    sets: Map<string, Set<string>>;
    store: Map<string, Buffer>;
    subscribers: FakeRedisSubscriber[];
    ttls: Map<string, number>;
}

export interface FakeRedisModule {
    reset: () => void;
    state: FakeRedisState;
    new (url: string, opts: unknown): unknown;
}

export let FakeRedis: FakeRedisModule;
export let handler: CacheHandler;

export function loadHandler(): CacheHandler {
    jest.resetModules();
    FakeRedis = requireCjs(join(PKG_ROOT, '__tests__/fakeRedis.cjs')) as FakeRedisModule;
    return requireCjs(join(PKG_ROOT, 'src/lib/createHandler.ts')).default as CacheHandler;
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
    expire = 3600,
    payload = 'hello',
    revalidate = 300,
    tags = [TAG],
    timestamp = Date.now(),
}: {
    payload?: string;
    tags?: string[];
    revalidate?: number;
    expire?: number;
    timestamp?: number;
} = {}): CacheEntry {
    return { expire, revalidate, stale: 60, tags, timestamp, value: streamFrom(payload) };
}

export function seedRedisEntry(
    encodedKey: string,
    {
        expire = 3600,
        payload = 'remote',
        revalidate = 300,
        tags = [TAG],
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
        v8.serialize({ expire, revalidate, stale: 60, tags, timestamp, value: Buffer.from(payload) }),
    );
}

export function setupHandlerTests(): void {
    beforeEach(() => {
        process.env.REDIS_HOST = 'fake';
        process.env.REDIS_PORT = '6379';
        process.env.REDIS_DB = '0';
        process.env.REDIS_PASSWORD = 'test';
        delete process.env.REMOTE_CACHE_DEBUG_ENABLED;
        delete process.env.NEXT_PHASE;
        handler = loadHandler();
        FakeRedis.reset();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });
}
