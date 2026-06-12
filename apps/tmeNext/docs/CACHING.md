# Cachowanie w tmeNext — przewodnik

Next.js 16 z **Cache Components** + własny handler `use cache: remote`
(`cache-handlers/remote-handler.mjs`): LRU w procesie → wspólny Redis → Pub/Sub.
Zaprojektowane pod **wiele instancji z jednego artefaktu `.next`** (u nas: 8 kontenerów
z jednego obrazu).

---

## 1. Obraz całości

```mermaid
flowchart LR
    subgraph Instancja["Instancja Next.js (x8, jeden obraz)"]
        APP["Strona / komponent<br/>'use cache: remote'"]
        L1["L1: LRU w procesie<br/>500 wpisów / 50 MB / TTL 15 s"]
    end
    R[("L2: Redis<br/>wspólny dla wszystkich")]
    PS(("Pub/Sub<br/>pubsub:invalidate"))

    APP --> L1
    L1 -- "miss" --> R
    R -- "hit → kopia do L1" --> L1
    R --- PS
    PS -- "invalidacja → czyść L1" --> L1
```

| Warstwa | Gdzie żyje | Po co | Po restarcie |
|---|---|---|---|
| L1 — LRU | pamięć procesu | zero round-tripów przy gorącym ruchu | ginie |
| L2 — Redis | osobny serwer | współdzielenie między instancjami | trwały |
| Pub/Sub | kanał w Redis | natychmiastowe czyszczenie L1 wszędzie | bezstanowy |

---

## 2. Jak cachować (przepis)

Dwie osobne warstwy = dwa osobne wpisy, każdy z **jednym tagiem 1:1**
(zawsze per locale, bez tagów globalnych). Pomocniki: `lib/cache-tags.ts`.

```ts
// DATA — wynik fetcha (lib/data/posts.ts)
export async function getPosts(country: string, lang: string) {
  "use cache: remote";
  cacheLife("hours");
  cacheTag(dataTag("posts", country, lang));   // → "data:posts:pl:pl"
  return fetch(...).then(r => r.json());
}

// UI — wyrenderowany komponent (components/cached-posts-list.tsx)
export async function CachedPostsList({ country, lang }) {
  "use cache: remote";
  cacheLife("hours");
  cacheTag(uiTag("posts", country, lang));     // → "ui:posts:pl:pl"
  const data = await getPosts(country, lang);
  return <ul>...</ul>;
}
```

Zasady:

- Wewnątrz `use cache` nie wolno czytać `cookies()` / `headers()` / `searchParams` —
  wszystko dynamiczne przekazuj **argumentami** (wchodzą do klucza cache).
- UI woła DATA w środku — przy hicie na UI funkcja DATA **nie wykona się** (dane są
  zamrożone we wpisie UI). Dlatego invaliduje się zwykle **oba tagi**.
- `cacheLife` steruje czasem życia; invalidacja tagami działa **niezależnie** od niego.

---

## 3. Odczyt — co robi `get()`

```mermaid
flowchart TD
    A["get(cacheKey)"] --> B{"świeży wpis w LRU?"}
    B -- "tak" --> OK1(["zwróć z L1"])
    B -- "nie" --> C{"Redis dostępny?"}
    C -- "nie (awaria/cooldown)" --> MISS(["undefined → Next renderuje"])
    C -- "tak" --> D{"świeży wpis w Redis?"}
    D -- "tak" --> OK2(["zapisz do L1 i zwróć"])
    D -- "nie" --> E{"ktoś trzyma locka?"}
    E -- "tak" --> F["czekaj na wynik<br/>(poll co 100 ms, max ~5 s)"]
    F -- "wpis się pojawił" --> OK2
    F -- "timeout" --> G
    E -- "nie" --> G{"przejmij locka (SET NX)"}
    G -- "udało się" --> MISS2(["undefined → TA instancja renderuje,<br/>set() zapisze wynik i zwolni locka"])
    G -- "nie" --> F
```

„Świeży" znaczy: nie minął `revalidate` wpisu **i** żaden z jego tagów (ani soft-tagów
ścieżki) nie był invalidowany po `entry.timestamp`.

### Single-flight w praktyce

Przy zimnym kluczu i nagłym ruchu (thundering herd) renderuje **jedna** instancja:

```mermaid
sequenceDiagram
    participant A as Instancja A
    participant R as Redis
    participant B as Instancje B–H

    A->>R: SET lock:{key} instanceId NX EX 30
    R-->>A: OK (lock przejęty)
    B->>R: SET lock:{key} ... NX
    R-->>B: null (zajęte) → polling GET {key}
    Note over A: render (np. fetch do API)
    A->>R: SET {key} payload + SADD index:{tag}
    A->>R: DEL lock (tylko jeśli nadal mój — skrypt Lua)
    B->>R: GET {key}
    R-->>B: payload → wszyscy serwują ten sam wynik
```

Wartość locka = `instanceId` (PID + losowe 48 bitów — PID-y w kontenerach się
powtarzają), a zwolnienie to atomowy compare-and-delete w Lua: render dłuższy niż
30 s nie skasuje locka przejętego już przez kogoś innego.

Zweryfikowane testem k6 (`apps/tmeNext-K6Test`): 240 żądań z 80 VU na zimny URL
przez 8 instancji → **1 render**.

---

## 4. Invalidacja

### Przepływ między instancjami

```mermaid
sequenceDiagram
    participant SA as Server Action<br/>(instancja A)
    participant R as Redis
    participant B as Instancje B–H

    SA->>SA: updateTag("data:posts:pl:pl")
    SA->>R: SMEMBERS index:{tag} → lista wpisów
    SA->>R: DEL wpisy + DEL index<br/>SET meta:revalidated-at:{tag} = now (TTL 7 dni)
    SA->>R: PUBLISH pubsub:invalidate {tags, keys}
    R-->>B: komunikat Pub/Sub
    B->>B: usuń pasujące wpisy z LRU
    Note over B: nawet jeśli komunikat przepadł:<br/>refreshTags() przed requestem porówna<br/>timestamp tagu z timestampem wpisu
```

Podwójne zabezpieczenie: Pub/Sub (szybkie) + timestampy `meta:revalidated-at:*`
(trwałe, synchronizowane w `refreshTags()` przed każdym requestem).

### Które API kiedy

| API | Świeże dane | Typowy use case |
|---|---|---|
| `updateTag(tag)` | natychmiast (ten sam request) | Server Action po mutacji |
| `revalidateTag(tag, "max")` | następny request (SWR) | webhook, cron, route handler |
| `revalidatePath(path)` | następny request (soft tagi) | zmiana całej strony |

### Uwaga: dwie warstwy o różnej szybkości

Handler invaliduje wpisy **natychmiast i na wszystkich instancjach**. Ale strona ma
jeszcze **full route cache** (ISR, np. `s-maxage=60`), który jest per instancja —
zbuforowany HTML z osadzonymi starymi danymi żyje aż do upływu `revalidate` strony:

```mermaid
timeline
    title Co widzi użytkownik po updateTag (strona z revalidate = 60 s)
    t+0 ms : updateTag — wpisy znikają z Redis : Pub/Sub czyści LRU wszędzie
    t+? : każda instancja serwuje swój zbuforowany HTML : aż jej wpis route'a się zestarzeje (≤ 60 s)
    t+60 s max : re-render route'a pobiera świeże dane z Redis : wszyscy widzą nowe dane
```

Pomiar k6: propagacja end-to-end od ~40 ms (wpis route'a już nieświeży) do ~56 s
(świeży). Jeśli potrzebna natychmiastowa spójność HTML — krótszy `revalidate` strony
albo współdzielony `cacheHandler` ISR.

---

## 5. Klucze w Redis

| Klucz | Typ | Co to jest |
|---|---|---|
| `{cacheKey z ";" zamiast ":"}` | STRING (binarny v8) | wpis cache (payload + `_meta`), TTL = `max(expire, 60)` s |
| `lock:{cacheKey}` | STRING | lock single-flight, TTL 30 s |
| `index:{tag}` | SET | klucze wpisów z danym tagiem, TTL = TTL wpisu + 60 s |
| `meta:revalidated-at:{tag}` | STRING | timestamp ostatniej invalidacji, TTL 7 dni |
| `meta:revalidated-tags` | SET | rejestr invalidowanych tagów (przycinany w `refreshTags`) |

Czemu `;` zamiast `:` w kluczach wpisów? `cacheKey` Next.js to JSON ze `:` w środku,
a Redis Insight buduje drzewo po `:` — surowy klucz rozpadałby się na śmieciowe
gałęzie. Tagi (`index:…`, `meta:…`) celowo zostają ze `:`, żeby drzewo grupowało się
w `index:data` / `index:ui`. Member w `index:{tag}` = dokładnie nazwa klucza wpisu (1:1).

Drzewo w Redis Insight (http://localhost:5540):

```
index:
  data:cache-lab:pl:pl        ← SET; members = klucze wpisów
  ui:cache-lab:pl:pl
meta:
  revalidated-at:data:…       ← timestampy (liczba, nie cache!)
  revalidated-tags
lock:…                        ← chwilowe locki renderu
["abc…","hash…",[{"country";"pl"…}]]   ← wpis; w polu _meta: layer/resource/locale/createdAt
```

---

## 6. Odporność na awarię Redis

Handler **nigdy nie blokuje aplikacji** — bez Redisa działa na samym LRU
(mniej wydajnie, ale poprawnie).

```mermaid
stateDiagram-v2
    [*] --> Ready : connect()
    Ready --> Reconnecting : zerwane połączenie
    Reconnecting --> Ready : udało się (≤ 5 prób, ~5 s)
    Reconnecting --> Dead : próby wyczerpane ("end")
    Dead --> Cooldown : reset klienta + 30 s przerwy
    Cooldown --> Ready : nowe połączenie po cooldownie
    note right of Dead
        klient ioredis po "end" jest martwy na zawsze —
        handler zeruje referencje (główny klient i Pub/Sub),
        żeby następne żądanie zbudowało świeże połączenie
    end note
```

Zachowanie w czasie awarii (zweryfikowane na stacku docker-compose):

- requesty dostają 200 — L1 + render na żywo, błędy tylko w logach,
- invalidacje wykonane **podczas** awarii obowiązują tylko lokalnie (znana granica —
  nie ma ich gdzie trwale zapisać),
- po powrocie Redisa: nowe połączenie po cooldownie ≤ 30 s, zapisy wracają,
  subskrypcje Pub/Sub odtwarzają się przy pierwszym żądaniu z `use cache: remote`.

Ważne dla prod: format `v8.serialize` jest związany z wersją Node — wszystkie
instancje muszą mieć tę samą wersję runtime (jeden obraz Docker to gwarantuje).

---

## 7. Wiele instancji (docker-compose)

```mermaid
flowchart TD
    LB["ruch / k6"] --> I1["tme-next-1"] & I2["tme-next-2"] & IN["… tme-next-8"]
    I1 & I2 & IN --> R[("redis")]
    R -.->|Pub/Sub| I1 & I2 & IN
```

- Jeden obraz `tme-next:local` = jeden artefakt `.next` dla wszystkich instancji.
- Sticky sessions **nie są potrzebne** — spójność zapewnia Redis + Pub/Sub + timestampy.
- Build obrazu działa bez Redisa: handler wykrywa `NEXT_PHASE=phase-production-build`
  i używa wyłącznie LRU procesu builda.

Testy obciążeniowe (scenariusze, wyniki, jak uruchomić): `apps/tmeNext-K6Test/README.md`.

---

## 8. Jak dodać nowy zasób (checklist)

1. Dodaj nazwę do `CacheResource` w `lib/cache-tags.ts`.
2. Funkcja DATA: `"use cache: remote"` + `cacheLife(...)` + `cacheTag(dataTag("orders", country, lang))`.
3. Komponent UI: jak wyżej, z `uiTag(...)`.
4. Server Action po mutacji: `updateTag(dataTag(...))` + `updateTag(uiTag(...))`.
5. Sprawdź w Redis Insight, że pojawiły się `index:data:orders:…` i `index:ui:orders:…`.

Wzorce: `lib/data/posts.ts`, `components/cached-posts-list.tsx`, `app/actions/revalidate.ts`.
Interaktywne demo wszystkich API: strona `/{country}/{lang}/cache-lab`.

---

## 9. Uruchomienie

```bash
# pełny stack: redis + redisinsight + 8x tmeNext (porty 3000-3007)
docker compose up -d --build

# dev na hoście (wymaga redis na localhost:6379 i wolnego portu 3000)
npx nx dev tmeNext
```

| Serwis | URL |
|---|---|
| Aplikacja | http://localhost:3000 … :3007 (każdy port = inna instancja) |
| Redis Insight | http://localhost:5540 |
| Redis | `redis://localhost:6379` (w kontenerach: `redis://redis:6379`) |

Konfiguracja (`apps/tmeNext/next.config.ts`):

```ts
const nextConfig: NextConfig = {
  output: "standalone",                // wymagane dla obrazu Docker
  cacheComponents: true,
  cacheHandlers: {
    remote: require.resolve("./cache-handlers/remote-handler.mjs"),
  },
};
```

---

## Ściągawka

```
Cache:            "use cache: remote" + cacheLife() + cacheTag(dataTag/uiTag(...))
Invalidacja:      updateTag(tag) — natychmiast | revalidateTag(tag, "max") — SWR
Pamiętaj:         UI zamraża DATA → invaliduj oba tagi
HTML konwerguje:  ≤ revalidate strony (full route cache jest per instancja)
Redis padł?       Aplikacja działa na LRU; reconnect ≤ 30 s po powrocie
Czytanie Redis:   index:* = indeksy | meta:* = timestampy | reszta = wpisy (v8)
```
