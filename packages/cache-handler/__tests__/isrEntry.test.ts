import { PATH_TAG, UI_TAG, makeAppPageValue } from './helpers/isrTestHelpers.js';
import { deserializeStoredEntry, serializeStoredEntry } from '../src/isr/entry.js';
import { areTagsExpired, tagsFromEntry } from '../src/isr/tags.js';

describe('ISR entry serialization', () => {
  test('serializeStoredEntry and deserializeStoredEntry roundtrip APP_PAGE buffers', () => {
    const original = makeAppPageValue();
    const payload = serializeStoredEntry(Date.now(), original);
    const restored = deserializeStoredEntry(payload);

    expect(restored.value.rscData).toEqual(Buffer.from('rsc-payload'));
    expect((restored.value.segmentData as Map<string, Buffer>).get('/segment')).toEqual(
      Buffer.from('seg-bytes'),
    );
  });

  test('tagsFromEntry reads x-next-cache-tags header', () => {
    const tags = tagsFromEntry(makeAppPageValue());
    expect(tags).toEqual([UI_TAG, PATH_TAG]);
  });

  test('deserializeStoredEntry reads legacy JSON entries', () => {
    const legacy = JSON.stringify({
      lastModified: 1_000,
      value: {
        kind: 'APP_PAGE',
        html: '<html>news</html>',
        rscData: Buffer.from('rsc-payload').toString('base64'),
        status: 200,
        headers: { 'x-next-cache-tags': `${UI_TAG},${PATH_TAG}` },
      },
    });

    const restored = deserializeStoredEntry(Buffer.from(legacy, 'utf8'));
    expect(restored.lastModified).toBe(1_000);
    expect(restored.value.rscData).toEqual(Buffer.from('rsc-payload'));
  });

  test('areTagsExpired hides entry when tag invalidated after write', () => {
    const entryTime = 1000;
    const records = [{ expired: 2000 }];
    expect(areTagsExpired(records, entryTime)).toBe(true);
  });

  test('areTagsExpired keeps entry when written after invalidation', () => {
    const entryTime = 3000;
    const records = [{ expired: 2000 }];
    expect(areTagsExpired(records, entryTime)).toBe(false);
  });
});
