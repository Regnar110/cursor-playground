# Documentation specification — `@tme/cache-handler`

## Scope

English, fully generic library documentation inside this package only.
Source of truth: `src/`, `__tests__/`, `package.json`, `dist/*.d.ts`.

## Deliverables

| File | Purpose |
|------|---------|
| `README.md` | Overview, install, integration snippet, doc index |
| `docs/ARCHITECTURE.md` | L1/L2, flows, single-flight, failure modes |
| `docs/API.md` | `CacheHandler` contract |
| `docs/CONFIGURATION.md` | Environment variables |
| `docs/REDIS-SCHEMA.md` | Key layout, indexes, Pub/Sub |
| `docs/INVALIDATION.md` | Tag operations, stale detection |
| `docs/DEBUG.md` | Debug telemetry |
| `docs/DEVELOPMENT.md` | Build, test, module map |

## Acceptance criteria

- Relative paths only in deliverables (`src/...`, `docs/...`)
- No consuming-application references
- No absolute OS paths, no personal names
- Mermaid diagrams in ARCHITECTURE and INVALIDATION
- All env vars from `src/handler/config.ts` and `src/handler/state.ts` documented
- All `CacheHandler` methods documented

## QA grep gates

Run on `packages/cache-handler/**/*.md` (exclude this file if desired):

**App refs:** `tmeNext`, `apps/`, `dataTag`, `uiTag`, `invalidateRemote`, `HOW_TO_RUN`, `CACHING.md`, `k6`, `docker-compose`, `cursor-playground`

**Absolute paths:** `[A-Za-z]:\\`, `/Users/`, `/home/`, `%USERPROFILE%`, `~/.`

**Personal/meta:** `Miszczu`, `mateu`, `orchestrator`, `AgentsOrchestrator`
