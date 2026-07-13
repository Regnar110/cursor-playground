# 06 — Configuration

All configuration is done via environment variables. Integer variables fall back
to their defaults when unset or non-numeric.

## Redis connection

Required for L2 and Pub/Sub. When `REDIS_HOST` or `REDIS_PORT` is missing, the
handler operates in **L1-only** mode (remote) or returns cache misses (ISR).

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REDIS_HOST` | Yes (for Redis) | — | Redis hostname |
| `REDIS_PORT` | Yes (for Redis) | `6379` | Redis port |
| `REDIS_PASSWORD` | No | — | Redis password (omit for local/dev without auth) |
| `REDIS_DB` | No | `0` | Redis database number |
| `REDIS_TLS` | No | — | Set to `true` for TLS connections (managed Redis) |
| `REDIS_CACHE_PREFIX` | No | — | Prefix for all Redis keys (multi-tenant / shared Redis) |

Connection behavior:

- Lazy connect — the first cache operation opens the connection
- Offline queue disabled — commands fail fast instead of piling up
- Max 2 retries per request
- Exponential backoff on reconnect (caps at 2 s, stops after 5 attempts)

After a connection failure the handler stays in L1-only mode for **30 seconds**
(cooldown), then attempts to reconnect on the next operation
(see [01 — Mechanisms](01-mechanisms.md#redis-outage--degradation-not-disaster)).

## Build phase

| Variable | Effect |
|----------|--------|
| `NEXT_PHASE=phase-production-build` | Redis is disabled during the production build (no network cache access) |

## L1 LRU cache

| Variable | Default | Description |
|----------|---------|-------------|
| `REMOTE_CACHE_LRU_MAX_ENTRIES` | `500` | Maximum number of entries in L1 |
| `REMOTE_CACHE_LRU_MAX_SIZE_MB` | `50` | Maximum total size of L1 (megabytes) |
| `REMOTE_CACHE_LRU_TTL_MS` | `15000` | TTL of each L1 entry (milliseconds) |
| `REMOTE_CACHE_LRU_DEFAULT_ENTRY_SIZE_BYTES` | `1024` | Fallback size when an entry's size is unknown |

## Single-flight

| Variable | Default | Description |
|----------|---------|-------------|
| `SINGLE_FLIGHT_LOCK_TTL` | `30` | Render lock TTL in Redis (seconds) |
| `SINGLE_FLIGHT_POLLING_MS` | `100` | Poll interval while waiting for a peer render (ms) |
| `SINGLE_FLIGHT_ATTEMPTS` | `50` | Max poll attempts (~5 s with defaults) |

## Tag metadata

| Variable | Default | Description |
|----------|---------|-------------|
| `TAG_META_TTL_SECONDS` | `604800` (7 days) | TTL of tag invalidation timestamps in Redis (remote handler) and ISR tag records |

## ISR cache handler

Used by `@tme/cache-handler/isr` (`cacheHandler` in Next.js config). See
[07 — ISR cache handler](07-isr-cache-handler.md).

| Variable | Default | Description |
|----------|---------|-------------|
| `ISR_ENTRY_TTL_SECONDS` | `86400` (24 h) | Redis TTL for ISR entries when the route provides no explicit `expire` |
| `ISR_MAX_ENTRY_BYTES` | `4194304` (4 MB) | Max serialized entry size; larger entries are not stored (warn logged) |

## Handler logging

| Variable | Default | Description |
|----------|---------|-------------|
| `CACHE_HANDLER_LOG_LEVEL` | `warn` in production, `info` otherwise | `error`, `warn`, `info`, or `silent` |

Errors are always logged unless the level is `silent`. Warnings include Redis
degradation and ISR oversize skips.

## Debug telemetry

| Variable | Default | Description |
|----------|---------|-------------|
| `REMOTE_CACHE_DEBUG_ENABLED` | `false` | Set to `true` to enable debug logging and Redis debug keys |
| `REMOTE_CACHE_DEBUG_MAX_EVENTS` | `200` | Max in-memory debug events retained per process |
| `HOSTNAME` | — | Debug namespace label; falls back to `local-{pid}` |

## Fixed constants (not env-configurable)

| Constant | Value | Description |
|----------|-------|-------------|
| Revalidated tags set | `meta:revalidated-tags` | Redis set of tags with active invalidation metadata |
| Invalidation channel | `pubsub:invalidate` | Pub/Sub channel for L1 invalidation |
| Redis cooldown | 30 000 ms | L1-only period after a Redis outage |

## Example minimal setup

```bash
export REDIS_HOST=127.0.0.1
export REDIS_PORT=6379
export REDIS_PASSWORD=secret
export REDIS_DB=0
```

Optional tuning for high-traffic deployments:

```bash
export REMOTE_CACHE_LRU_MAX_ENTRIES=1000
export REMOTE_CACHE_LRU_MAX_SIZE_MB=100
export REMOTE_CACHE_LRU_TTL_MS=30000
export SINGLE_FLIGHT_LOCK_TTL=60
```
