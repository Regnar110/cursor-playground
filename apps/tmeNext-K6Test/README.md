# tmeNext-K6Test

Testy obciążeniowe cache aplikacji `tmeNext`. Obraz = `grafana/k6` + scenariusze
(`scenarios/`), uruchamiany w sieci docker-compose razem z 8 instancjami `tme-next-*`.

## Uruchamianie

```bash
docker compose up -d --build             # najpierw stack: redis + 8x tmeNext
npx nx run tmeNext-K6Test:load           # ogólne obciążenie
npx nx run tmeNext-K6Test:single-flight  # thundering herd
npx nx run tmeNext-K6Test:invalidation   # propagacja invalidacji
```

Konfiguracja przez env (ustawiane w `docker-compose.yml`, można nadpisać `-e` przy
`docker compose run`): `INSTANCES` (domyślnie 8), `HOST_TEMPLATE`
(domyślnie `tme-next-{i}:3000`).

## Scenariusze

### `cache-load.js` — ogólne obciążenie

40 VU, ~60 s, każdy VU trafia w swoją instancję, mix 8 lokali × 5 podstron.
Progi: `http_req_failed < 1%`, `p(95) < 1500 ms`.

### `single-flight.js` — thundering herd

80 VU × 240 iteracji na **jeden zimny URL** rozłożony na wszystkie instancje.
Oczekiwanie: 1 unikalny `DATA_TS` we wszystkich odpowiedziach (dane wyrenderowała
jedna instancja, lock w Redis) i 1 wpis w `index:data:cache-lab:{country}:{lang}`.

```bash
docker compose run --rm -e TARGET=br/pt/cache-lab k6 run /scenarios/single-flight.js
docker compose exec redis redis-cli SMEMBERS index:data:cache-lab:br:pt
```

Każdy przebieg potrzebuje zimnego targetu (inny lokal albo
`docker compose exec redis redis-cli FLUSHDB`).

### `invalidation.js` — propagacja invalidacji

20 VU czyta `/cache-lab` na wszystkich instancjach, 1 VU invaliduje tagi DATA+UI
przez `POST /api/loadtest/invalidate` na instancji 2 i mierzy, kiedy instancja 3
serwuje świeże dane (`invalidation_propagation_ms`).

**Dwie warstwy o różnej semantyce** (potwierdzone testami):

1. **Handler remote (Redis)** — invalidacja natychmiastowa i cross-instance:
   wpisy i indeksy kasowane z Redis, Pub/Sub czyści LRU na każdej instancji.
2. **Full route cache (ISR)** — strona ma `s-maxage=60, stale-while-revalidate`,
   a oznaczanie tagów jako nieświeże dla tej warstwy jest per-instancja (in-memory).
   Instancja serwuje zbuforowany HTML aż jej wpis route'a się zestarzeje (≤ 60 s).

Stąd end-to-end propagacja: od ms do ~65 s (próg `p(95) < 75 s`). Natychmiastowa
spójność HTML wymagałaby współdzielonego `cacheHandler` ISR (Redis) albo krótszego
`revalidate` strony.

## Testy ręczne

```bash
# pad Redisa pod obciążeniem (fallback na LRU, cooldown 30 s)
docker compose stop redis
# ... obserwuj k6 ...
docker compose start redis

# wycieki po dłuższym teście (indeksy i meta mają TTL — DBSIZE nie powinien trwale rosnąć)
docker compose exec redis redis-cli DBSIZE
```

## Ograniczenia lokalnej symulacji

Wszystkie kontenery dzielą jeden CPU/dysk — liczby bezwzględne będą gorsze niż na
produkcji. **Zachowania** (single-flight, spójność invalidacji, fallback) testują się
wiarygodnie, bo to te same mechanizmy i ten sam Redis co na produkcji.
