# Development

Guide for building, testing, and navigating the `@tme/cache-handler` source tree.

## Prerequisites

- Node.js 20+
- npm (or compatible package manager)

## Commands

Run from the package root (directory containing this package's `package.json`):

```bash
# Install dependencies (from monorepo root or package directory)
npm install

# Build TypeScript → dist/
npm run build

# Run tests
npm test
```

Build uses [tsup](https://tsup.egoist.dev/) (`tsup.config.ts`): single ESM bundle `dist/remote-handler.js` + `dist/remote-handler.d.ts`. Dependencies `ioredis` and `lru-cache` are external (not bundled).

## Source layout

```
src/
├── remote-handler.ts       # Public entry (re-exports default handler)
├── types.ts                # CacheHandler, CacheEntry interfaces
├── cache-debug.ts          # Optional debug telemetry
└── handler/
    ├── create-handler.ts   # get/set implementation
    ├── config.ts           # Constants and env defaults
    ├── state.ts            # Global LRU, Redis clients, tag map
    ├── redis-client.ts     # Connection and cooldown logic
    ├── redis-keys.ts       # Key encoding helpers
    ├── entry.ts            # Serialization and streams
    ├── l1-cache.ts         # LRU operations
    ├── stale.ts            # Freshness checks
    ├── single-flight.ts    # Render lock and polling
    ├── tag-operations.ts   # refreshTags, updateTags, getExpiration
    └── pubsub.ts           # Invalidation subscriber

__tests__/
├── remote-handler.test.ts  # Integration tests (main suite)
├── cache-debug.test.ts     # Debug telemetry tests
└── fake-redis.cjs          # In-memory ioredis mock
```

## Testing

Jest configuration: `jest.config.ts`

- ESM preset via `ts-jest` (`tsconfig.test.json` for tests)
- `ioredis` mapped to `__tests__/fake-redis.cjs` (no real Redis required)
- Tests live in `__tests__/*.test.ts`

### What the test suite covers

**`remote-handler.test.ts`**

| Area | Scenarios |
|------|-----------|
| set + get | Roundtrip, key encoding (`:` → `;`), tag indexes, cross-instance read, revalidate expiry |
| single-flight | Lock acquire/release, compare-and-delete, polling peer result |
| invalidation | `updateTags` deletes entries and indexes, meta timestamps, Pub/Sub, `getExpiration` |
| refreshTags | Sync from Redis, prune expired tag metadata |
| index TTL | `EXPIRE NX` / `EXPIRE GT` behavior |
| Redis failure | LRU-only fallback, reconnect after cooldown |

**`cache-debug.test.ts`**

- No-op when debug disabled
- Log format and stale reason helpers
- `classifyCacheLayer` mapping

### FakeRedis

`fake-redis.cjs` implements the subset of ioredis API used by the handler: connect, get/set buffers, sets, pipelines, eval (Lua), publish/subscribe, and hash/list ops for debug keys.

To add tests for new Redis commands, extend FakeRedis first, then add test cases.

## Adding documentation

Deliverable docs live in:

- `README.md`
- `docs/*.md`

Follow the rules in `project-specs/docs-setup.md`: English, generic, relative paths only, no application-specific references.

## Related documents

- [API.md](API.md) — public interface
- [ARCHITECTURE.md](ARCHITECTURE.md) — runtime design
- [CONFIGURATION.md](CONFIGURATION.md) — environment variables
