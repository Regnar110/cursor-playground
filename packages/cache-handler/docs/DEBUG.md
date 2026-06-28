# Debug telemetry

Optional write-only observability for cache operations. **Disabled by default** — when off, `log()` is a no-op and no debug state is retained.

Enable:

```bash
export REMOTE_CACHE_DEBUG_ENABLED=true
```

Implementation: `src/cache-debug.ts`

## Outputs

| Sink | Content |
|------|---------|
| **stderr** | Multi-line formatted event blocks (`console.log`) |
| **Redis** | Lists and hashes under `meta:debug-*` (see [REDIS-SCHEMA.md](REDIS-SCHEMA.md)) |

Debug Redis writes use TTL 3600 s. Failures are swallowed (never affect cache behavior).

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `REMOTE_CACHE_DEBUG_ENABLED` | `false` | Master switch |
| `REMOTE_CACHE_DEBUG_MAX_EVENTS` | `200` | In-memory ring buffer size per process |
| `HOSTNAME` | — | Groups debug keys; default `local-{pid}` |

## Event format

Each event has:

| Field | Description |
|-------|-------------|
| `op` | Operation category |
| `outcome` | Result category |
| `summary` | Human-readable one-liner |
| `fields` | Optional key/value context |
| `ts` | Timestamp (ms) |

### Operations (`op`)

| op | When |
|----|------|
| `GET` | Cache read |
| `SET` | Cache write after render |
| `REFRESH` | `refreshTags()` |
| `INVALIDATE` | `updateTags()` |
| `PUBSUB` | L1 cleanup from Pub/Sub message |
| `REDIS` | Connection lifecycle |
| `WAIT` | Single-flight polling |

### Outcomes (`outcome`)

| outcome | Meaning |
|---------|---------|
| `HIT` | Entry returned |
| `MISS` | No entry; framework renders |
| `STALE` | Entry rejected |
| `WRITE` | Entry stored |
| `SYNC` | Timestamps synchronized |
| `CLEAR` | L1 entries removed |
| `ACQUIRED` | Render lock acquired |
| `RELEASED` | Render lock released |
| `WAIT` | Waiting for peer instance |
| `END` | Redis connection ended |

## Example stderr block

```
┌─ cache GET ─ HIT ─────────────────────────
│  Returned fresh entry from L1 (in-process LRU)
│  layer: L1
│  key: page;/items;42
│  tags: data:resource:42
│  age: 2.3 s
│  at 2026-06-28T12:00:00.000Z
└────────────────────────────────────────────────────────
```

## Redis debug keys

Namespace `{debugBox}` = `HOSTNAME` or `local-{pid}`:

| Key | Structure |
|-----|-----------|
| `meta:debug-events:{debugBox}` | List of JSON events (RPUSH + LTRIM) |
| `meta:debug-l1:{debugBox}` | Hash of L1 entry snapshots |
| `meta:debug-pending:{debugBox}` | Hash of active render locks |

### Inspecting events

```bash
redis-cli LRANGE meta:debug-events:my-host -10 -1
redis-cli HGETALL meta:debug-l1:my-host
```

## Cache layer classification

When debug is enabled, entries may include a `cacheLayer` field derived from tag prefixes:

| Layer | Condition |
|-------|-----------|
| `DATA` | Tag starts with `data:` |
| `UI` | Tag starts with `ui:` |
| `SOFT` | Soft tags only |
| `DATA+UI` | Both data and ui tags |

Classification is for telemetry only; it does not affect cache logic.

## Stale reason descriptions

On `STALE` outcomes, debug logs include a human-readable reason from `describeStaleReason()`:

- Revalidate window exceeded
- Hard tag invalidated after entry creation
- Soft tag invalidated after entry creation

## Performance

When `REMOTE_CACHE_DEBUG_ENABLED` is not `true`:

- No event array allocation
- No Redis debug writes
- No snapshot provider registration overhead beyond a boolean check in `log()`

## Related documents

- [ARCHITECTURE.md](ARCHITECTURE.md) — operations being logged
- [CONFIGURATION.md](CONFIGURATION.md) — env var reference
- [REDIS-SCHEMA.md](REDIS-SCHEMA.md) — debug key patterns
