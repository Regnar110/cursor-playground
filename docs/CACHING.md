# Mechanizm cachowania — dokumentacja

Aplikacja oparta na **Next.js 16.2+** z **Cache Components** (`cacheComponents: true`) i custom **remote cache handlerem** (Redis + LRU). Ten dokument opisuje cały przepływ: od dyrektyw w kodzie, przez konwencję tagów i kluczy Redis, po invalidację i deploy multi-instance.

---

## Spis treści

1. [Architektura warstw](#1-architektura-warstw)
2. [Konfiguracja Next.js](#2-konfiguracja-nextjs)
3. [Dyrektywy `use cache`](#3-dyrektywy-use-cache)
4. [Warstwa DATA vs warstwa UI](#4-warstwa-data-vs-warstwa-ui)
5. [Konwencja tagów](#5-konwencja-tagów)
6. [Klucze Redis](#6-klucze-redis)
7. [Remote cache handler](#7-remote-cache-handler)
8. [Build vs runtime](#8-build-vs-runtime)
9. [`cacheLife()` — czas życia wpisu](#9-cachelife--czas-życia-wpisu)
10. [Invalidacja: `updateTag`, `revalidateTag`, `revalidatePath`](#10-invalidacja-updatetag-revalidatetag-revalidatepath)
11. [Wiele instancji za load balancerem](#11-wiele-instancji-za-load-balancerem)
12. [Jak dodać nowy zasób](#12-jak-dodać-nowy-zasób)
13. [Redis Insight — jak czytać dane](#13-redis-insight--jak-czytać-dane)
14. [Uruchomienie lokalne](#14-uruchomienie-lokalne)
15. [Routing i pre-render](#15-routing-i-pre-render)

---

## 1. Architektura warstw

```
Request
   │
   ▼
┌─────────────────────────────────────────────────────────┐
│  Next.js 16 — Cache Components (PPR)                    │
│  ┌─────────────┐    ┌─────────────┐                     │
│  │ use cache:  │    │ use cache:  │                     │
│  │ remote      │    │ remote      │                     │
│  │ (DATA fn)   │    │ (UI comp)   │                     │
│  └──────┬──────┘    └──────┬──────┘                     │
└─────────┼──────────────────┼────────────────────────────┘
          │                  │
          ▼                  ▼
┌─────────────────────────────────────────────────────────┐
│  remote-handler.js                                      │
│  ┌──────────┐   miss    ┌──────────┐                    │
│  │ L1 LRU   │ ────────► │ L2 Redis │                    │
│  │ 15s TTL  │ ◄──────── │ shared   │                    │
│  └──────────┘   hit     └──────────┘                    │
│       ▲                        ▲                        │
│       └──── Pub/Sub invalidacja ────┘                   │
└─────────────────────────────────────────────────────────┘
```

| Warstwa | Gdzie | Zakres | Po restarcie procesu |
|---------|-------|--------|----------------------|
| Artefakt buildu (`.next/`) | Dysk | Wspólny po deployu | Trwały do kolejnego buildu |
| `use cache` (default) | LRU in-process | Per instancja | Ginie |
| `use cache: remote` | LRU + Redis | Współdzielony (L2) | Redis trwały, LRU ginie |
| `use cache: private` | Przeglądarka | Per klient | N/A |

Ta aplikacja używa wyłącznie **`use cache: remote`** dla warstw DATA i UI.

---

## 2. Konfiguracja Next.js

Plik: `next.config.ts`

```ts
const nextConfig: NextConfig = {
  cacheComponents: true,
  cacheHandlers: {
    remote: require.resolve("./cache-handlers/remote-handler.js"),
  },
};
```

- **`cacheComponents`** — włącza Cache Components i dyrektywę `use cache`.
- **`cacheHandlers.remote`** — handler dla `'use cache: remote'`.
- Handler **`default`** (dla zwykłego `'use cache'`) nie jest skonfigurowany — Next.js używa wbudowanego LRU in-process.

Zmienna środowiskowa:

```env
REDIS_URL=redis://localhost:6379
```

---

## 3. Dyrektywy `use cache`

| Dyrektywa | Handler | Persystencja |
|-----------|---------|--------------|
| `'use cache'` | `default` (wbudowany LRU) | Tylko pamięć procesu |
| `'use cache: remote'` | `remote-handler.js` | LRU + Redis |
| `'use cache: private'` | Brak (przeglądarka) | Per klient |

### Gdzie umieszczać dyrektywę

```ts
// Poziom funkcji — cache wyniku fetcha
export async function getPosts(country: string, lang: string) {
  "use cache: remote";
  cacheLife("hours");
  cacheTag(dataTag("posts", country, lang));
  return fetch(...);
}

// Poziom komponentu — cache wyrenderowanego UI
export async function CachedPostsList({ country, lang }) {
  "use cache: remote";
  cacheLife("hours");
  cacheTag(uiTag("posts", country, lang));
  const data = await getPosts(country, lang);
  return <ul>...</ul>;
}
```

### Ograniczenia

- Wewnątrz `'use cache'` **nie można** wołać `cookies()`, `headers()`, `searchParams` bezpośrednio.
- Wartości dynamiczne przekazuj jako **argumenty funkcji** lub propsy — stają się częścią klucza cache.
- Funkcja z `'use cache'` wołana z **dynamicznego** kontekstu Suspense może nie trzymać cache między requestami — wołaj ją z poziomu strony lub innego stabilnego rodzica.

---

## 4. Warstwa DATA vs warstwa UI

To **dwa osobne wpisy cache** z osobnymi tagami. Można je invalidować niezależnie.

| Warstwa | Co jest cache'owane | Przykład | Tagi |
|---------|---------------------|----------|------|
| **DATA** | Wynik funkcji async (JSON z API) | `getPosts()`, `getCacheLabData()` | `data:*` |
| **UI** | Wyrenderowany HTML komponentu RSC | `CachedPostsList`, `CacheLabUiPanel` | `ui:*` |

### Zachowanie przy invalidacji

| Akcja | DATA | UI |
|-------|------|-----|
| `updateTag('data:posts:pl:pl')` | Odświeżone | Bez zmian |
| `updateTag('ui:posts:pl:pl')` | Bez zmian | Przerenderowane |
| `revalidatePath('/pl/pl/posts')` | Może oba (soft tagi ścieżki) | Może oba |

Komponent UI wywołuje wewnątrz funkcję DATA — przy cache hit na UI funkcja DATA **nie jest wołana ponownie** (dane są „zamrożone” w wpisie UI).

---

## 5. Konwencja tagów

Plik: `lib/cache-tags.ts`

Każdy wpis cache dostaje **jeden tag 1:1** — dokładnie to, co jest cache'owane:

```
data:{resource}:{country}:{lang}   → funkcja fetch dla jednego locale
ui:{resource}:{country}:{lang}     → komponent UI dla jednego locale
```

Brak tagów globalnych (`data:posts`, `ui:cache-lab` itd.) — invalidacja zawsze per locale.

### Przykłady

| Tag | Znaczenie |
|-----|-----------|
| `data:posts:pl:pl` | pl/pl — posty (funkcje) |
| `ui:posts:de:en` | de/en — UI listy postów |
| `data:cache-lab:us:en` | us/en — dane laboratorium cache |
| `ui:cache-lab:pl:pl` | pl/pl — UI laboratorium cache |

### Użycie w kodzie

```ts
import { dataTag, uiTag } from "@/lib/cache-tags";

cacheTag(dataTag("posts", country, lang));
// np. cacheTag("data:posts:pl:pl")

cacheTag(uiTag("posts", country, lang));
// np. cacheTag("ui:posts:pl:pl")
```

### Zasoby (`CacheResource`)

`posts` | `users` | `products` | `cache-lab`

---

## 6. Klucze Redis

Handler: `cache-handlers/remote-handler.js`

### Konwencja kluczy

- **Wpisy cache** — `cacheKey` Next.js z jedną zmianą: `:` → `;`. Powód: cacheKey to JSON ze `:` w środku (`{"country":"us"}`), a Redis Insight rozbija klucze po `:` — bez tego klucz rozpadałby się na śmieciowe gałęzie. Member w `index:…` SET = ten sam (zakodowany) string co klucz wpisu w Redis (1:1).
- **Tagi** (`index:…`, `meta:revalidated-at:…`) — prefiks + tag z `:`. Tagi nie zawierają JSON, więc `:` jest tu pożądane — Redis Insight grupuje data pod `index:data`, UI pod `index:ui`.

Przykład tagu `data:posts:pl:pl` → `index:data:posts:pl:pl`.

Przykład wpisu → `["_P41X2fg…","hash…",[{"country";"pl","lang";"pl"}]]` (identyczny w indeksie i jako klucz STRING; `;` zamiast `:`).

### Schemat

| Klucz Redis | Typ | Zawartość |
|-------------|-----|-----------|
| `{cacheKey z ; zamiast :}` | STRING (binary v8) | Payload cache + `_meta` |
| `lock:{cacheKey z ;}` | STRING | Single-flight lock (30s TTL) |
| `index:{tag}` | SET | cacheKey (zakodowane) powiązane z tagiem |
| `meta:revalidated-at:{tag}` | STRING | Timestamp ms ostatniej invalidacji (**nie cache!**) |
| `meta:revalidated-tags` | SET | Lista tagów, które były invalidowane |

### Przykład drzewa w Redis Insight

```
index:
  data:
    cache-lab:
      pl:pl          ← SET; members = cacheKey (z ; zamiast :)
    posts:
      pl:pl
  ui:
    cache-lab:
      pl:pl
["_P41X2fg…",…{"country";"pl"…}]   ← klucz wpisu = member z indeksu (1:1), bez ":" → jeden węzeł
meta:
  revalidated-at:
    data:
      cache-lab:
        pl:pl
  revalidated-tags
lock:…                ← tymczasowe blokady renderu
```

### Metadane w payloadzie (`_meta`)

Przy zapisie do Redis handler dodaje (v8 serialize):

```json
{
  "_meta": {
    "layer": "data",
    "resource": "posts",
    "locale": "pl/pl",
    "tags": ["data:posts:pl:pl"],
    "createdAt": "2026-06-10T21:00:00.000Z"
  }
}
```

---

## 7. Remote cache handler

Plik: `cache-handlers/remote-handler.js`

Implementuje interfejs Next.js 16 `CacheHandler`: `get`, `set`, `refreshTags`, `getExpiration`, `updateTags`.

### L1 — LRU (in-process)

- Max 500 wpisów, max 50 MB
- TTL: 15 sekund
- Cel: ograniczyć round-tripy do Redis przy gorącym ruchu

### L2 — Redis

- Serializacja: `v8.serialize` / `v8.deserialize`
- TTL wpisu: `max(entry.expire, 60)` sekund
- Połączenie lazy; przy błędzie — fallback na sam LRU (30s cooldown)

### Single-flight

Przy cache miss na wielu instancjach:

1. Instancja A zdobywa `lock:{cacheKey}` (SET NX, 30s).
2. Instancje B–N czekają na pojawienie się wpisu `{cacheKey}` w Redis.
3. Tylko jedna instancja renderuje i zapisuje — reszta odczytuje wynik.

### Pub/Sub — synchronizacja L1

Kanał: `pubsub:invalidate`

Gdy `updateTags()` invaliduje tagi:

1. Kasuje wpisy w Redis i lokalnym LRU na instancji wywołującej.
2. Publikuje `{ tags, keys }` do Pub/Sub.
3. Pozostałe instancje czyszczą swój LRU natychmiast.

### `refreshTags()` i `getExpiration()`

Wywoływane przez Next.js **przed każdym requestem**:

- `refreshTags()` — synchronizuje timestampy invalidacji z Redis (`meta:revalidated-at:*`).
- `getExpiration(tags)` — zwraca najnowszy timestamp rewalidacji dla podanych tagów.
- Wpis cache jest odrzucany, jeśli tag został invalidowany **po** `entry.timestamp`.

### Faza buildu

Gdy `NEXT_PHASE === 'phase-production-build'`:

- Redis jest **wyłączony** (brak połączenia w CI/Docker build).
- Używany jest tylko LRU procesu buildu (efemeryczny).

---

## 8. Build vs runtime

| Moment | Co powstaje | Redis |
|--------|-------------|-------|
| `next build` | Artefakt `.next/`, pre-render 2 locale (`pl/pl`, `us/en`) | Pusty (handler pomija Redis) |
| `next start` / request | Wpisy `use cache: remote` | Wypełniany przy pierwszych hitach |

**Artefakt buildu ≠ remote cache.** Build daje statyczną powłokę PPR; Redis przechowuje runtime cache między requestami i instancjami.

---

## 9. `cacheLife()` — czas życia wpisu

```ts
cacheLife("hours");   // wbudowany profil
cacheLife("minutes");

cacheLife({
  stale: 3600,
  revalidate: 7200,
  expire: 86400,
});
```

| Profil | Typowe użycie w projekcie |
|--------|---------------------------|
| `hours` | Posty, użytkownicy, produkty |
| `minutes` | Cache Lab (krótszy TTL do eksperymentów) |

`cacheLife` kontroluje **kiedy** Next.js uzna wpis za wymagający rewalidacji. Invalidacja tagami (`updateTag` / `revalidateTag`) działa **niezależnie** od `cacheLife`.

---

## 10. Invalidacja: `updateTag`, `revalidateTag`, `revalidatePath`

### `updateTag(tag)` — natychmiast

- Wywołaj w **Server Action** po mutacji danych.
- Invalidacja jest **natychmiastowa** — ten sam request widzi świeże dane.
- Handler: `updateTags()` → kasuje Redis + LRU + Pub/Sub.

```ts
"use server";
import { updateTag } from "next/cache";

export async function afterMutation(country: string, lang: string) {
  updateTag(`data:posts:${country}:${lang}`);
}
```

### `revalidateTag(tag, profile)` — w tle (SWR)

- Stale-while-revalidate: bieżąca odpowiedź może być jeszcze stara.
- Świeże dane przy **następnym** żądaniu.
- W Next.js 16: drugi argument to profil, np. `"max"`.

```ts
import { revalidateTag } from "next/cache";

revalidateTag("data:posts:pl:pl", "max");
revalidateTag("ui:posts:pl:pl", "max");
```

### `revalidatePath(path)` — soft tagi ścieżki

- Invaliduje cache powiązany ze ścieżką URL przez **soft tagi** (`_N_T_/...`).
- Next.js generuje soft tagi automatycznie z segmentów routingu.
- Handler sprawdza je w `get()` przez `isSoftTagStale()`.

```ts
import { revalidatePath } from "next/cache";

revalidatePath("/pl/pl/posts");
revalidatePath("/pl/pl/cache-lab");
```

### Porównanie

| API | Kiedy świeże dane | Typowy use case |
|-----|-------------------|-----------------|
| `updateTag` | Natychmiast (ten sam request) | Po zapisie do DB / mutacji |
| `revalidateTag` | Następny request (SWR) | Webhook, cron, przycisk „odśwież” |
| `revalidatePath` | Następny request (przez soft tagi) | Zmiana całej strony / layoutu |

Implementacja referencyjna: `app/actions/revalidate.ts`, `app/actions/cache-lab.ts`.

### Demo interaktywne

Strona `/[country]/[lang]/cache-lab` — przyciski invalidacji per tag (DATA + UI dla bieżącego locale).

---

## 11. Wiele instancji za load balancerem

```
                    Load Balancer
                          │
        ┌─────────────────┼─────────────────┐
        ▼                 ▼                 ▼
   Instancja 1       Instancja 2       Instancja N
   LRU (własny)      LRU (własny)      LRU (własny)
        │                 │                 │
        └─────────────────┼─────────────────┘
                          ▼
                    Redis (wspólny)
```

| Mechanizm | Problem który rozwiązuje |
|-----------|--------------------------|
| Redis L2 | Współdzielony cache między instancjami |
| Pub/Sub | Natychmiastowe czyszczenie L1 na wszystkich instancjach po `updateTags` |
| Single-flight | Jedna instancja renderuje przy miss, reszta czeka |
| `refreshTags()` | Synchronizacja timestampów invalidacji przed requestem |
| Ten sam artefakt `.next/` | Wspólna baza statyczna po deployu |

**Sticky sessions nie są wymagane** dla spójności cache.

---

## 12. Jak dodać nowy zasób

### 1. Rozszerz typ zasobu

```ts
// lib/cache-tags.ts
export type CacheResource = "posts" | "users" | "products" | "cache-lab" | "orders";
```

### 2. Funkcja DATA

```ts
// lib/data/orders.ts
export async function getOrders(country: string, lang: string) {
  "use cache: remote";
  cacheLife("hours");
  cacheTag(dataTag("orders", country, lang));

  const res = await fetch("https://api.example.com/orders");
  return res.json();
}
```

### 3. Komponent UI

```tsx
// components/cached-orders-list.tsx
export async function CachedOrdersList({ country, lang }) {
  "use cache: remote";
  cacheLife("hours");
  cacheTag(uiTag("orders", country, lang));

  const data = await getOrders(country, lang);
  return <ul>...</ul>;
}
```

### 4. Server Action invalidacji

```ts
export async function revalidateOrders(country: string, lang: string) {
  revalidateTag(dataTag("orders", country, lang), "max");
  revalidateTag(uiTag("orders", country, lang), "max");
}
```

### Checklist

- [ ] `dataTag()` na funkcji fetch
- [ ] `uiTag()` na komponencie renderującym
- [ ] Funkcja DATA wołana ze stabilnego kontekstu (strona, nie goły Suspense)
- [ ] Server Action z `updateTag` po mutacji lub `revalidateTag` z webhooka
- [ ] W Redis Insight: `index:data:orders:…` i `index:ui:orders:…`

---

## 13. Redis Insight — jak czytać dane

URL: http://localhost:5540

### Co jest czym

| Widzisz | To jest | To NIE jest |
|---------|---------|-------------|
| `entry\|…` | Cache (HTML/dane RSC) | — |
| `index:ui:posts:pl:pl` | Indeks — lista id wpisów | Treść strony |
| `meta:revalidated-at:ui:posts` | Liczba = timestamp invalidacji | Cache |
| `lock\|…` | Blokada renderu (tymczasowa) | Cache |

### Jak sprawdzić warstwę wpisu

1. Otwórz klucz wpisu (ten sam string co member w `index:…` SET; wartość binarna v8).
2. Szukaj pola `_meta.layer` → `"data"` lub `"ui"`.
3. `_meta.resource` → np. `"posts"`.
4. `_meta.locale` → np. `"pl/pl"`.

### Po deployu / zmianie handlera

Stare klucze z poprzednich konwencji (`next-cache:`, `tag|`, `index|ui|…`) możesz usunąć — wygasną też po TTL.

---

## 14. Uruchomienie lokalne

```bash
# Redis + Redis Insight
npm run redis:up

# Dev
npm run dev

# Produkcja
npm run build
npm run start
```

| Serwis | URL |
|--------|-----|
| Aplikacja | http://localhost:3000 |
| Redis | `redis://localhost:6379` |
| Redis Insight | http://localhost:5540 |

Plik `.env.local`:

```env
REDIS_URL=redis://localhost:6379
```

---

## 15. Routing i pre-render

Routing: `/[country]/[lang]/…` — 10 krajów × 30 języków (walidacja w `lib/i18n.ts`).

Pre-render przy buildzie (**tylko 2 kombinacje**):

```ts
// lib/i18n.ts
export const STATIC_LOCALE_PARAMS = [
  { country: "pl", lang: "pl" },
  { country: "us", lang: "en" },
];
```

Pozostałe locale są generowane **dynamicznie** przy pierwszym requeście. Każde locale dostaje własne tagi (`data:posts:de:fr` itd.).

---

## Pliki referencyjne

| Plik | Rola |
|------|------|
| `next.config.ts` | `cacheComponents`, `cacheHandlers` |
| `cache-handlers/remote-handler.js` | LRU + Redis + Pub/Sub + single-flight |
| `lib/cache-tags.ts` | Konwencja tagów `data:*` / `ui:*` |
| `lib/data/*.ts` | Funkcje DATA z `use cache: remote` |
| `components/cached-*.tsx` | Komponenty UI z `use cache: remote` |
| `app/actions/revalidate.ts` | Invalidacja per zasób + locale |
| `app/actions/cache-lab.ts` | Demo wszystkich API invalidacji |
| `app/[country]/[lang]/cache-lab/page.tsx` | Interaktywny lab cache |

---

## Szybka ściągawka

```
Dodaj cache:     "use cache: remote" + cacheLife() + cacheTag(dataTag/uiTag())
Czytaj Redis:    index:* = indeks | {cacheKey} = dane | meta:revalidated-at:* = timestamp
Invaliduj dane:  updateTag("data:posts:pl:pl")     — natychmiast
Invaliduj UI:    updateTag("ui:posts:pl:pl")      — natychmiast
Invaliduj ścieżkę: revalidatePath("/pl/pl/posts")
Multi-instance:  Redis L2 + Pub/Sub (automatycznie w handlerze)
```
