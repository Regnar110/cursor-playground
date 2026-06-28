# Configuration

All configuration is via environment variables. Integer variables fall back to defaults when unset or non-numeric.

## Redis connection

Required for L2 and Pub/Sub. When `REDIS_HOST` is missing, the handler operates in **L1-only** mode.

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `REDIS_HOST` | Yes (for Redis) | — | Redis hostname |
| `REDIS_PORT` | Yes (for Redis) | `6379` | Redis port |
| `REDIS_PASSWORD` | Yes (for Redis) | — | Redis password |
| `REDIS_DB` | No | `0` | Redis database number |

Connection options (`src/handler/redis-client.ts`):

- Lazy connect
- Offline queue disabled
- Max 2 retries per request
- Exponential backoff retry strategy (caps at 2 s, stops after 5 attempts)

After a connection failure or `end` event, Redis is unavailable for **30 seconds** (`REDIS_COOLDOWN_MS`), then reconnect is attempted on the next operation.

## Build phase

| Variable | Effect |
|----------|--------|
| `NEXT_PHASE=phase-production-build` | Redis disabled during production build (no network cache access) |

## L1 LRU cache

Configured in `src/handler/state.ts`.

| Variable | Default | Description |
|----------|---------|-------------|
| `REMOTE_CACHE_LRU_MAX_ENTRIES` | `500` | Maximum number of entries in L1 |
| `REMOTE_CACHE_LRU_MAX_SIZE_MB` | `50` | Maximum total size of L1 (megabytes) |
| `REMOTE_CACHE_LRU_TTL_MS` | `15000` | TTL of each L1 entry (milliseconds) |
| `REMOTE_CACHE_LRU_DEFAULT_ENTRY_SIZE_BYTES` | `1024` | Fallback size when entry size is unknown |

## Single-flight

Configured in `src/handler/config.ts`.

| Variable | Default | Description |
|----------|---------|-------------|
| `SINGLE_FLIGHT_LOCK_TTL` | `30` | Render lock TTL in Redis (seconds) |
| `SINGLE_FLIGHT_POLLING_MS` | `100` | Poll interval while waiting for peer render (ms) |
| `SINGLE_FLIGHT_ATTEMPTS` | `50` | Max poll attempts (~5 s with defaults) |

## Tag metadata

| Variable | Default | Description |
|----------|---------|-------------|
| `TAG_META_TTL_SECONDS` | `604800` (7 days) | TTL for `meta:revalidated-at:{tag}` keys |

## Debug telemetry

See [DEBUG.md](DEBUG.md) for full details.

| Variable | Default | Description |
|----------|---------|-------------|
| `REMOTE_CACHE_DEBUG_ENABLED` | `false` | Set to `true` to enable debug logging and Redis debug keys |
| `REMOTE_CACHE_DEBUG_MAX_EVENTS` | `200` | Max in-memory debug events retained per process |
| `HOSTNAME` | — | Debug namespace label; falls back to `local-{pid}` |

## Constants (not env-configurable)

Defined in `src/handler/config.ts`:

| Constant | Value | Description |
|----------|-------|-------------|
| `REVALIDATED_TAGS_SET` | `meta:revalidated-tags` | Redis set of tags with active invalidation metadata |
| `INVALIDATE_CHANNEL` | `pubsub:invalidate` | Pub/Sub channel for L1 invalidation |
| `REDIS_COOLDOWN_MS` | `30000` | Cooldown after Redis outage |

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

## Related documents

- [ARCHITECTURE.md](ARCHITECTURE.md) — how settings affect runtime behavior
- [DEBUG.md](DEBUG.md) — debug env vars in depth
- [REDIS-SCHEMA.md](REDIS-SCHEMA.md) — keys affected by tag TTL
