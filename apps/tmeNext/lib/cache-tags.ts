/**
 * Konwencja tagów — jeden tag 1:1 per wpis cache (bez tagów globalnych).
 *
 * - data:{resource}:{country}:{lang}  → funkcja fetch
 * - ui:{resource}:{country}:{lang}    → komponent UI
 *
 * Przykład: data:posts:pl:pl, ui:cache-lab:us:en
 */
export type CacheResource = "posts" | "users" | "products" | "cache-lab";

export function dataTag(resource: CacheResource, country: string, lang: string): string {
  return `data:${resource}:${country}:${lang}`;
}

export function uiTag(resource: CacheResource, country: string, lang: string): string {
  return `ui:${resource}:${country}:${lang}`;
}

export function parseCacheTag(tag: string) {
  const parts = tag.split(":");
  const layer = parts[0] === "data" || parts[0] === "ui" ? parts[0] : "unknown";
  const resource = parts[1] ?? "unknown";
  const locale =
    parts.length >= 4 ? { country: parts[2], lang: parts[3] } : null;

  return { layer, resource, locale };
}
