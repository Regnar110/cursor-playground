# API reference

The package exports a **default** `CacheHandler` object implementing the remote cache handler contract expected by Next.js Cache Components.

```js
import remoteHandler from "@tme/cache-handler";
```

Type definitions are emitted to `dist/remote-handler.d.ts`. The handler is also assignable to the `CacheHandler` interface in `src/types.ts` (internal source; not re-exported from the package entry today).

## CacheHandler

### `get(cacheKey, softTags)`

```typescript
get(cacheKey: string, softTags: string[]): Promise<CacheEntry | undefined>
```

**Parameters**

| Name | Type | Description |
|------|------|-------------|
| `cacheKey` | `string` | Framework-generated cache key for the entry |
| `softTags` | `string[]` | Additional tags checked for invalidation without being stored on the entry |

**Returns**

- `CacheEntry` when a fresh entry is found in L1 or L2
- `undefined` on cache miss (framework will render and call `set()`)

**Side effects**

- Ensures Pub/Sub subscriber is connected
- May promote L2 hits to L1
- May acquire a single-flight render lock on miss
- May poll Redis while waiting for another instance

---

### `set(cacheKey, pendingEntry)`

```typescript
set(cacheKey: string, pendingEntry: Promise<CacheEntry>): Promise<void>
```

**Parameters**

| Name | Type | Description |
|------|------|-------------|
| `cacheKey` | `string` | Same key passed to `get()` |
| `pendingEntry` | `Promise<CacheEntry>` | Promise resolving to the rendered cache entry |

**Side effects**

- Blocks concurrent `get()` for the same key until complete
- Writes to L1; writes to Redis when available
- Updates tag index sets in Redis
- Releases single-flight render lock

Errors during set are logged; the pending promise is always settled in `finally`.

---

### `refreshTags()`

```typescript
refreshTags(): Promise<void>
```

Synchronizes local invalidation timestamps from Redis (`meta:revalidated-at:*`) before a request. Removes expired tag metadata from the local map and from `meta:revalidated-tags`.

No-op when Redis is unavailable.

---

### `getExpiration(tags)`

```typescript
getExpiration(tags: string[]): Promise<number>
```

**Returns** the maximum invalidation timestamp (ms) among the given tags from the in-memory map, or `0` if none are known.

Used by the framework to determine cache expiration context. Does not call Redis directly; call `refreshTags()` first for up-to-date values.

---

### `updateTags(tags, durations?)`

```typescript
updateTags(
  tags: string[],
  durations?: { expire?: number }
): Promise<void>
```

Invalidates all entries associated with the given tags.

**Parameters**

| Name | Type | Description |
|------|------|-------------|
| `tags` | `string[]` | Tags to invalidate |
| `durations` | `{ expire?: number }` | Reserved; currently unused |

**Side effects**

- Updates local tag timestamps to `Date.now()`
- Clears matching L1 entries on this instance
- Deletes indexed Redis entries and tag index sets
- Writes `meta:revalidated-at:{tag}` for each tag
- Publishes Pub/Sub invalidation message

When Redis is unavailable, only local L1 and timestamps are updated; Pub/Sub is skipped but local publish hook still runs for in-process subscribers.

See [INVALIDATION.md](INVALIDATION.md) for the full invalidation pipeline.

---

## CacheEntry

Shape of a cache entry as exchanged with the framework:

```typescript
interface CacheEntry {
  value: ReadableStream<Uint8Array>;
  tags: string[];
  stale: number;
  timestamp: number;   // creation time (ms)
  expire: number;      // Redis TTL hint (seconds)
  revalidate: number;  // soft expiry window (seconds)
}
```

| Field | Description |
|-------|-------------|
| `value` | Serialized render output |
| `tags` | Hard tags stored with the entry; used for invalidation indexing |
| `stale` | Framework stale marker |
| `timestamp` | When the entry was created; compared against tag invalidation times |
| `expire` | Minimum Redis key TTL is `max(expire, 60)` seconds |
| `revalidate` | Entry is expired when `now > timestamp + revalidate * 1000` |

Internally, the handler may attach `_buffer` and `_size` (`StoredEntry`) for L1 storage; these are not returned from `get()`.

## Error handling

All handler methods catch errors, log to stderr with the `[remote-cache-handler]` prefix, and degrade safely:

- `get()` → `undefined` (miss)
- `set()` → entry may remain in L1 only
- Tag methods → local effects may still apply

## Related documents

- [ARCHITECTURE.md](ARCHITECTURE.md) — read/write flows
- [INVALIDATION.md](INVALIDATION.md) — tag semantics
- [CONFIGURATION.md](CONFIGURATION.md) — environment variables
