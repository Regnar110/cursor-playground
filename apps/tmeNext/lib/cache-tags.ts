/**
 * Konwencja tagów — jeden tag 1:1 per wpis cache.
 *
 * Format: {warstwa}:{zasób}[:{scope...}]
 *
 * - warstwa:  data (funkcja fetch) | ui (komponent)
 * - zasób:    nazwa z CacheResource
 * - scope:    opcjonalne, dowolna liczba segmentów zawężających wpis;
 *             np. locale (country, lang), id encji, wariant — albo nic,
 *             gdy zasób jest globalny
 *
 * Przykłady:
 *   data:config                → wpis globalny, bez scope
 *   data:posts:pl:pl           → scope = locale
 *   ui:product:42              → scope = id encji
 */
export type CacheResource = "posts" | "users" | "products" | "cache-lab" | "news";

export function dataTag(resource: CacheResource, ...scope: Array<string | number>): string {
  return ["data", resource, ...scope.map(String)].join(":");
}

export function uiTag(resource: CacheResource, ...scope: Array<string | number>): string {
  return ["ui", resource, ...scope.map(String)].join(":");
}

export function parseCacheTag(tag: string) {
  const parts = tag.split(":");
  const layer = parts[0] === "data" || parts[0] === "ui" ? parts[0] : "unknown";
  const resource = parts[1] ?? "unknown";
  const scope = parts.slice(2);

  return { layer, resource, scope };
}
