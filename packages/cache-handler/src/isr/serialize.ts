import type { CacheValue, SerializedValue } from './types.js';

function toBase64(buffer: unknown): string | undefined {
  return Buffer.isBuffer(buffer) ? buffer.toString('base64') : undefined;
}

function fromBase64(value: unknown): Buffer | undefined {
  return typeof value === 'string' ? Buffer.from(value, 'base64') : undefined;
}

/** Converts an IncrementalCacheValue into a JSON-safe shape for Redis storage. */
export function serializeValue(value: CacheValue): SerializedValue {
  switch (value.kind) {
    case 'APP_PAGE': {
      const segmentData = value.segmentData as Map<string, Buffer> | undefined;
      return {
        ...value,
        rscData: toBase64(value.rscData),
        segmentData: segmentData
          ? Object.fromEntries([...segmentData].map(([path, buf]) => [path, buf.toString('base64')]))
          : undefined,
      };
    }
    case 'APP_ROUTE':
      return { ...value, body: toBase64(value.body) };
    case 'IMAGE':
      return { ...value, buffer: toBase64(value.buffer) };
    default:
      return value;
  }
}

/** Restores Buffers/Maps in an entry read back from Redis. */
export function deserializeValue(value: SerializedValue): CacheValue {
  switch (value.kind) {
    case 'APP_PAGE': {
      const segments = value.segmentData as Record<string, string> | undefined;
      return {
        ...value,
        rscData: fromBase64(value.rscData),
        segmentData: segments
          ? new Map(Object.entries(segments).map(([path, b64]) => [path, Buffer.from(b64, 'base64')]))
          : undefined,
      };
    }
    case 'APP_ROUTE':
      return { ...value, body: fromBase64(value.body) };
    case 'IMAGE':
      return { ...value, buffer: fromBase64(value.buffer) };
    default:
      return value;
  }
}
