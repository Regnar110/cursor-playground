import v8 from "node:v8";

/**
 * Extracts metadata (layer / resource / locale) from entry tags for the `_meta` field
 * in the payload — easier debugging in Redis Insight.
 *
 * @param {string[]} tags - Cache entry tags.
 * @returns {{layer: string, resource: string, locale: string}} Descriptive metadata.
 */
export function parseTagsMeta(tags) {
  const primary =
    tags?.find((t) => t.includes(":") && t.split(":").length >= 4) ?? tags?.[0] ?? "";
  const parts = primary.split(":");

  return {
    layer: parts[0] === "data" || parts[0] === "ui" ? parts[0] : "unknown",
    resource: parts[1] ?? "unknown",
    locale: parts.length >= 4 ? `${parts[2]}/${parts[3]}` : "global",
  };
}

/**
 * Reads entire ReadableStream into one Buffer (entry payload before writing to Redis).
 *
 * @param {ReadableStream} stream
 * @returns {Promise<Buffer>}
 */
export async function readStreamToBuffer(stream) {
  const reader = stream.getReader();
  const chunks = [];

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks);
}

/**
 * Wraps a Buffer in a one-shot ReadableStream (return format required by Next.js).
 *
 * @param {Buffer} buffer
 * @returns {ReadableStream}
 */
export function bufferToStream(buffer) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(buffer);
      controller.close();
    },
  });
}

/**
 * Deserializes a Redis entry (v8 binary) into a Next.js structure.
 * `_buffer`/`_size` are internal (LRU + cloneEntryForReturn) and are not passed to Next.js.
 *
 * @param {Buffer} raw - Raw bytes from redis.getBuffer().
 * @returns {object} Cache entry with value as ReadableStream.
 */
export function deserializeEntry(raw) {
  const serialized = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const parsed = v8.deserialize(serialized);
  const buffer = Buffer.isBuffer(parsed.value) ? parsed.value : Buffer.from(parsed.value);

  return {
    value: bufferToStream(buffer),
    tags: parsed.tags,
    stale: parsed.stale,
    timestamp: parsed.timestamp,
    expire: parsed.expire,
    revalidate: parsed.revalidate,
    _buffer: buffer,
    _size: buffer.length,
  };
}

/**
 * Serializes entry to v8 binary with `_meta` (layer/resource/locale/tags/createdAt)
 * for easier inspection in Redis Insight.
 *
 * Production note: v8.serialize format is tied to Node version — all instances must
 * run the same runtime (one .next artifact assumes this).
 *
 * @param {object} entry - Cache entry from Next.js.
 * @param {Buffer} buffer - Gathered entry payload.
 * @returns {Buffer} Bytes to write to Redis.
 */
export function serializeEntry(entry, buffer) {
  const meta = parseTagsMeta(entry.tags);
  return v8.serialize({
    value: buffer,
    tags: entry.tags,
    stale: entry.stale,
    timestamp: entry.timestamp,
    expire: entry.expire,
    revalidate: entry.revalidate,
    _meta: {
      ...meta,
      tags: entry.tags,
      createdAt: new Date(entry.timestamp).toISOString(),
    },
  });
}

/**
 * Returns a copy of the entry with a fresh ReadableStream — streams are one-shot,
 * so each return to Next.js must get a new one.
 *
 * @param {object} entry - Entry with `_buffer` (from LRU or after deserialization).
 * @returns {object} Entry ready to return from get().
 */
export function cloneEntryForReturn(entry) {
  const buffer = entry._buffer;
  if (!buffer) {
    return entry;
  }

  return {
    value: bufferToStream(buffer),
    tags: entry.tags,
    stale: entry.stale,
    timestamp: entry.timestamp,
    expire: entry.expire,
    revalidate: entry.revalidate,
  };
}
