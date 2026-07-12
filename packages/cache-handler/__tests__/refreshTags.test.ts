import { FakeRedis, TAG, handler, setupHandlerTests } from './helpers/testHelpers.js';

setupHandlerTests();

describe('refreshTags', () => {
    test('syncs timestamps from Redis and prunes expired tags', async () => {
        const STALE_TAG = 'data:old:xx:yy';
        FakeRedis.state.sets.set('meta:revalidated-tags', new Set([STALE_TAG, TAG]));
        FakeRedis.state.store.set(`meta:revalidated-at:${TAG}`, Buffer.from('12345'));

        await handler.refreshTags();

        expect(await handler.getExpiration([TAG])).toBe(12345);
        expect(await handler.getExpiration([STALE_TAG])).toBe(0);
        expect(FakeRedis.state.sets.get('meta:revalidated-tags')?.has(STALE_TAG)).toBe(false);
    });
});
