# tme-monorepo (Nx)

Monorepo Nx z dwiema aplikacjami uruchamianymi w kontenerach:

| Projekt | Ścieżka | Rola |
|---|---|---|
| `tmeNext` | `apps/tmeNext` | Next.js 16 (Cache Components, `use cache: remote` → LRU + Redis + Pub/Sub) |
| `tmeNext-K6Test` | `apps/tmeNext-K6Test` | Testy obciążeniowe k6 (obraz `grafana/k6` ze scenariuszami) |

Architektura docelowa: **wiele instancji Next.js z jednego artefaktu `.next`**
(jeden obraz `tme-next:local`, 8 kontenerów) + wspólny Redis jako cache L2.
Szczegóły cachowania: `apps/tmeNext/docs/CACHING.md`.
Uruchamianie aplikacji i testów: [HOW_TO_RUN.md](./HOW_TO_RUN.md).

## Szybki start

```bash
npm install
docker compose up -d --build   # redis + redisinsight + 8x tmeNext + nginx
```

- **Aplikacja (load balancer nginx)**: http://localhost:8080 — least_conn po 8 instancjach,
  nagłówek `X-Upstream` pokazuje, która instancja obsłużyła request
- Pojedyncze instancje: http://localhost:3000 … :3007 (do debugowania/testów per instancja)
- Redis Insight: http://localhost:5540

## Komendy Nx

```bash
npx nx dev tmeNext                       # dev server (host, wymaga redis:6379)
npx nx build tmeNext                     # build produkcyjny
npx nx run tmeNext-K6Test:build          # build obrazu k6
npx nx run tmeNext-K6Test:load           # ogólne obciążenie (40 VU, 8 instancji)
npx nx run tmeNext-K6Test:single-flight  # thundering herd na zimny URL
npx nx run tmeNext-K6Test:invalidation   # propagacja invalidacji między instancjami
```

Testy k6 działają **w kontenerze**, w tej samej sieci Docker co instancje —
celują w hostnames serwisów (`tme-next-1:3000` … `tme-next-8:3000`), konfigurowalne
przez env `INSTANCES` i `HOST_TEMPLATE`. Parametry scenariuszy (np. zimny target):

```bash
docker compose run --rm -e TARGET=br/pt/cache-lab k6 run /scenarios/single-flight.js
```

Opis scenariuszy i oczekiwanych wyników: `apps/tmeNext-K6Test/README.md`.
