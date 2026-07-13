# 04 — Application benefits

What adopting `use cache: remote` with this package actually changes, compared
with the built-in in-process Next.js cache.

## The problem this package solves

The built-in `use cache` keeps entries in the memory of a single process. With N
application instances (Kubernetes, autoscaling) this means:

- every instance renders **the same** pages on its own — N renders instead of
  one,
- after a deploy or restart the cache starts **empty** — a wave of cold renders,
- `revalidateTag` clears the cache only in the instance that handled the
  request — the others keep serving stale content until entries expire on their
  own.

## What changes after adoption

### 1. One render instead of N

A result computed by any instance lands in Redis and is immediately available to
all. On top of that, single-flight ensures that on a miss (e.g. after a popular
entry expires) **exactly one** instance renders — the rest wait a fraction of a
second and pick up the finished result.

The effect: lower CPU spend on rendering, less traffic to the backends/APIs the
cached functions read from, and no stampede after entries expire.

### 2. A warm cache after deploys and restarts

Redis outlives the application process. A new instance benefits from entries
rendered by its predecessors starting with its very first request — a deploy
does not trigger a wave of full renders.

### 3. Consistent invalidation across the cluster

`revalidateTag` works globally: entries disappear from Redis, a Pub/Sub message
clears the L1 of every instance, and tag timestamps close the gap if any
instance missed the message. A CMS edit becomes visible everywhere, not just on
one machine.

### 4. Users don't wait for refreshes

Thanks to stale-while-revalidate (chapter 02), a stale-but-alive entry is served
instantly while the refresh happens in the background. A full, blocking render
on the request path occurs only after the hard `expire` or after a tag
invalidation.

### 5. A Redis outage doesn't take the application down

The handler degrades to L1-only mode: the application keeps running, only the
cache stops being shared. After a 30-second cooldown the handler reconnects to
Redis on its own, and the timestamp mechanism restores invalidation consistency.

## What this package does NOT do

To set expectations:

- **It does not speed up the first render** of a given key — someone always has
  to compute the result. The package makes sure it happens once, on one
  instance.
- **It does not decide what to cache** — the application does, via the
  `use cache: remote` directive, the `cacheLife` profile and `cacheTag` labels.
- **It does not replace a CDN** — it operates at the server-rendering level, not
  at static-asset distribution.

## Where the impact is biggest

| Scenario | Gain |
|----------|------|
| Many instances + repeatable pages (catalog, listings) | Biggest — N renders drop to 1 |
| Frequent deploys | Large — no cold cache starts |
| CMS-edited content with `revalidateTag` | Large — consistent, immediate invalidation |
| Single instance, little repeatable traffic | Small — the built-in cache may be enough |
