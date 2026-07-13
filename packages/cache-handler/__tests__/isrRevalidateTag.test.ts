import {
  FakeRedis,
  PAGE_KEY,
  PATH_TAG,
  UI_TAG,
  isrEntryKey,
  isrTagKey,
  loadIsrHandler,
  makeAppPageValue,
  setupIsrHandlerTests,
  type IsrHandler,
} from './helpers/isrTestHelpers.js';

setupIsrHandlerTests();

describe('ISR handler — revalidateTag', () => {
  let handler: IsrHandler;

  beforeEach(() => {
    handler = loadIsrHandler();
  });

  test('hides page entry invalidated after it was written', async () => {
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    await handler.set(PAGE_KEY, makeAppPageValue(), { cacheControl: { expire: 3600 } });
    expect(await handler.get(PAGE_KEY, { kind: 'APP_PAGE' })).not.toBeNull();

    now = 2_000;
    await handler.revalidateTag(PATH_TAG);

    expect(FakeRedis.state.store.has(isrTagKey(PATH_TAG))).toBe(true);
    const tagRaw = FakeRedis.state.store.get(isrTagKey(PATH_TAG));
    expect(JSON.parse(String(tagRaw))).toMatchObject({ expired: 2_000 });
    expect(FakeRedis.state.ttls.get(isrTagKey(PATH_TAG))).toBe(7 * 24 * 60 * 60);

    expect(await handler.get(PAGE_KEY, { kind: 'APP_PAGE' })).toBeNull();
  });

  test('entry written after tag invalidation remains visible', async () => {
    await handler.revalidateTag(PATH_TAG);
    await new Promise((r) => setTimeout(r, 5));
    await handler.set(PAGE_KEY, makeAppPageValue(), { cacheControl: { expire: 3600 } });

    expect(await handler.get(PAGE_KEY, { kind: 'APP_PAGE' })).not.toBeNull();
  });

  test('revalidateTag with durations sets stale and delayed expire', async () => {
    const before = Date.now();
    await handler.revalidateTag(UI_TAG, { expire: 120 });

    const record = JSON.parse(String(FakeRedis.state.store.get(isrTagKey(UI_TAG))));
    expect(record.stale).toBeGreaterThanOrEqual(before);
    expect(record.expired).toBeGreaterThanOrEqual(before + 120_000);
  });

  test('does not delete the entry key on revalidateTag', async () => {
    await handler.set(PAGE_KEY, makeAppPageValue(), { cacheControl: { expire: 3600 } });
    await handler.revalidateTag(PATH_TAG);

    expect(FakeRedis.state.store.has(isrEntryKey(PAGE_KEY))).toBe(true);
  });
});
