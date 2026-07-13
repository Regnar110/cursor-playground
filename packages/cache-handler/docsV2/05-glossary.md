# 05 — Glossary

| Term | Definition |
|------|------------|
| **Cache Components** | The Next.js 16 mode (`cacheComponents: true`) in which caching is explicit: only code marked with the `use cache` directive gets cached. |
| **Cache handler** | The component that stores and returns cache entries for Next.js. Next.js decides *what* and *for how long* to cache; the handler decides *where* and *how* entries are stored. |
| **`use cache: remote`** | The directive that routes a function's or component's cache through the handler registered as `remote` — this package. Plain `use cache` uses the built-in in-process handler. |
| **Cache entry** | A stored render result plus its metadata: tags, creation timestamp, and the `stale` / `revalidate` / `expire` durations. |
| **Cache key** | The identifier of an entry, built by Next.js from the cached function and its arguments. Same arguments — same key. |
| **L1** | The in-process LRU cache inside each Node process. Small and short-lived (~15 s); absorbs repeated reads of hot keys. |
| **L2** | Redis — the durable cache level shared by all application instances. The source of truth for entries. |
| **LRU (least recently used)** | An eviction policy: when the cache is full, the entry unused for the longest time is removed first. |
| **TTL (time to live)** | How long a key lives in a store before it is removed automatically. Redis entries get a TTL equal to the entry's `expire` (minimum 60 s). |
| **`cacheLife`** | The Next.js API assigning an entry's lifetime profile: `stale` (client), `revalidate` (background refresh window) and `expire` (hard end of life). |
| **`stale`** | Duration enforced by the client: how long the browser/router avoids asking the server for a newer version. |
| **`revalidate`** | Duration enforced by Next.js: past this point the entry is still served, but a background refresh starts. The handler ignores it. |
| **`expire`** | Duration enforced by the handler: past this point the entry is rejected and a full render happens on the request path. |
| **Stale-while-revalidate (SWR)** | The pattern of serving a stale entry immediately while refreshing it in the background. Between `revalidate` and `expire`, users get instant responses and content refreshes without blocking. |
| **`cacheTag`** | The Next.js API attaching labels (tags) to an entry for targeted invalidation. |
| **Tag** | A label on an entry. Invalidating a tag removes all entries carrying it, cluster-wide, regardless of their remaining lifetime. |
| **Soft tag** | A tag passed by Next.js at read time (e.g. a path tag) that is not stored on the entry. Checked against invalidation timestamps just like regular tags. |
| **Tag index** | A Redis set holding the keys of all entries carrying a given tag. Lets invalidation find exactly which entries to delete. |
| **Tag timestamp** | A durable Redis marker "tag X was invalidated at time T" (7-day TTL). Any entry created before that time is rejected at read. The safety net for lost Pub/Sub messages. |
| **`revalidateTag` / `updateTags`** | `revalidateTag` is the application-side Next.js API; it reaches the handler as the `updateTags` method, which deletes entries, stores tag timestamps and broadcasts the Pub/Sub message. |
| **`refreshTags`** | The handler method Next.js calls before serving a request. Synchronizes the local map of tag timestamps with Redis. |
| **Pub/Sub** | The Redis publish/subscribe channel used to broadcast invalidations. Fast but fire-and-forget: offline subscribers miss messages, which is why tag timestamps exist. |
| **Single-flight** | The guarantee that on a cache miss only one instance in the cluster renders a given key. Implemented with a render lock in Redis; other instances poll for the result. |
| **Render lock** | A short-lived Redis key (30 s TTL) marking that an instance is currently rendering a given cache key. |
| **Cache stampede** | The failure mode single-flight prevents: after a popular entry expires, all instances start the same render at once. |
| **L1-only mode** | Degraded operation during a Redis outage or build: the handler serves and stores entries in L1 only; the cache is not shared. |
| **Cooldown** | The 30-second pause after a Redis connection failure during which the handler does not attempt to reconnect. |
| **Instance** | A single running process of the application (e.g. one pod/container). Each instance has its own L1; all share the same L2. |
