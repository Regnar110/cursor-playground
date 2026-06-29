# Architecture

This document describes the internal design of `@tme/cache-handler`: how cache reads and writes flow through L1 (in-process LRU) and L2 (Redis), how multiple instances coordinate, and how the handler behaves when Redis is unavailable.

For tag invalidation in depth, see [INVALIDATION.md](INVALIDATION.md). For Redis key names, see [REDIS-SCHEMA.md](REDIS-SCHEMA.md).

## System context

Next.js calls the handler on each cache read and write. The handler sits between the framework and two storage layers: a per-process LRU (L1) and a shared Redis store (L2). Pub/Sub keeps L1 consistent across instances when tags are invalidated.

```mermaid
flowchart LR
    subgraph Next["Next.js Cache Components"]
        FW["Framework"]
    end
    subgraph Instance["Node.js instance"]
        Handler["CacheHandler"]
        L1["L1: in-process LRU"]
        Sub["Pub/Sub subscriber"]
    end
    R[("L2: Redis")]
    PS(("pubsub:invalidate"))

    FW -->|"get / set / updateTags"| Handler
    Handler --> L1
    L1 -- miss --> R
    R -- hit --> L1
    Handler --> R
    R --- PS
    PS -- invalidation --> Sub
    Sub --> L1
```

| Layer | Location | Role | Survives process restart |
|-------|----------|------|--------------------------|
| L1 | Process memory | Avoid Redis round-trips for hot keys | No |
| L2 | Redis server | Share entries across instances | Yes |
| Pub/Sub | Redis channel | Clear L1 on peer instances immediately | N/A (stateless) |
| Tag timestamps | Redis string keys | Reject stale entries when Pub/Sub is missed | Yes (TTL-bound) |

## Module layout

| Module | Responsibility |
|--------|----------------|
| `src/handler/create-handler.ts` | Implements `CacheHandler`: orchestrates get/set and delegates tag methods |
| `src/handler/l1-cache.ts` | LRU set/delete and tag-based L1 invalidation |
| `src/handler/redis-client.ts` | Lazy Redis connect, 30 s cooldown after outage |
| `src/handler/single-flight.ts` | Render lock acquisition, polling, safe release |
| `src/handler/tag-operations.ts` | `refreshTags`, `updateTags`, `getExpiration` |
| `src/handler/pubsub.ts` | Subscribe to invalidation channel, clear L1 |
| `src/handler/stale.ts` | Freshness checks: revalidate window + tag timestamps |
| `src/handler/entry.ts` | v8 serialize/deserialize, stream ↔ buffer conversion |
| `src/handler/redis-keys.ts` | Key encoding and prefix helpers |
| `src/handler/config.ts` | Constants and env-driven defaults |
| `src/handler/state.ts` | Process-global LRU, Redis clients, tag map |
| `src/cache-debug.ts` | Optional write-only telemetry |

## Freshness model

Every read path calls `isEntryFresh()` in `src/handler/stale.ts`. An entry is returned only when **all** checks pass. A failed check is treated as stale — the handler does not return the entry and continues as if it were missing.

```mermaid
flowchart TD
    Entry["Candidate entry"] --> Expired{"Revalidate\nexpired?"}
    Expired -- yes --> Stale["Reject as stale"]
    Expired -- no --> Hard{"Any hard tag\ninvalidated?"}
    Hard -- yes --> Stale
    Hard -- no --> Soft{"Any soft tag\ninvalidated?"}
    Soft -- yes --> Stale
    Soft -- no --> Fresh["Return entry"]

    Expired -.- ExpRule["now > timestamp + revalidate × 1000"]
    Hard -.- HardRule["localTagTimestamps(tag) > entry.timestamp\nfor tag in entry.tags"]
    Soft -.- SoftRule["localTagTimestamps(tag) > entry.timestamp\nfor tag in softTags"]
```

| Check | Input | Rule |
|-------|-------|------|
| Revalidate window | `entry.timestamp`, `entry.revalidate` | `Date.now() > timestamp + revalidate × 1000` |
| Hard tags | `entry.tags` | Tag invalidation time in local map is newer than entry creation |
| Soft tags | `get(..., softTags)` | Same as hard tags, but tags are not stored on the entry |

Stale entries are never returned from L1 or L2. See [INVALIDATION.md](INVALIDATION.md) for how tag timestamps are written and synced.

## `get()` — control flow

Every `get()` call ensures the Pub/Sub subscriber is set up, then resolves the entry through the layers below.

```mermaid
flowchart TD
    Start["get(cacheKey, softTags)"] --> Sub["setupSubscriber()"]
    Sub --> Pending{"Pending set\nfor this key?"}
    Pending -- yes --> AwaitPending["Await in-flight set()"]
    Pending -- no --> L1Check{"L1 hit\nand fresh?"}
    AwaitPending --> L1Check
    L1Check -- yes --> ReturnL1["Return entry"]
    L1Check -- stale --> RedisCheck
    L1Check -- miss --> RedisCheck{"Redis\navailable?"}
    RedisCheck -- no --> Miss["Return undefined\n(miss)"]
    RedisCheck -- yes --> L2Get{"L2 hit\nand fresh?"}
    L2Get -- yes --> Promote["Promote to L1, return"]
    L2Get -- stale --> LockCheck
    L2Get -- miss --> LockCheck{"Render lock\nexists?"}
    LockCheck -- yes --> Wait["Poll for peer result"]
    Wait -- hit --> Promote
    Wait -- timeout --> TryLock
    LockCheck -- no --> TryLock{"Acquire\nrender lock?"}
    TryLock -- yes --> Miss
    TryLock -- no --> Wait2["Poll for peer result"]
    Wait2 -- hit --> Promote
    Wait2 -- timeout --> Miss
```

On L2 hit, the handler promotes the entry to L1 (`lruSetAndSync`) before returning a clone to the framework.

## `set()` — control flow

`set()` runs after the framework renders on a cache miss. Concurrent `get()` calls for the same key block on a pending promise until this write completes.

```mermaid
flowchart TD
    Start["set(cacheKey, pendingEntry)"] --> Register["Register pending promise\nin pendingSets"]
    Register --> AwaitEntry["Await pendingEntry\n(framework render)"]
    AwaitEntry --> Buffer["Buffer ReadableStream\n→ StoredEntry"]
    Buffer --> L1Write["Write to L1\n(lruSetAndSync)"]
    L1Write --> RedisAvail{"Redis\navailable?"}
    RedisAvail -- no --> L1Only["L1 only — skip L2"]
    RedisAvail -- yes --> Pipeline["Redis pipeline"]
    Pipeline --> SetEntry["SET entry key\nEX max(expire, 60)"]
    SetEntry --> IndexTags["For each tag:\nSADD index:{tag}\nEXPIRE NX / EXPIRE GT"]
    IndexTags --> Exec["pipeline.exec()"]
    L1Only --> Finally
    Exec --> Finally["finally: release render lock\nresolve pending promise"]
```

Steps in code (`src/handler/create-handler.ts`):

1. Register a pending promise so concurrent `get()` calls for the same key wait for this write.
2. Await the `pendingEntry` promise from the framework (rendered payload).
3. Buffer the `ReadableStream` value and store in L1.
4. If Redis is available, `SET` the serialized entry with TTL `max(expire, 60)` seconds.
5. For each tag on the entry, add the entry key to a Redis set index (`index:{tag}`) with matching TTL (`EXPIRE NX` and `EXPIRE GT` so shorter entries do not shrink index lifetime).
6. In `finally`: release the single-flight render lock (compare-and-delete via Lua script), resolve the pending promise, and remove it from `pendingSets`.

If Redis is unavailable, steps 4–5 are skipped; the entry remains in L1 only. Lock release and pending cleanup still run in `finally`.

## Single-flight (render deduplication)

When no fresh entry exists and Redis is reachable, only one instance should render. Others wait for the result in L2.

```mermaid
sequenceDiagram
    participant A as Instance A (winner)
    participant B as Instance B (waiter)
    participant Redis as Redis

    Note over A,B: Both call get() — L1/L2 miss, entry fresh checks passed

    A->>Redis: SET NX lock:{key} = instanceId
    Redis-->>A: OK (lock acquired)
    A-->>A: return undefined → framework renders

    B->>Redis: EXISTS lock:{key}
    Redis-->>B: 1 (lock held)
    B->>Redis: poll GET entry:{key} every 100ms

    A->>A: set() writes entry to L1 + Redis
    A->>Redis: DEL lock (Lua, owner only)

    B->>Redis: GET entry:{key}
    Redis-->>B: serialized entry
    B-->>B: promote to L1, return entry
```

| Step | Behavior |
|------|----------|
| Lock acquisition | First instance to `SET NX` on `lock:{encodedKey}` with its `instanceId` wins and returns `undefined` (miss) |
| Waiting | Other instances poll Redis every `SINGLE_FLIGHT_POLLING_MS` (default 100 ms), up to `SINGLE_FLIGHT_ATTEMPTS` (default 50, ~5 s) |
| Completion | Winning instance completes `set()`; peers read the new entry from Redis |
| Lock release | Lua script deletes the lock only if the owner matches; expired locks are harmless |

Lock TTL defaults to `SINGLE_FLIGHT_LOCK_TTL` (30 s). See [CONFIGURATION.md](CONFIGURATION.md) for tunables.

## Pub/Sub invalidation

Channel: `pubsub:invalidate` (see `src/handler/config.ts`).

On `updateTags`, the handler publishes a v8-serialized, base64-encoded payload `{ tags?, keys? }`. Subscribers on other instances clear matching L1 entries without touching L2 (L2 is deleted by the publisher).

```mermaid
flowchart LR
    Pub["Publisher instance\nupdateTags()"] --> Redis[("Redis")]
    Redis -->|"PUBLISH pubsub:invalidate"| Sub1["Subscriber\ninstance 1"]
    Redis --> Sub2["Subscriber\ninstance 2"]
    Sub1 --> L1a["invalidateLruByTags\n+ delete keys"]
    Sub2 --> L1b["invalidateLruByTags\n+ delete keys"]
```

Subscriber setup is lazy: the first cached request on an instance triggers subscribe on a dedicated Redis connection (`setupSubscriber()` in `get()`).

Full invalidation pipeline (L2 deletes, tag timestamps, Pub/Sub): [INVALIDATION.md](INVALIDATION.md).

## Tag timestamp backstop

Pub/Sub is fire-and-forget. If an instance misses a message (disconnected subscriber, Redis restart), L1 might still hold stale data until LRU TTL expires.

**Backstop:** `updateTags` writes `meta:revalidated-at:{tag}` = invalidation time (ms). `refreshTags` syncs these into an in-memory map before requests. Any entry with `entry.timestamp < tagInvalidationTime` is rejected as stale on both L1 and L2 reads.

```mermaid
flowchart TD
    UT["updateTags(tags)"] --> Meta["SET meta:revalidated-at:{tag}\n+ SADD meta:revalidated-tags"]
    Meta --> Local1["localTagTimestamps.set(tag, now)"]
    RT["refreshTags() before request"] --> MGET["MGET meta:revalidated-at:*"]
    MGET --> Local2["Update localTagTimestamps"]
    GET["get() on L1 or L2 hit"] --> Check{"entry.timestamp <\ntag invalidation time?"}
    Check -- yes --> Reject["Treat as stale → miss path"]
    Check -- no --> Return["Return entry"]
```

Tag metadata TTL defaults to 7 days (`TAG_META_TTL_SECONDS`). Expired metadata is pruned from `meta:revalidated-tags` on refresh.

## Redis unavailable / build phase

| Condition | Behavior |
|-----------|----------|
| `REDIS_HOST` not set | Redis disabled; L1 only |
| `NEXT_PHASE=phase-production-build` | Redis disabled during production build |
| Connection error | 30 s cooldown (`REDIS_COOLDOWN_MS`); L1 only until reconnect |
| Pub/Sub failure | L1 not cleared remotely; tag timestamps still protect L2 reads after `refreshTags` |

Each instance has a unique `instanceId` (`pid-{pid}-{random}`) used for lock ownership.

## Serialization

Entries in Redis use Node.js `v8.serialize` with a buffered payload and optional `_meta` block for inspection tools. Cache keys containing `:` are encoded as `;` in Redis key names (see [REDIS-SCHEMA.md](REDIS-SCHEMA.md)).

## Related documents

- [API.md](API.md) — handler method contracts
- [INVALIDATION.md](INVALIDATION.md) — tag operations in depth
- [REDIS-SCHEMA.md](REDIS-SCHEMA.md) — key naming
- [CONFIGURATION.md](CONFIGURATION.md) — tunables
