import { PATH_TAG, UI_TAG, makeAppPageValue } from './helpers/isrTestHelpers.js';
import { deserializeValue, serializeValue } from '../src/isr/serialize.js';
import { areTagsExpired, tagsFromEntry } from '../src/isr/tags.js';

describe('ISR serialize / tags helpers', () => {
  test('serializeValue and deserializeValue roundtrip APP_PAGE buffers', () => {
    const original = makeAppPageValue();
    const serialized = serializeValue(original);
    const restored = deserializeValue(serialized);

    expect(restored.rscData).toEqual(Buffer.from('rsc-payload'));
    expect((restored.segmentData as Map<string, Buffer>).get('/segment')).toEqual(Buffer.from('seg-bytes'));
  });

  test('tagsFromEntry reads x-next-cache-tags header', () => {
    const tags = tagsFromEntry(serializeValue(makeAppPageValue()));
    expect(tags).toEqual([UI_TAG, PATH_TAG]);
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
