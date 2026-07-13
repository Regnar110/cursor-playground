import {
  FakeRedis,
  PAGE_KEY,
  isrEntryKey,
  loadIsrHandler,
  makeAppPageValue,
  setupIsrHandlerTests,
  type IsrHandler,
} from './helpers/isrTestHelpers.js';

setupIsrHandlerTests();

describe('ISR handler — get / set', () => {
  let handler: IsrHandler;

  beforeEach(() => {
    handler = loadIsrHandler();
  });

  test('returns null on cache miss', async () => {
    const result = await handler.get(PAGE_KEY, { kind: 'APP_PAGE' });
    expect(result).toBeNull();
  });

  test('roundtrips APP_PAGE entry through Redis', async () => {
    const value = makeAppPageValue();
    await handler.set(PAGE_KEY, value, { cacheControl: { expire: 3600 } });

    expect(FakeRedis.state.store.has(isrEntryKey(PAGE_KEY))).toBe(true);
    expect(FakeRedis.state.ttls.get(isrEntryKey(PAGE_KEY))).toBe(3600);

    const result = await handler.get(PAGE_KEY, { kind: 'APP_PAGE' });
    expect(result).not.toBeNull();
    expect(result!.value).toMatchObject({
      kind: 'APP_PAGE',
      html: '<html>news</html>',
      status: 200,
    });
    expect((result!.value as { rscData: Buffer }).rscData).toEqual(Buffer.from('rsc-payload'));
    const segments = (result!.value as { segmentData: Map<string, Buffer> }).segmentData;
    expect(segments.get('/segment')).toEqual(Buffer.from('seg-bytes'));
  });

  test('another handler instance reads the same entry from Redis', async () => {
    await handler.set(PAGE_KEY, makeAppPageValue(), { cacheControl: { expire: 3600 } });

    const handlerB = loadIsrHandler();
    const result = await handlerB.get(PAGE_KEY, { kind: 'APP_PAGE' });

    expect(result).not.toBeNull();
    expect((result!.value as { html: string }).html).toBe('<html>news</html>');
  });

  test('set(null) deletes the entry', async () => {
    await handler.set(PAGE_KEY, makeAppPageValue(), { cacheControl: { expire: 3600 } });
    await handler.set(PAGE_KEY, null, {});

    expect(FakeRedis.state.store.has(isrEntryKey(PAGE_KEY))).toBe(false);
    expect(await handler.get(PAGE_KEY, { kind: 'APP_PAGE' })).toBeNull();
  });

  test('uses ISR_ENTRY_TTL_SECONDS when route provides no expire', async () => {
    process.env.ISR_ENTRY_TTL_SECONDS = '7200';
    handler = loadIsrHandler();

    await handler.set(PAGE_KEY, makeAppPageValue(), {});

    expect(FakeRedis.state.ttls.get(isrEntryKey(PAGE_KEY))).toBe(7200);
    delete process.env.ISR_ENTRY_TTL_SECONDS;
  });

  test('returns null when Redis is unavailable', async () => {
    FakeRedis.state.failConnect = true;
    handler = loadIsrHandler();

    expect(await handler.get(PAGE_KEY, { kind: 'APP_PAGE' })).toBeNull();
  });

  test('skips set when serialized entry exceeds ISR_MAX_ENTRY_BYTES', async () => {
    process.env.ISR_MAX_ENTRY_BYTES = '100';
    handler = loadIsrHandler();

    await handler.set(
      PAGE_KEY,
      makeAppPageValue({ html: '<html>' + 'x'.repeat(500) + '</html>' }),
      { cacheControl: { expire: 3600 } },
    );

    expect(FakeRedis.state.store.has(isrEntryKey(PAGE_KEY))).toBe(false);
    delete process.env.ISR_MAX_ENTRY_BYTES;
  });
});
