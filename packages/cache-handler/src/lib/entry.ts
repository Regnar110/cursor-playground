import { serialize, deserialize } from 'node:v8';
import type { CacheEntry, StoredEntry } from '../types.js';

export function parseTagsMeta(tags: string[]) {
    const primary
        = tags?.find(t => t.includes(':') && t.split(':').length >= 4) ?? tags?.[0] ?? '';
    const parts = primary.split(':');

    return {
        layer: parts[0] === 'data' || parts[0] === 'ui' ? parts[0] : 'unknown',
        locale: parts.length >= 4 ? `${parts[2]}/${parts[3]}` : 'global',
        resource: parts[1] ?? 'unknown',
    };
}

export async function readStreamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
    const reader = stream.getReader();
    const chunks: Buffer[] = [];

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

export function bufferToStream(buffer: Buffer): ReadableStream<Uint8Array> {
    return new ReadableStream({
        start(controller) {
            controller.enqueue(new Uint8Array(buffer));
            controller.close();
        },
    });
}

export function deserializeEntry(raw: Buffer): StoredEntry {
    const serialized = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    const parsed = deserialize(serialized) as {
        value: Buffer;
        tags: string[];
        stale: number;
        timestamp: number;
        expire: number;
        revalidate: number;
    };
    const buffer = Buffer.isBuffer(parsed.value) ? parsed.value : Buffer.from(parsed.value);

    return {
        _buffer: buffer,
        _size: buffer.length,
        expire: parsed.expire,
        revalidate: parsed.revalidate,
        stale: parsed.stale,
        tags: parsed.tags,
        timestamp: parsed.timestamp,
        value: bufferToStream(buffer),
    };
}

export function serializeEntry(entry: CacheEntry, buffer: Buffer): Buffer {
    const meta = parseTagsMeta(entry.tags);
    return serialize({
        _meta: {
            ...meta,
            createdAt: new Date(entry.timestamp).toISOString(),
            tags: entry.tags,
        },
        expire: entry.expire,
        revalidate: entry.revalidate,
        stale: entry.stale,
        tags: entry.tags,
        timestamp: entry.timestamp,
        value: buffer,
    });
}

export function cloneEntryForReturn(entry: StoredEntry): CacheEntry {
    const buffer = entry._buffer;
    if (!buffer) {
        return entry;
    }

    return {
        expire: entry.expire,
        revalidate: entry.revalidate,
        stale: entry.stale,
        tags: entry.tags,
        timestamp: entry.timestamp,
        value: bufferToStream(buffer),
    };
}
