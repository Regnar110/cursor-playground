# Code review: `@tme/cache-handler` — pokrycie, luki, kierunek rozwoju

Data przeglądu: 2026-07-11. Zakres: `packages/cache-handler/src/**`, testy w `__tests__/`,
konsument `apps/tmeNext` (`next.config.ts`, `lib/invalidate-remote.ts`). Punkt odniesienia:
kontrakt `CacheHandler` z oficjalnej dokumentacji Next.js 16
(`node_modules/next/dist/docs/.../cacheHandlers.md`).

---

## 1. Co handler pokrywa (i robi dobrze)

### Kontrakt Next.js

| Metoda | Status | Uwagi |
|---|---|---|
| `get(cacheKey, softTags)` | ✅ | L1 → L2 → single-flight; sprawdza świeżość (revalidate + hard/soft tagi) |
| `set(cacheKey, pendingEntry)` | ✅ | awaituje promise, buforuje stream, pendingSets daje read-your-own-writes w procesie |
| `refreshTags()` | ✅ | `SMEMBERS meta:revalidated-tags` + jeden `MGET`, przycina wygasłe wpisy |
| `getExpiration(tags)` | ✅ | max z lokalnej mapy timestampów (spójne z tym, że framework woła wcześniej `refreshTags`) |
| `updateTags(tags)` | ✅ | timestampy + kasowanie L1/L2 po odwróconym indeksie + Pub/Sub broadcast |

### Architektura wieloinstancyjna

- **L1 (LRU in-process)** — limit wpisów i rozmiaru (`max`, `maxSize`, `sizeCalculation`),
  krótki TTL (domyślnie 15 s) jako dodatkowy bezpiecznik na stale.
- **L2 (Redis)** — współdzielony między instancjami, TTL wpisu z `entry.expire`.
- **Single-flight** — atomowy lock `SET NX EX`, wartość = `instanceId`, zwolnienie przez
  Lua compare-and-delete. Poprawnie rozwiązany check-then-act (patrz
  `apps/tmeNext/docs/REDIS-NUANCES.md` pkt 1–2).
- **Pub/Sub** — natychmiastowe czyszczenie L1 na wszystkich instancjach; osobne połączenie
  dla subskrybenta (wymóg protokołu Redis).
- **Backstop timestampów** — `meta:revalidated-at:{tag}` + `refreshTags` przed requestem
  gwarantują poprawność nawet przy zgubionym komunikacie Pub/Sub. To jest właściwy model:
  Pub/Sub = optymalizacja latencji, timestampy = gwarancja poprawności.

### Odporność na awarie

- `lazyConnect`, `enableOfflineQueue: false`, ograniczony `retryStrategy` — requesty HTTP
  nie wiszą na martwym Redisie.
- Obsługa zdarzenia `end` (martwy klient ioredis) + 30 s cooldown + odtworzenie połączenia —
  naprawiony realny bug permanentnej degradacji do L1.
- Wyłączenie w fazie builda (`NEXT_PHASE=phase-production-build`).
- Wszystkie ścieżki `get`/`set`/`updateTags`/`refreshTags` łapią wyjątki — awaria cache
  nigdy nie wywala requestu, degraduje do miss/L1.

### Detale Redis zrobione świadomie

- `getBuffer` zamiast `get` — binarny payload `v8.serialize` nie jest korumpowany przez UTF-8.
- `EXPIRE NX` + `EXPIRE GT` na indeksach tagów — nowy indeks dostaje TTL, krótki wpis nie
  skraca życia indeksu (pułapka „GT pomija klucze bez TTL" odkryta empirycznie).
- Pipeline `MULTI` z zachowaną kolejnością payload → indeks (indeks nigdy nie wskazuje
  na nieistniejący wpis).
- Odwrócony indeks `index:{tag}` zamiast `KEYS`/`SCAN` przy invalidacji.
- Enkodowanie `:` → `;` w cacheKey — czytelne drzewo w Redis Insight.

### Testy i dokumentacja

- 7 plików testowych na FakeRedis: get/set, single-flight (lock, compare-and-delete,
  czekanie na wynik peera), awarie Redis (LRU-only, reconnect po cooldownie), updateTags,
  refreshTags, TTL indeksów, debug.
- Dokumentacja ponadprzeciętna: ARCHITECTURE, INVALIDATION, REDIS-NUANCES z uzasadnieniem
  „czemu ten kod wygląda dziwnie".

---

## 2. Czego handler NIE pokrywa

### 2.1. Brak stale-while-revalidate — najważniejsza luka semantyczna

`isExpired()` w `src/handler/stale.ts` traktuje `revalidate` jako twardy koniec życia wpisu:

```
Date.now() > entry.timestamp + entry.revalidate * 1000  →  odrzuć
```

Tymczasem kontrakt `CacheEntry` rozróżnia trzy okna: `revalidate` (kiedy odświeżyć),
`expire` (jak długo wolno serwować), `stale` (staleness po stronie klienta). Domyślny
handler Next.js (`node_modules/next/dist/server/lib/cache-handlers/default.js`) rozróżnia
tag **expired** (odrzuć wpis) od tag **stale** — w tym drugim przypadku **zwraca wpis
z `revalidate: -1`**, co sygnalizuje frameworkowi „serwuj stale, odśwież w tle" (SWR).
Uwaga: dla czystego in-memory default celowo skraca życie do `revalidate` (komentarz
w źródle: nie warto grzać wpisu, który i tak wypadnie z LRU) — ale dla trwałego L2
w Redis ten argument nie obowiązuje; tu okno `revalidate`–`expire` ma realną wartość.

**Skutek obecnego kodu:** każde przekroczenie `revalidate` = blokujący miss i pełny render
na ścieżce requestu (złagodzony single-flightem, ale nadal jeden użytkownik czeka na cały
render). Tracimy główną zaletę modelu `revalidate < expire`.

### 2.2. Invalidacja podczas awarii Redis jest trwale gubiona dla innych instancji

W `updateTags` przy `redis === null`: lokalny L1 i lokalne timestampy są aktualizowane,
ale `meta:revalidated-at:*` nie zostaje zapisane, a `publishInvalidation` jest no-opem
(w tej gałęzi to martwe wywołanie — `getRedis()` znów zwróci `null`). Po powrocie Redisa
nikt tej invalidacji nie odtworzy — pozostałe instancje serwują stare dane z L2 aż do TTL.
Brak jakiejkolwiek kolejki retry / oznaczenia „do nadrobienia".

### 2.3. Pub/Sub nie aktualizuje lokalnych timestampów

Subskrybent (`pubsub.ts`) czyści L1 po tagach/kluczach, ale **nie** zapisuje
`localTagTimestamps`. Payload nie niesie czasu invalidacji. Poprawność wisi w 100% na
`refreshTags` — jeśli ten się wywali (błąd Redis w trakcie), instancja może wciąż uznać
wpis promowany z L2/peera za świeży. Tanie domknięcie: dodać `ts` do payloadu i wpisywać
do mapy w handlerze wiadomości.

### 2.4. Skalowanie `refreshTags` z kardynalnością tagów

`refreshTags` robi `SMEMBERS` całego rejestru + `MGET` wszystkich tagów invalidowanych
w oknie 7 dni — **przy każdym requeście**. Przy tagach o wysokiej kardynalności
(np. per-produkt: tysiące invalidacji tygodniowo) każdy request płaci coraz droższy
round-trip. Brak mechanizmu „nic się nie zmieniło od ostatniego syncu → pomiń".

### 2.5. Single-flight: polling i krótkie okno czekania

- `waitForRemoteEntry` zaczyna od `setTimeout(100 ms)` — minimalna kara latencji nawet
  gdy wynik pojawia się natychmiast; potem polling co 100 ms.
- Czekanie max ~5 s (50 × 100 ms), lock żyje 30 s — render dłuższy niż 5 s powoduje, że
  waiterzy poddają się i renderują równolegle (herd wraca tylnymi drzwiami).
- Brak powiadomienia „wynik gotowy" (np. Pub/Sub na zwolnienie locka) zamiast pollingu.

### 2.6. Topologia i bezpieczeństwo połączenia

- `redisOptions()` wymaga jednocześnie `REDIS_HOST`, `REDIS_PORT` **i** `REDIS_PASSWORD` —
  Redis bez hasła (typowy lokalny dev) po cichu wyłącza cały L2. Zaskakujące i nieopisane.
- Brak TLS, brak Redis Sentinel / Cluster — tylko pojedynczy węzeł.
- Brak konfigurowalnego prefiksu kluczy — wpisy lądują w globalnej przestrzeni wybranego
  `REDIS_DB`; dwie aplikacje na tej samej bazie = kolizje.

### 2.7. Brak limitów i kontroli payloadu

- `readStreamToBuffer` buforuje wpis dowolnego rozmiaru i pcha go do Redis — brak górnego
  limitu rozmiaru wpisu, brak kompresji. Jeden wielki payload RSC może wypchnąć LRU
  (`maxSize` chroni L1, Redis nie ma odpowiednika per-wpis).
- Błędy per-komenda z `pipeline.exec()` są ignorowane (świadomy kompromis wg REDIS-NUANCES
  pkt 6, ale nawet log by pomógł w diagnostyce).

### 2.8. Obserwowalność produkcyjna

Istnieje tylko debug (`REMOTE_CACHE_DEBUG_ENABLED`) — świetny do developmentu, ale
write-only i wyłączany na produkcji. Brak stałych, tanich metryk: hit-rate L1/L2, latencje
get/set, liczba single-flight waitów/timeoutów, rozmiar LRU, stan połączenia. Bez tego nie
da się odpowiedzieć na „czy cache w ogóle działa na prodzie?".

### 2.9. Luki w testach

Brak pokrycia dla: subskrybenta Pub/Sub (czyszczenie L1 z wiadomości, malformed message),
`getExpiration`, timeoutu single-flight (waiter poddaje się i renderuje), wpisów z
`expire` ≈ nieskończoność, dużych payloadów, wyścigu `updateTags` vs `set` w locie
(wpis z `timestamp` sprzed invalidacji zapisany do Redis — poprawnie odrzucany na
odczycie, ale zajmuje miejsce do TTL).

### 2.10. Drobiazgi

- `durations.expire` w `updateTags` przyjęte i ignorowane (udokumentowane, OK — ale warto
  śledzić, czy Next zacznie na tym polegać).
- `apps/tmeNext/lib/invalidate-remote.ts` woła `updateTags` bezpośrednio, omijając kolejkę
  `updateTag()` Next.js — dobre do demo (read-your-own-writes), ale to obejście, które
  łatwo skopiować w kod produkcyjny bez zrozumienia konsekwencji (podwójna invalidacja,
  brak koordynacji z frameworkiem). Zasługuje na wyraźne ostrzeżenie.
- `v8.serialize` wiąże format z wersją Node — udokumentowane; przy rolling deploy ze zmianą
  wersji Node cache robi zimny start (świadomie zaakceptowane).

---

## 3. Kierunek rozwoju

### Priorytet 1 — poprawność i semantyka (przed produkcją)

1. **Stale-while-revalidate**: rozdzielić okna `revalidate`/`expire` w `isEntryFresh` —
   serwować wpis do `expire`, a po `revalidate` zwracać go z `revalidate: -1`
   (wzorzec z domyślnego handlera Next.js — framework wtedy odświeża w tle).
   To pojedynczo największy zysk latencji na hot-keyach.
2. **Timestamp w payloadzie Pub/Sub** + aktualizacja `localTagTimestamps` w subskrybencie —
   zamyka lukę 2.3 kilkoma liniami.
3. **Nadrabianie invalidacji po awarii Redis**: lokalny bufor „pending invalidations"
   flushowany przy pierwszym udanym `getRedis()` po cooldownie. Zamyka lukę 2.2.
4. **Dev bez hasła / TLS**: uczynić `REDIS_PASSWORD` opcjonalnym, dodać `REDIS_TLS`.
   Dodać konfigurowalny prefiks kluczy (`REMOTE_CACHE_KEY_PREFIX`).

### Priorytet 2 — skalowanie i wydajność

5. **Tani warunek pomijania `refreshTags`**: globalny licznik/timestamp
   (`meta:revalidations-version` inkrementowany w `updateTags`); instancja robi pełny
   `SMEMBERS+MGET` tylko gdy wersja się zmieniła. Redukuje koszt per-request z O(tagi)
   do O(1) w spokojnych okresach.
6. **Single-flight bez pollingu**: publikacja „entry ready" na kanale Pub/Sub po `set()`
   (lub sprawdzenie wpisu **przed** pierwszym sleep). Rozważyć wydłużenie/konfigurację
   okna czekania względem realnych czasów renderu (dziś 5 s vs lock 30 s — niespójne).
7. **Limit rozmiaru wpisu** (env, np. 2 MB) z logiem ostrzegawczym + opcjonalna kompresja
   (lz4/gzip) dla wpisów powyżej progu.

### Priorytet 3 — operacyjność

8. **Metryki produkcyjne** niezależne od debug: liczniki hit/miss/stale per warstwa,
   latencje, stan połączenia — eksponowane przez prosty endpoint lub OpenTelemetry.
   Debug (`cache-debug.ts`) zostaje narzędziem developerskim.
9. **Testy dla luk z 2.9** — zwłaszcza Pub/Sub i timeout single-flight; plus test
   obciążeniowy k6 (szkielet już jest w `apps/tmeNext-K6Test`) mierzący hit-rate
   i zachowanie pod invalidacją.
10. **Logowanie błędów pipeline** (per-komenda z `exec()`) na poziomie warn.

### Do rozważenia później (nie teraz)

- **RESP3 client-side caching** (Redis 6+ invalidation push) — mogłoby zastąpić własny
  Pub/Sub, ale to duża zmiana klienta; obecny model timestampów jest poprawny i prostszy.
- **Redis Cluster / Sentinel** — dopiero gdy pojedynczy węzeł stanie się realnym limitem;
  uwaga: `MULTI` na wielu slotach i Pub/Sub w clusterze zmieniają założenia.
- Wspólny handler dla `default` (`use cache`) — dziś tylko `remote`; decyzja produktowa,
  czy in-memory default wystarcza.

---

## 4. Podsumowanie

Kod jest dojrzały jak na swój etap: poprawnie rozwiązuje trudne problemy rozproszone
(single-flight, invalidacja z backstopem, degradacja przy awarii) i ma nietypowo dobrą
dokumentację decyzji. Główne ryzyka przed użyciem produkcyjnym to **brak SWR** (każde
przekroczenie `revalidate` blokuje request), **gubione invalidacje przy awarii Redis**
oraz **brak metryk produkcyjnych**. Te trzy rzeczy wyznaczają najbliższy sprint; reszta
to hartowanie (limity, TLS, testy) i skalowanie (`refreshTags`, polling).
