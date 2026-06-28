# @tme/cache-handler

Redis-backed remote cache handler for Next.js Cache Components. Implements a tiered cache (in-process LRU + shared Redis) with Pub/Sub invalidation, single-flight rendering on cache miss, and persistent tag timestamps as a backstop when Pub/Sub messages are missed.

## Features

- **L1 LRU** — short-lived in-process cache to reduce Redis round-trips on hot keys
- **L2 Redis** — shared cache across multiple Node.js instances
- **Pub/Sub** — instant L1 cleanup on all instances when tags are invalidated
- **Single-flight** — on miss, one instance renders; others wait for the result
- **Tag timestamps** — `meta:revalidated-at:*` keys reject stale entries even if Pub/Sub was missed
- **Graceful degradation** — LRU-only mode when Redis is unavailable

## Installation

```bash
npm install @tme/cache-handler ioredis lru-cache
```

Peer runtime: Node.js 20+, Redis 6+ (when using L2).

## Quick start

Register the handler in Next.js configuration:

```js
// next.config.js or next.config.ts
module.exports = {
  cacheHandlers: {
    remote: require.resolve("@tme/cache-handler"),
  },
};
```

Set Redis connection variables (see [docs/CONFIGURATION.md](docs/CONFIGURATION.md)):

```bash
export REDIS_HOST=127.0.0.1
export REDIS_PORT=6379
export REDIS_PASSWORD=your-secret
```

Build the package before use (TypeScript → `dist/`):

```bash
npm run build
```

## Documentation

| Document | Description |
|----------|-------------|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | Cache layers, request flows, failure modes |
| [docs/API.md](docs/API.md) | Public handler interface |
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Environment variables |
| [docs/REDIS-SCHEMA.md](docs/REDIS-SCHEMA.md) | Redis key layout and Pub/Sub channel |
| [docs/INVALIDATION.md](docs/INVALIDATION.md) | Tag invalidation and stale detection |
| [docs/DEBUG.md](docs/DEBUG.md) | Optional debug telemetry |
| [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) | Build, test, source layout |

## Invalidation from application code

Consumers can import the default export and call `updateTags`:

```js
import remoteHandler from "@tme/cache-handler";

await remoteHandler.updateTags(["data:resource:42"]);
```

See [docs/INVALIDATION.md](docs/INVALIDATION.md) for details on tag semantics and side effects.

## License

Private package — see repository root for license terms.
