export interface CacheEntry {
  value: ReadableStream<Uint8Array>;
  tags: string[];
  stale: number;
  timestamp: number;
  expire: number;
  revalidate: number;
}

/** Internal LRU / Redis representation with buffered payload. */
export interface StoredEntry extends CacheEntry {
  _buffer?: Buffer;
  _size?: number;
}

export type CacheLayer = "DATA" | "UI" | "SOFT" | "DATA+UI";

export interface DebugEventFields {
  [key: string]: string | number | boolean | string[] | null | undefined;
}

export interface DebugEvent {
  ts: number;
  op: string;
  outcome: string;
  summary: string;
  fields?: DebugEventFields;
  instanceId?: string;
  debugBox?: string;
}

export interface CacheHandler {
  get(cacheKey: string, softTags: string[]): Promise<CacheEntry | undefined>;
  set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void>;
  refreshTags(): Promise<void>;
  getExpiration(tags: string[]): Promise<number>;
  updateTags(tags: string[], durations?: { expire?: number }): Promise<void>;
}
