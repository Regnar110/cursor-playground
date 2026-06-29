# Documentation index

Package-scoped technical documentation for `@tme/cache-handler`. All paths are relative to this package root.

## Reading order

1. [../README.md](../README.md) — install, integration, capabilities
2. [ARCHITECTURE.md](ARCHITECTURE.md) — L1/L2, `get`/`set`, single-flight, Pub/Sub (start here for internals)
3. [INVALIDATION.md](INVALIDATION.md) — tags, `updateTags`, timestamp backstop
4. [API.md](API.md) — `CacheHandler` contract
5. [CONFIGURATION.md](CONFIGURATION.md) — environment variables
6. [REDIS-SCHEMA.md](REDIS-SCHEMA.md) — Redis keys and channel
7. [DEBUG.md](DEBUG.md) — optional telemetry
8. [DEVELOPMENT.md](DEVELOPMENT.md) — build, tests, source map

## By document type (Divio)

| Type | Documents | Use when |
|------|-----------|----------|
| **Explanation** | [ARCHITECTURE.md](ARCHITECTURE.md) | Understanding design and control flows |
| **How-to** | [INVALIDATION.md](INVALIDATION.md) | Invalidating entries by cache tag (`updateTags`) |
| **Reference** | [API.md](API.md), [CONFIGURATION.md](CONFIGURATION.md), [REDIS-SCHEMA.md](REDIS-SCHEMA.md) | Lookup signatures, env vars, key names |
| **Reference (ops)** | [DEBUG.md](DEBUG.md), [DEVELOPMENT.md](DEVELOPMENT.md) | Troubleshooting and contributing |

## Glossary

| Term | Meaning |
|------|---------|
| **L1** | In-process LRU cache (`lru-cache`); per-instance |
| **L2** | Redis string entries; shared across instances |
| **Hard tag** | Cache tag on `entry.tags` (from Next.js `cacheTag()`); indexed in Redis `index:{tag}` |
| **Soft tag** | Cache tag passed to `get(cacheKey, softTags)`; staleness check only, not indexed on `set` |
| **Cache key** | Framework-provided string; encoded (`:` → `;`) for Redis entry/lock keys |
| **Single-flight** | One instance renders on miss; other instances poll L2 via render lock |
| **Backstop** | `meta:revalidated-at:{tag}` — rejects stale reads if Pub/Sub missed |
| **Miss** | `get()` returns `undefined` — framework renders and calls `set()` |
| **Stale** | Entry exists but fails `isEntryFresh()` — treated as miss, not returned |

## Diagram index

| Topic | Location |
|-------|----------|
| System context | [ARCHITECTURE.md § System context](ARCHITECTURE.md#system-context) |
| Freshness / staleness | [ARCHITECTURE.md § Freshness model](ARCHITECTURE.md#freshness-model) |
| `get()` flow | [ARCHITECTURE.md § get](ARCHITECTURE.md#get--control-flow) |
| `set()` flow | [ARCHITECTURE.md § set](ARCHITECTURE.md#set--control-flow) |
| Single-flight | [ARCHITECTURE.md § Single-flight](ARCHITECTURE.md#single-flight-render-deduplication) |
| Pub/Sub L1 clear | [ARCHITECTURE.md § Pub/Sub](ARCHITECTURE.md#pubsub-invalidation) |
| Tag timestamp backstop | [ARCHITECTURE.md § Backstop](ARCHITECTURE.md#tag-timestamp-backstop) |
| `updateTags()` sequence | [INVALIDATION.md § Invalidation flow](INVALIDATION.md#invalidation-flow) |
| Pub/Sub vs timestamps | [INVALIDATION.md § comparison](INVALIDATION.md#pubsub-vs-timestamps) |
| Redis key taxonomy | [REDIS-SCHEMA.md § Key types](REDIS-SCHEMA.md#key-types) |

## Conventions

- English; technical tone; behavior must match `src/` and `__tests__/`.
- Diagrams: mermaid in architecture and invalidation docs.
- No application-specific paths — package scope only.

### Vocabulary (cache tags)

Use **Next.js / handler terminology** consistently. Do **not** use synonyms that suggest a different concept.

| Use | Do not use |
|-----|------------|
| **tag** | label, group, category, bucket, marker |
| **hard tag** (`entry.tags`) | stored label, entry label, indexed label |
| **soft tag** (`get(..., softTags)`) | extra label, runtime label |
| **invalidate** / **`updateTags(tags)`** | clear by label, bust cache group |
| **revalidate** (`entry.revalidate`, seconds) | tag TTL, label expiry |
| **tag index** (`index:{tag}`) | label index, tag registry |
| **Pub/Sub publish** | broadcast, notify, message bus |
| **other instance(s)** | peer (unless quoting code comments) |

Tags are the same strings Next.js attaches via **`cacheTag()`** on cached functions/components and passes on `CacheEntry.tags`. This handler treats them as opaque strings; matching is exact.
