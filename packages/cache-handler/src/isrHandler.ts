/**
 * Redis-backed incremental cache handler (`cacheHandler` in next.config).
 *
 * Covers what the `use cache` handler (remoteHandler) does NOT: the full route
 * cache (ISR HTML/RSC payloads), route handler responses, the fetch cache and
 * optimized images. By default Next.js keeps these on the local disk of each
 * instance, so a multi-instance deployment serves diverging snapshots. Storing
 * them in Redis gives every instance the same view and makes revalidateTag /
 * revalidatePath effective cluster-wide.
 *
 * Lifecycle: Next.js instantiates this class once per HTTP request (inside
 * `IncrementalCache`), not once per Node process. Only request-scoped fields
 * belong in the constructor; shared resources (Redis) live in module scope.
 *
 * @see https://github.com/vercel/next.js/blob/v16.2.0/packages/next/src/server/lib/incremental-cache/index.ts
 * @see https://github.com/vercel/next.js/blob/v16.2.0/packages/next/src/server/next-server.ts
 */
export { default } from './isr/handler.js';
