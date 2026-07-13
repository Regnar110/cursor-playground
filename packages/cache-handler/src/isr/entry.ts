import { deserialize, serialize } from 'node:v8';
import type { CacheValue } from './types.js';

/** Payload stored in Redis for one ISR incremental-cache entry. */
export interface IsrStoredPayload {
  lastModified: number;
  value: CacheValue;
}

/**
 * Binary ISR entry encoding — same approach as the remote handler (`lib/entry.ts`).
 * `v8.serialize` preserves Buffer/Map natively and avoids JSON+base64 inflation.
 */
export function serializeStoredEntry(lastModified: number, value: CacheValue): Buffer {
  return serialize({ lastModified, value });
}

export function deserializeStoredEntry(raw: Buffer): IsrStoredPayload {
  const buffer = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);

  try {
    return deserialize(buffer) as IsrStoredPayload;
  } catch {
    const legacy = deserializeLegacyJson(buffer);
    if (legacy) {
      return legacy;
    }
    throw new Error('ISR entry is neither v8-serialized nor legacy JSON');
  }
}

/** Reads pre-v8 JSON entries ({ lastModified, value with base64 fields }). */
function deserializeLegacyJson(raw: Buffer): IsrStoredPayload | null {
  try {
    const text = raw.toString('utf8');
    if (!text.startsWith('{')) {
      return null;
    }

    const parsed = JSON.parse(text) as { lastModified: number; value: Record<string, unknown> };
    return {
      lastModified: parsed.lastModified,
      value: restoreLegacyValue(parsed.value),
    };
  } catch {
    return null;
  }
}

function fromBase64(value: unknown): Buffer | undefined {
  return typeof value === 'string' ? Buffer.from(value, 'base64') : undefined;
}

function restoreLegacyValue(value: Record<string, unknown>): CacheValue {
  switch (value.kind) {
    case 'APP_PAGE': {
      const segments = value.segmentData as Record<string, string> | undefined;
      return {
        ...value,
        kind: 'APP_PAGE',
        rscData: fromBase64(value.rscData),
        segmentData: segments
          ? new Map(Object.entries(segments).map(([path, b64]) => [path, Buffer.from(b64, 'base64')]))
          : undefined,
      } as CacheValue;
    }
    case 'APP_ROUTE':
      return {
        ...value,
        kind: 'APP_ROUTE',
        body: fromBase64(value.body),
      } as CacheValue;
    case 'IMAGE':
      return {
        ...value,
        kind: 'IMAGE',
        buffer: fromBase64(value.buffer),
      } as CacheValue;
    default:
      return { ...value, kind: String(value.kind ?? 'UNKNOWN') } as CacheValue;
  }
}
