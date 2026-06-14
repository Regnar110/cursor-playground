import v8 from "node:v8";

/** @param {string[]} tags */
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

/** @param {ReadableStream} stream */
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

/** @param {Buffer} buffer */
export function bufferToStream(buffer) {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(buffer);
      controller.close();
    },
  });
}

/** @param {Buffer} raw */
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

/** @param {object} entry @param {Buffer} buffer */
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

/** @param {object} entry */
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
