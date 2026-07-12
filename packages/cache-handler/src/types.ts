export interface CacheEntry {
  expire: number;
  revalidate: number;
  stale: number;
  tags: string[];
  timestamp: number;
  value: ReadableStream<Uint8Array>;
}

/** Internal LRU / Redis representation with buffered payload. */
export interface StoredEntry extends CacheEntry {
  _buffer?: Buffer;
  _size?: number;
}

export type CacheLayer = 'DATA' | 'DATA+UI' | 'SOFT' | 'UI';

export interface DebugEventFields {
  [key: string]: boolean | null | number | string | string[] | undefined;
}

export interface DebugEvent {
  debugBox?: string;
  fields?: DebugEventFields;
  instanceId?: string;
  op: string;
  outcome: string;
  summary: string;
  ts: number;
}

export interface CacheHandler {
  get(cacheKey: string, softTags: string[]): Promise<CacheEntry | undefined>;
  getExpiration(tags: string[]): Promise<number>;
  refreshTags(): Promise<void>;
  set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void>;
  updateTags(tags: string[], durations?: { expire?: number }): Promise<void>;
}
