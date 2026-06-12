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
Format tagu: `{warstwa}:{zasób}[:{scope...}]` — scope jest **opcjonalny** i dowolny
(locale, id encji, wariant… albo nic, gdy zasób jest globalny). Pomocniki: `lib/cache-tags.ts`.

```ts
dataTag("config")                  // "data:config"        — zasób globalny
dataTag("posts", country, lang)    // "data:posts:pl:pl"   — scope = locale
uiTag("products", productId)       // "ui:products:42"     — scope = id encji
```

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
["abc…","hash…",[{"country";"pl"…}]]   ← wpis; w polu _meta: layer/resource/scope/createdAt
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
    U["ruch (http://localhost:8080)"] --> LB["nginx<br/>least_conn + failover"]
    LB --> I1["tme-next-1"] & I2["tme-next-2"] & IN["… tme-next-8"]
    K6["k6 (testy per instancja)"] -.-> I1 & I2 & IN
    I1 & I2 & IN --> R[("redis")]
    R -.->|Pub/Sub| I1 & I2 & IN
```

- Wejście dla użytkownika: **nginx na :8080** (`nginx/default.conf`) — `least_conn`,
  `proxy_next_upstream` (padnięta instancja jest pomijana), nagłówek `X-Upstream`
  do debugowania. Porty 3000–3007 zostają jako bezpośredni dostęp per instancja.
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

## 10. Słowniczek

### Pojęcia Next.js

| Pojęcie | Co to znaczy |
|---|---|
| **Cache Components** | Tryb Next.js 16 (`cacheComponents: true`), w którym cachowanie jest jawne: cachuje się tylko to, co oznaczysz dyrektywą `use cache`. Włącza też PPR. |
| **PPR (Partial Prerendering)** | Strona = statyczna powłoka (prerenderowana) + dynamiczne fragmenty dostreamowane w runtime. W buildzie oznaczone `◐`. |
| **`use cache: remote`** | Dyrektywa: "wynik tej funkcji/komponentu cachuj przez handler `remote`" — czyli nasz LRU + Redis. Zwykłe `use cache` używa wbudowanego handlera in-process. |
| **cacheKey** | Klucz wpisu generowany przez Next.js z id funkcji + jej argumentów (dlatego wszystko dynamiczne przekazuje się argumentami). Dla handlera to nieprzezroczysty string. |
| **Tag (`cacheTag`)** | Etykieta wpisu nadawana przez nas, do celowanej invalidacji. U nas format `{warstwa}:{zasób}[:{scope...}]`, jeden tag 1:1 na wpis. |
| **Scope** | Opcjonalna część tagu zawężająca wpis: locale (`pl:pl`), id encji (`42`), wariant… Brak scope = zasób globalny. |
| **Soft tag** | Tag generowany automatycznie przez Next.js ze ścieżki routingu (`_N_T_/pl/pl/posts`). Używany przez `revalidatePath` — handler dostaje je w `get()` jako `softTags`. |
| **`cacheLife`** | Profil czasu życia wpisu: `stale` (jak długo klient nie pyta serwera), `revalidate` (po jakim czasie odświeżyć), `expire` (po jakim czasie wpis jest bezużyteczny). |
| **`updateTag`** | Invalidacja natychmiastowa (tylko Server Actions) — ten sam request widzi już świeże dane. |
| **`revalidateTag(tag, profil)`** | Invalidacja SWR — bieżący request może dostać starą wersję, świeża przy następnym. Działa też w route handlerach. |
| **`revalidatePath`** | Invalidacja wszystkiego, co powiązane ze ścieżką URL (przez soft tagi). |
| **SWR (stale-while-revalidate)** | Strategia: serwuj starą wersję od razu, odśwież w tle. Mniejsza latencja kosztem chwilowej nieświeżości. |
| **Full route cache (ISR)** | Cache całego wyrenderowanego HTML strony (nagłówek `s-maxage=60`). **Osobna warstwa nad naszym handlerem**, per instancja — stąd okno konwergencji po invalidacji (sekcja 4). |
| **Cache handler** | Nasza implementacja interfejsu Next.js: `get` / `set` / `refreshTags` / `getExpiration` / `updateTags`. Next woła te metody, my decydujemy gdzie i jak trzymać dane. |

### Pojęcia handlera (remote-handler.mjs + Redis)

| Pojęcie | Co to znaczy |
|---|---|
| **L1 / LRU** | Cache w pamięci procesu (500 wpisów / 50 MB / TTL 15 s). Najszybszy, ale prywatny dla instancji i ginie z procesem. |
| **L2 / Redis** | Wspólny cache wszystkich instancji. Wpis trafia tu przy `set()`, a hit kopiowany jest do L1. |
| **Warstwa DATA / UI** | Dwa niezależne wpisy: DATA = wynik fetcha (tag `data:*`), UI = wyrenderowany komponent (tag `ui:*`). UI "zamraża" w sobie dane, dlatego invaliduje się zwykle oba. |
| **Wpis (entry)** | Payload + metadane (`tags`, `timestamp`, `revalidate`, `expire`, `stale`), serializowane przez `v8.serialize` do binarnego STRING-a w Redis. |
| **`v8.serialize`** | Natywna serializacja Node — szybka i obsługuje Buffery, ale format zależy od wersji Node: wszystkie instancje muszą mieć ten sam runtime. |
| **Kodowanie klucza (`:` → `;`)** | cacheKey zawiera JSON ze `:`, a Redis Insight buduje drzewo po `:` — podmiana na `;` trzyma cały wpis jako jeden węzeł. Tagi zostają ze `:` (grupują się w drzewo). |
| **`index:{tag}`** | SET w Redis: tag → klucze wpisów, które go noszą. Dzięki temu `updateTags` wie, co skasować. Member = dokładnie nazwa klucza wpisu (1:1). |
| **`meta:revalidated-at:{tag}`** | Timestamp ostatniej invalidacji tagu (TTL 7 dni). To **backstop**: wpis starszy niż ten timestamp jest odrzucany przy odczycie, nawet jeśli kasowanie go ominęło. |
| **`meta:revalidated-tags`** | Rejestr (SET) tagów, które kiedykolwiek invalidowano — `refreshTags()` wie, o które timestampy pytać; wygasłe są przycinane. |
| **Backstop** | Drugi mechanizm spójności obok Pub/Sub: porównanie timestampów działa nawet, gdy instancja przegapiła komunikat (restart, chwilowy brak połączenia). |
| **Pub/Sub** | Kanał `pubsub:invalidate` w Redis. Po invalidacji każda instancja dostaje komunikat i czyści swoje L1 — bez czekania na TTL. |
| **Single-flight** | Gwarancja, że przy cache miss renderuje **jedna** instancja, reszta czeka na jej wynik (polling co 100 ms, max ~5 s). Chroni API/DB przed lawiną identycznych renderów. |
| **Thundering herd** | Problem, który single-flight rozwiązuje: nagły ruch na zimny klucz → bez locka każda instancja renderowałaby to samo równolegle. |
| **Lock (`lock:{cacheKey}`)** | Klucz w Redis zdobywany przez `SET NX` z TTL 30 s — "ja renderuję". Zwalniany po `set()`. |
| **`instanceId`** | Wartość locka: `pid-{pid}-{48 bitów losowych}`. Losowy sufiks jest konieczny — PID-y w kontenerach się powtarzają. |
| **Compare-and-delete** | Atomowy skrypt Lua zwalniający lock **tylko jeśli nadal należy do nas**. Bez tego render dłuższy niż TTL locka kasowałby lock przejęty już przez inną instancję. |
| **Cooldown** | Po nieudanym połączeniu z Redis handler przez 30 s nie ponawia prób i działa na samym L1 — zamiast dobijać się do martwego serwera przy każdym requeście. |
| **Fallback LRU-only** | Tryb awaryjny bez Redis: wszystko działa, ale cache jest per instancja i invalidacje nie propagują się między instancjami. |
| **`_meta`** | Pole doklejane do payloadu w Redis (layer/resource/scope/tags/createdAt) — wyłącznie do debugowania w Redis Insight, Next.js go nie widzi. |
| **Instancja** | Jeden proces Next.js. U nas: 8 kontenerów z tego samego obrazu (= jeden artefakt `.next`), każdy z własnym L1 i `instanceId`, wspólny Redis. |

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
