# Jak uruchomić aplikację i testy

Przewodnik po uruchamianiu `tmeNext` (Next.js + Redis cache) i testów w monorepo Nx.

## Wymagania

| Narzędzie | Wersja | Po co |
|---|---|---|
| **Node.js** | 22+ (jak w Dockerfile) | dev, build, testy Jest |
| **npm** | 9+ | zależności monorepo |
| **Docker Desktop** | aktualny | stack produkcyjny (8 instancji + Redis + nginx) i testy k6 |

---

## 1. Instalacja

```bash
git clone <repo>
cd cursor-playground
npm install
```

---

## 2. Stack Docker (zalecany sposób)

Pełne środowisko: Redis, Redis Insight, **8 instancji Next.js** z jednego obrazu, nginx jako load balancer.

```bash
docker compose up -d --build
```

Pierwszy build trwa kilka minut (build Next.js w kontenerze). Kolejne starty są szybsze.

### Adresy

| Usługa | URL | Opis |
|---|---|---|
| **Aplikacja (nginx)** | http://localhost:8080 | load balancer `least_conn` po 8 instancjach; nagłówek `X-Upstream` pokazuje, która instancja obsłużyła request |
| **Instancja 1–8** | http://localhost:3000 … :3007 | bezpośredni dostęp (debug, testy k6 per instancja) |
| **Redis Insight** | http://localhost:5540 | podgląd kluczy cache w Redis |
| **Redis** | `redis://localhost:6379` | z hosta; w kontenerach: `redis://redis:6379` |

Przykładowe strony:

- http://localhost:8080/pl/pl — strona główna
- http://localhost:8080/pl/pl/cache-lab — interaktywna demo cache
- http://localhost:8080/pl/pl/posts — lista postów (cache z tagami)

### Zarządzanie stackiem

```bash
docker compose ps                  # status kontenerów
docker compose logs -f tme-next-1  # logi jednej instancji
docker compose down                # zatrzymaj wszystko
docker compose down -v             # + usuń wolumeny Redis (czysty start)
docker compose up -d --build       # przebuduj po zmianach w kodzie
```

---

## 3. Dev na hoście (bez 8 instancji)

Do codziennej pracy nad kodem — jeden proces Next.js na maszynie developerskiej.

### Krok 1: Redis

Redis musi działać. Najprościej tylko Redis z compose:

```bash
docker compose up -d redis redisinsight
```

### Krok 2: Zmienne środowiskowe

```bash
cp apps/tmeNext/.env.example apps/tmeNext/.env
```

Plik `.env` ustawia połączenie z Redis (`REDIS_HOST`, `REDIS_PORT`, …). Bez `REDIS_HOST` handler cache działa tylko na lokalnym LRU (bez Redis L2 i Pub/Sub).

Pełna lista zmiennych (z domyślnymi wartościami) jest w `apps/tmeNext/.env.example`:

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `REDIS_HOST` | — (wymagane) | host Redisa |
| `REDIS_PORT` | `6379` | port |
| `REDIS_DB` | `0` | numer bazy |
| `REDIS_PASSWORD` | — | opcjonalne hasło |
| `SINGLE_FLIGHT_LOCK_TTL` | `30` | TTL locka single-flight (s) |
| `SINGLE_FLIGHT_POLLING_MS` | `100` | odstęp pollingu przy czekaniu (ms) |
| `SINGLE_FLIGHT_ATTEMPTS` | `50` | max prób pollingu |
| `TAG_META_TTL_SECONDS` | `604800` | TTL `meta:revalidated-at:*` (7 dni) |
| `REMOTE_CACHE_LRU_*` | patrz `.env.example` | parametry L1 LRU |

### Krok 3: Dev server

```bash
npx nx dev tmeNext
# albo skrót z root package.json:
npm run dev
```

Aplikacja: http://localhost:3000

### Build i start produkcyjny (lokalnie)

```bash
npx nx build tmeNext
npx nx start tmeNext
```

Na Windows (PowerShell) upewnij się, że `.env` jest skopiowany — Next.js ładuje go z `apps/tmeNext/.env`.

---

## 4. Testy jednostkowe (Jest)

Testują pakiet `@tme/cache-handler` (TypeScript → `dist/`) z mockiem Redis (FakeRedis) — bez działającego Redisa.

```bash
npm run test:cache-handler
# lub
npx nx test cache-handler
```

Co jest pokryte: roundtrip cache, klucze Redis, single-flight, invalidacja, timestampy (`refreshTags`), fallback przy awarii, reconnect, telemetry debug (write-only).

Pliki testów: `packages/cache-handler/__tests__/`.

### Lint

```bash
npx nx lint tmeNext
# lub
npm run lint
```

---

## 5. Testy obciążeniowe (k6)

Scenariusze w `apps/tmeNext-K6Test/scenarios/`. Uruchamiane **w kontenerze k6** w sieci docker-compose (celują w `tme-next-1:3000` … `tme-next-8:3000`).

### Wymagania

Stack musi działać:

```bash
docker compose up -d --build
```

### Scenariusze

```bash
# ogólne obciążenie — 40 VU, mix lokali i podstron
npx nx run tmeNext-K6Test:load
npm run k6:load

# thundering herd — wiele VU na jeden zimny URL (single-flight w Redis)
npx nx run tmeNext-K6Test:single-flight
npm run k6:single-flight

# propagacja invalidacji między instancjami
npx nx run tmeNext-K6Test:invalidation
npm run k6:invalidation
```

### Parametry (opcjonalnie)

Nadpisanie env przy `docker compose run`:

```bash
# inny lokal dla single-flight (każdy przebieg potrzebuje „zimnego” URL)
docker compose run --rm -e TARGET=br/pt/cache-lab k6 run /scenarios/single-flight.js

# obciążenie przez nginx (jak użytkownik), nie bezpośrednio po instancjach
docker compose run --rm -e HOST_TEMPLATE=nginx:80 -e INSTANCES=1 k6 run /scenarios/cache-load.js
```

Zmienne:

| Zmienna | Domyślnie | Opis |
|---|---|---|
| `INSTANCES` | `8` | ile instancji w rotacji |
| `HOST_TEMPLATE` | `tme-next-{i}:3000` | wzorzec hosta (`{i}` = numer 1–8) |
| `TARGET` | zależy od scenariusza | ścieżka URL (np. `br/pt/cache-lab`) |

Szczegóły scenariuszy, progów i interpretacji wyników: `apps/tmeNext-K6Test/README.md`.

### Przed ponownym single-flight

Poprzedni wpis cache musi być „zimny”. Opcje:

- użyj innego lokalu (`TARGET=br/pt/cache-lab`)
- wyczyść Redis: `docker compose exec redis redis-cli FLUSHDB`

---

## 6. Szybka ściągawka

```bash
# --- aplikacja ---
npm install
docker compose up -d --build          # pełny stack → http://localhost:8080
npm run dev                           # dev na hoście (wymaga Redisa + .env)

# --- testy ---
npx nx test tmeNext                   # Jest (handler cache)
npx nx run tmeNext-K6Test:load        # k6 — obciążenie
npx nx run tmeNext-K6Test:single-flight
npx nx run tmeNext-K6Test:invalidation

# --- utrzymanie ---
docker compose down
docker compose up -d --build          # po zmianach w kodzie
```

---

## 7. Rozwiązywanie problemów

| Problem | Co sprawdzić |
|---|---|
| `docker compose up` pada na build | Docker Desktop uruchomiony? Wolne miejsce na dysku? |
| Dev bez Redisa — cache „dziwny” | Skopiuj `.env.example` → `.env`, uruchom `docker compose up -d redis` |
| Port 3000 zajęty | Zatrzymaj inny proces albo `next dev -p 3001` (w `apps/tmeNext`) |
| k6: connection refused | `docker compose ps` — czy wszystkie `tme-next-*` są healthy? |
| k6 single-flight: wiele unikalnych `DATA_TS` | URL nie był zimny — zmień `TARGET` lub `FLUSHDB` |
| Po awarii Redis cache nie wraca | Handler ma 30 s cooldown; poczekaj lub zrestartuj instancję |

Dokumentacja cache: `apps/tmeNext/docs/CACHING.md`.

---

## 8. Debug telemetry cache (opcjonalny)

Włączany **tylko** gdy ustawisz `REMOTE_CACHE_DEBUG_ENABLED=true` (np. w `apps/tmeNext/.env` albo w `docker-compose`).

Bez tej zmiennej: brak logów debug i brak kluczy `meta:debug-*` w Redis.

### Co dostajesz

| Kanał | Opis |
|---|---|
| **Logi w terminalu** | `docker compose logs -f tme-next-1` — czytelne bloki tekstu przy każdym GET/SET/invalidacji |
| **Redis Insight** | Klucze `meta:debug-events:{HOSTNAME}`, `meta:debug-l1:{HOSTNAME}`, `meta:debug-pending:{HOSTNAME}` — mirror L1 i timeline zdarzeń ze wszystkich workerów w kontenerze |

### Przykład (dev)

```bash
# w apps/tmeNext/.env:
REMOTE_CACHE_DEBUG_ENABLED=true

npx nx dev tmeNext
# otwórz http://localhost:3000/pl/pl/posts  (generuje zdarzenia w logach i Redis)
```

### Przykład (Docker)

```yaml
# docker-compose.yml → sekcja x-tme-next → environment:
REMOTE_CACHE_DEBUG_ENABLED: "true"
```

Handler jest w paczce `packages/cache-handler` (TypeScript, build do `dist/` przed `next build`).

### Co widać w logach (przykład)

```text
┌─ cache GET ─ HIT ─────────────────────────
│  Returned fresh entry from L1 (in-process LRU)
│  layer: L1
│  tags: data:posts:pl:pl
│  age: 2.3 s
└────────────────────────────────────────
```
