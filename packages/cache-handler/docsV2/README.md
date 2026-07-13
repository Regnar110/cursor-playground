# @tme/cache-handler — documentation v2

`@tme/cache-handler` is a **remote cache handler** for Next.js 16 (Cache Components).
It plugs into the `use cache: remote` directive and replaces the built-in Next.js
cache with a two-level store:

- **L1** — a small, fast in-process cache (LRU) inside each Node process,
- **L2** — Redis, shared by all instances of the application.

A render result computed by one instance becomes immediately available to all
others, and invalidation (e.g. after a CMS edit) is consistent across the whole
cluster.

## The mental model in 30 seconds

1. Next.js asks the handler: "do you have a result for this key?" (`get`).
2. The handler checks L1 first, then Redis. A fresh entry is returned right away.
3. On a miss, Next.js renders and hands the result back to the handler (`set`),
   which stores it in both L1 and Redis.
4. When a tag is invalidated (`revalidateTag` → `updateTags`), the handler deletes
   matching entries from Redis and broadcasts a Pub/Sub message telling every
   instance to clear its L1.

## Table of contents

| Chapter | What it covers |
|---------|----------------|
| [01 — Mechanisms](01-mechanisms.md) | L1/L2, the `get` and `set` flows, single-flight, entry freshness, behavior during a Redis outage |
| [02 — Next.js integration](02-nextjs-integration.md) | `use cache: remote`, `cacheTag`, `cacheLife`, stale-while-revalidate in Next.js 16 |
| [03 — Invalidation](03-invalidation.md) | How tag invalidation works: Pub/Sub, tag timestamps, cross-instance synchronization |
| [04 — Application benefits](04-application-benefits.md) | What to expect after adoption: fewer renders, cross-instance consistency, outage resilience |
| [05 — Glossary](05-glossary.md) | Definitions of the terms used throughout this documentation |

## Key defaults

| Parameter | Default | Purpose |
|-----------|---------|---------|
| L1 capacity | 500 entries / 50 MB | Hot keys don't hit Redis on every request |
| L1 entry lifetime | 15 seconds | L1 is only a buffer — Redis is the source of truth |
| Render lock (single-flight) | 30 seconds | Only one instance renders on a cache miss |
| Wait for a peer render | up to ~5 seconds (50 polls every 100 ms) | Other instances wait for the result instead of rendering |
| Tag invalidation metadata | 7 days | Safety net in case a Pub/Sub message is lost |
| Cooldown after a Redis outage | 30 seconds | The handler doesn't flood a recovering Redis with connection attempts |

All values are configurable via environment variables — see
[docs/CONFIGURATION.md](../docs/CONFIGURATION.md) for the full list.
