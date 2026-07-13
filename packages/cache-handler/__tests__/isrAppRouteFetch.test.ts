import { loadIsrHandler, setupIsrHandlerTests, type IsrHandler } from './helpers/isrTestHelpers.js';

setupIsrHandlerTests();

describe('ISR handler — APP_ROUTE and FETCH', () => {
  let handler: IsrHandler;

  beforeEach(() => {
    handler = loadIsrHandler();
  });

  test('roundtrips APP_ROUTE body buffer', async () => {
    const routeKey = '/api/health';
    const value = {
      kind: 'APP_ROUTE',
      body: Buffer.from('{"ok":true}'),
      status: 200,
      headers: { 'content-type': 'application/json' },
    };

    await handler.set(routeKey, value, { cacheControl: { expire: 60 } });
    const result = await handler.get(routeKey, { kind: 'APP_ROUTE' });

    expect(result).not.toBeNull();
    expect((result!.value as { body: Buffer }).body).toEqual(Buffer.from('{"ok":true}'));
  });

  test('FETCH entry stores tags and validates them on get', async () => {
    const fetchKey = 'fetch:products';
    const tag = 'data:products';
    let now = 1_000;
    jest.spyOn(Date, 'now').mockImplementation(() => now);

    await handler.set(
      fetchKey,
      { kind: 'FETCH', data: { body: '[]', headers: {}, url: 'https://example.com' }, revalidate: 3600 },
      { fetchCache: true, tags: [tag] },
    );

    const hit = await handler.get(fetchKey, { kind: 'FETCH', tags: [tag], softTags: [] });
    expect(hit).not.toBeNull();

    now = 2_000;
    await handler.revalidateTag(tag);
    const miss = await handler.get(fetchKey, { kind: 'FETCH', tags: [tag], softTags: [] });
    expect(miss).toBeNull();
  });

  test('FETCH miss when tag was revalidated earlier in the same request', async () => {
    const fetchKey = 'fetch:news';
    const tag = 'data:news';

    await handler.set(
      fetchKey,
      { kind: 'FETCH', data: { body: '[]', headers: {}, url: 'https://example.com' }, revalidate: 3600 },
      { fetchCache: true, tags: [tag] },
    );

    const handlerWithRevalidated = loadIsrHandler([tag]);
    const result = await handlerWithRevalidated.get(fetchKey, { kind: 'FETCH', tags: [tag], softTags: [] });
    expect(result).toBeNull();
  });
});
