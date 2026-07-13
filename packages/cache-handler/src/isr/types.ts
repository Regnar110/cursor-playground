export type TagRecord = { stale?: number; expired?: number };

export interface StoredEntry {
  lastModified: number;
  value: CacheValue;
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
