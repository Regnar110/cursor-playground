/**
 * Redis-backed incremental cache handler (`cacheHandler` in next.config).
 *
 * Covers what the `use cache` handler (remoteHandler) does NOT: the full route
 * cache (ISR HTML/RSC payloads), route handler responses, the fetch cache and
 * optimized images. By default Next.js keeps these on the local disk of each
 * instance, so a multi-instance deployment serves diverging snapshots. Storing
 * them in Redis gives every instance the same view and makes revalidateTag /
 * revalidatePath effective cluster-wide.
 */
export { default } from './isr/handler.js';
