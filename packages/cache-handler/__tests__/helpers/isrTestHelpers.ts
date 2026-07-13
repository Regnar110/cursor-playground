import { createRequire } from 'node:module';
import { join } from 'node:path';
import type { FakeRedisModule } from './testHelpers.js';

const PKG_ROOT = process.cwd();
const requireCjs = createRequire(join(PKG_ROOT, 'package.json'));

export const PAGE_KEY = '/pl/pl/news';
export const PATH_TAG = '_N_T_/[country]/[lang]/news/page';
export const UI_TAG = 'ui:news:pl:pl';
export const CACHE_TAGS_HEADER = 'x-next-cache-tags';

export let FakeRedis: FakeRedisModule;

export type IsrHandler = {
  get: (key: string, ctx: Record<string, unknown>) => Promise<{ lastModified: number; value: unknown } | null>;
  set: (key: string, data: Record<string, unknown> | null, ctx: Record<string, unknown>) => Promise<void>;
  revalidateTag: (tags: string | string[], durations?: { expire?: number }) => Promise<void>;
  resetRequestCache: () => void;
};

export function isrEntryKey(cacheKey: string): string {
  return `isr:entry:${cacheKey}`;
}

export function isrTagKey(tag: string): string {
  return `isr:tag:${tag}`;
}

export function loadIsrHandler(revalidatedTags: string[] = []): IsrHandler {
  jest.resetModules();
  FakeRedis = requireCjs(join(PKG_ROOT, '__tests__/fakeRedis.cjs')) as FakeRedisModule;
  const Handler = requireCjs(join(PKG_ROOT, 'src/isr/handler.ts')).default as new (
    ctx?: { revalidatedTags?: string[] },
  ) => IsrHandler;
  return new Handler({ revalidatedTags });
}

export function makeAppPageValue(overrides: Record<string, unknown> = {}) {
  return {
    kind: 'APP_PAGE',
    html: '<html>news</html>',
    rscData: Buffer.from('rsc-payload'),
    status: 200,
    postponed: undefined,
    headers: {
      [CACHE_TAGS_HEADER]: `${UI_TAG},${PATH_TAG}`,
    },
    segmentData: new Map([['/segment', Buffer.from('seg-bytes')]]),
    ...overrides,
  };
}

export function setupIsrHandlerTests(): void {
  beforeEach(() => {
    process.env.REDIS_HOST = 'fake';
    process.env.REDIS_PORT = '6379';
    process.env.REDIS_DB = '0';
    process.env.REDIS_PASSWORD = 'test';
    delete process.env.NEXT_PHASE;
    FakeRedis = requireCjs(join(PKG_ROOT, '__tests__/fakeRedis.cjs')) as FakeRedisModule;
    FakeRedis.reset();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });
}
