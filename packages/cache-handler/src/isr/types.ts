export type TagRecord = { stale?: number; expired?: number };

/** IncrementalCacheValue with Buffers/Maps replaced by base64/plain objects. */
export type SerializedValue = Record<string, unknown> & { kind: string };

export interface StoredEntry {
  lastModified: number;
  value: SerializedValue;
}

export interface HandlerContext {
  revalidatedTags?: string[];
}

export interface GetContext {
  kind: string;
  tags?: string[];
  softTags?: string[];
}

export interface SetContext {
  fetchCache?: boolean;
  tags?: string[];
  cacheControl?: { revalidate?: number | false; expire?: number };
}

export type CacheValue = Record<string, unknown> & { kind: string };
