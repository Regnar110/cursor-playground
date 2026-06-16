# ADR-0001: Zdalny cache `use cache: remote` na własnym handlerze (LRU + Redis + Pub/Sub)

- **Status:** Zaakceptowana
- **Data:** 2026-06-12
- **Decydenci:** zespół tmeNext
- **Powiązane:** [docs/CACHING.md](../CACHING.md) (szczegóły implementacji), `packages/cache-handler`, testy: `packages/cache-handler/__tests__/`, `apps/tmeNext-K6Test`

## Kontekst i problem

Aplikacja działa jako **wiele instancji Next.js 16 (Cache Components) z jednego
artefaktu `.next`** (u nas: 8 kontenerów z jednego obrazu za nginx). Wbudowany cache
`use cache` jest in-process — każda instancja trzyma własną kopię, co przy N instancjach
oznacza:

- N niezależnych renderów tych samych danych (mnożenie ruchu do API/DB),
- brak spójnej invalidacji — `updateTag` na instancji A nie unieważnia kopii na B–H,
- utratę całego cache przy każdym restarcie/deployu.

Potrzebujemy współdzielonego cache z celowaną invalidacją tagami, odpornego na awarię
backendu cache i na nagły ruch na zimne klucze (thundering herd).

## Rozważane opcje

1. **Wbudowany cache in-process + sticky sessions** — zero pracy, ale nie rozwiązuje
   invalidacji między instancjami ani zimnego startu; sticky sessions wiążą użytkownika
   z instancją i komplikują skalowanie. Odpada.
2. **Gotowy handler społecznościowy (np. `@neshca/cache-handler`)** — szybki start,
   ale projektowane pod stary interfejs `cacheHandler` (ISR), nie pod
   `cacheHandlers.remote` z Next 16 / Cache Components; brak kontroli nad single-flight
   i schematem kluczy (czytelność w Redis Insight była wymaganiem). Odpada.
3. **Hosting na Vercel (Runtime Cache)** — rozwiązuje problem platformowo, ale aplikacja
   ma działać na własnej infrastrukturze (kontenery). Odpada.
4. **Własny handler `use cache: remote`: L1 (LRU in-process) + L2 (Redis) + Pub/Sub +
   single-flight** — pełna kontrola nad semantyką, kosztem utrzymania własnego kodu
   infrastrukturalnego. **Wybrana.**

## Decyzja

Implementujemy własny cache handler (paczka `@tme/cache-handler`) podpięty pod
`cacheHandlers.remote` w `next.config.ts`. Architektura:

- **L1: LRU w procesie** (500 wpisów / 50 MB / TTL 15 s) — tnie round-tripy do Redis
  przy gorącym ruchu.
- **L2: Redis** — wspólny dla wszystkich instancji; wpisy serializowane `v8.serialize`
  z TTL = `max(expire, 60)` s; klucze czytelne w Redis Insight (`:` → `;` w cacheKey,
  indeksy `index:{tag}`, metadane `meta:*`).
- **Pub/Sub** (`pubsub:invalidate`) — po invalidacji wszystkie instancje natychmiast
  czyszczą L1.
- **Backstop timestampów** (`meta:revalidated-at:{tag}`, TTL 7 dni) — spójność nawet
  przy przegapionym komunikacie Pub/Sub (restart, chwilowy brak połączenia).
- **Single-flight** — lock `SET NX` (TTL 30 s) z wartością `instanceId` i atomowym
  compare-and-delete w Lua; przy cache miss renderuje jedna instancja, reszta czeka.
- **Degradacja zamiast awarii** — bez Redis (build, awaria, cooldown 30 s) handler
  działa na samym L1; po permanentnej śmierci klienta ioredis (`end`) referencje są
  zerowane i połączenie odtwarza się po cooldownie.

Tagi są generyczne: `{warstwa}:{zasób}[:{scope...}]` — jeden tag 1:1 na wpis, scope
opcjonalny (locale, id encji, brak = zasób globalny). Świadomie **nie** współdzielimy
full route cache (ISR) — patrz konsekwencje.

## Konsekwencje

### Pozytywne

- Spójna invalidacja między instancjami: handler natychmiast (Pub/Sub + kasowanie
  wpisów), zmierzone k6 na 8 instancjach.
- Thundering herd rozwiązany: 240 równoległych żądań na zimny klucz → **1 render**
  (test k6 single-flight).
- Awaria Redis nie kładzie aplikacji: fallback na L1, automatyczny powrót ≤ 30 s
  po odzyskaniu połączenia (zweryfikowane na stacku docker-compose).
- Deploy/restart nie zeruje cache — L2 przeżywa wymianę instancji.
- Czytelny stan w Redis Insight (drzewo `index:*` / `meta:*`, pole `_meta` w payloadzie).

### Negatywne / koszty

- **Własny kod infrastrukturalny** (~800 linii) — utrzymujemy go sami; ryzyko ograniczone
  testami jednostkowymi (Jest, 17 testów) i obciążeniowymi (k6, 3 scenariusze).
- **Format `v8.serialize` jest związany z wersją Node** — wszystkie instancje muszą mieć
  ten sam runtime; gwarantuje to wspólny obraz Docker, ale rolling deploy ze zmianą wersji
  Node wymaga uwagi (stare wpisy będą nieczytelne → traktowane jak miss).
- **Full route cache pozostaje per instancja** — po invalidacji HTML konwerguje w czasie
  ≤ `revalidate` strony (np. 60 s); natychmiastowa spójność dotyczy warstwy danych,
  nie zbuforowanego HTML-a. Akceptujemy to okno; alternatywa (współdzielony
  `cacheHandler` ISR) opisana w CACHING.md §4.
- **Invalidacja podczas awarii Redis obowiązuje tylko lokalnie** — nie ma jej gdzie
  trwale zapisać; po powrocie Redis pozostałe instancje mogą serwować starsze dane
  do TTL wpisu.
- Redis staje się elementem krytycznym operacyjnie (monitoring, pamięć, `maxmemory-policy`).

### Neutralne / do obserwacji

- `refreshTags()` wykonuje `SMEMBERS` + `MGET` przed requestem — koszt rośnie z liczbą
  invalidowanych tagów (przycinane po TTL 7 dni). Przy dużej kardynalności tagów rozważyć
  throttle (np. odświeżanie co 1–2 s).
- Profil `cacheLife("max")` daje wpisom praktycznie nieskończony TTL w Redis — wymaga
  `maxmemory` + polityki evictionu po stronie Redis albo capa TTL w handlerze.

## Weryfikacja

- **Testy jednostkowe**: `npx nx test tmeNext` — semantyka kluczy/TTL, single-flight,
  compare-and-delete locka, backstop, fallback i reconnect.
- **Testy obciążeniowe**: `apps/tmeNext-K6Test` (8 instancji w kontenerach) —
  ~668 req/s bez błędów, p95 128 ms; single-flight = 1 render; propagacja invalidacji
  zgodna z opisanym oknem SWR.
- **Test awarii**: zatrzymanie Redis na żywym stacku → 200-ki przez cały czas,
  automatyczny powrót do L2 po starcie Redis.
- Rewizja decyzji: gdy pojawi się wymóg natychmiastowej spójności HTML między
  instancjami (→ współdzielony ISR) albo problem z kardynalnością tagów.
