# Redis schema

This document describes every Redis key pattern and the Pub/Sub channel used by the handler. All cache keys from the framework are **encoded** before use: colon (`:`) → semicolon (`;`).

Encoding function: `encodeCacheKey()` in `src/handler/redis-keys.ts`.

**Example:** framework key `page:/items:42` → Redis key `page;/items;42`

## Key types

### Entry keys

| Pattern | Type | Description |
|---------|------|-------------|
| `{encodedCacheKey}` | String (binary) | Serialized cache entry (`v8.serialize`); TTL = `max(entry.expire, 60)` seconds |

No prefix. The encoded cache key is the Redis key name.

Payload structure (after deserialize):

- `value` — Buffer (render output)
- `tags`, `stale`, `timestamp`, `expire`, `revalidate` — entry metadata
- `_meta` — optional human-readable block (layer, resource, locale, `createdAt`) for inspection tools

### Render locks (single-flight)

| Pattern | Type | Description |
|---------|------|-------------|
| `lock:{encodedCacheKey}` | String | Lock owner `instanceId`; TTL = `SINGLE_FLIGHT_LOCK_TTL` (default 30 s) |

Set with `SET key instanceId EX ttl NX`. Released with compare-and-delete Lua script (only owner deletes).

### Tag indexes

| Pattern | Type | Description |
|---------|------|-------------|
| `index:{tag}` | Set | Member = encoded entry keys tagged with `{tag}` |

On `set()`, each entry tag adds the entry key to `index:{tag}`. Index TTL follows entry TTL + 60 s buffer, using:

- `EXPIRE key ttl NX` — set TTL only if key has none
- `EXPIRE key ttl GT` — extend TTL only if new value is greater

This prevents a short-lived entry from shortening the index lifetime of longer-lived siblings.

On `updateTags()`, index sets for invalidated tags are deleted.

### Tag invalidation metadata

| Pattern | Type | Description |
|---------|------|-------------|
| `meta:revalidated-at:{tag}` | String | Invalidation timestamp in milliseconds (`Date.now()` at `updateTags`) |
| `meta:revalidated-tags` | Set | All tags that currently have `meta:revalidated-at:*` keys |

TTL for `meta:revalidated-at:{tag}` = `TAG_META_TTL_SECONDS` (default 7 days).

`refreshTags()` reads all members of `meta:revalidated-tags`, loads timestamps, syncs to in-memory map, and removes tags whose metadata key expired.

### Debug keys (optional)

Only written when `REMOTE_CACHE_DEBUG_ENABLED=true`. TTL = 3600 s. Namespace `{debugBox}` = `HOSTNAME` env or `local-{pid}`.

| Pattern | Type | Description |
|---------|------|-------------|
| `meta:debug-events:{debugBox}` | List | JSON debug events (trimmed to max length) |
| `meta:debug-l1:{debugBox}` | Hash | Field = entry key, value = JSON L1 entry snapshot |
| `meta:debug-pending:{debugBox}` | Hash | Field = entry key, value = JSON active render lock info |

See [DEBUG.md](DEBUG.md).

## Pub/Sub

| Channel | Direction | Payload |
|---------|-----------|---------|
| `pubsub:invalidate` | Publish on `updateTags`; subscribe on first cached request | Base64-encoded `v8.serialize({ tags?: string[], keys?: string[] })` |

Subscribers clear L1 entries matching `tags` and delete explicit `keys` from L1.

## Operation matrix

| Operation | Keys affected |
|-----------|---------------|
| `set()` | Entry key, `index:{tag}` for each tag |
| `get()` hit | Read entry key; may write L1 only |
| `get()` miss + lock | `lock:{encodedCacheKey}` |
| `updateTags()` | `meta:revalidated-at:{tag}`, `meta:revalidated-tags`, `index:{tag}`, all indexed entry keys, Pub/Sub message |
| `refreshTags()` | Read `meta:revalidated-tags`, `meta:revalidated-at:*`; may `SREM` expired tags |

## Inspection tips

Use `redis-cli` or a GUI to inspect keys:

```bash
# List tag indexes
redis-cli SMEMBERS index:data:resource:42

# Check invalidation time for a tag
redis-cli GET meta:revalidated-at:data:resource:42

# Monitor invalidation traffic
redis-cli SUBSCRIBE pubsub:invalidate
```

Remember: entry keys use `;` instead of `:` in the stored name.

## Related documents

- [ARCHITECTURE.md](ARCHITECTURE.md) — when each key is read or written
- [INVALIDATION.md](INVALIDATION.md) — tag invalidation flow
- [CONFIGURATION.md](CONFIGURATION.md) — TTL env vars
