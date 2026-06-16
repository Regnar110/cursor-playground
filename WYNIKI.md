# Interpretacja testów k6 — 1000 VU

**Data:** 2026-06-15 22:04  
**Środowisko:** Docker Compose (8× tmeNext + Redis + nginx), cache wyczyszczony (`FLUSHDB`) przed load i single-flight  
**Katalog wyników:** `apps/tmeNext-K6Test/results/2026-06-15_2204-1000vus/`

---

## 1. cache-load.js — obciążenie ogólne (1000 VU)

| Metryka | Wynik | Próg | Status |
|---|---|---|---|
| Żądania | 37 667 | — | — |
| Throughput | **628 req/s** | — | — |
| Błędy HTTP | **0.00%** | < 1% | ✅ |
| p95 latency | **2.95 s** | < 1.5 s | ❌ |
| p50 (mediana) | 927 ms | — | — |
| p90 | 2.23 s | — | — |
| TTFB avg | 1.23 s | — | — |
| TTFB p95 | 2.69 s | — | — |
| Dane odebrane | 1.1 GB | — | — |

**Interpretacja:** System jest **stabilny** (zero błędów, 100% status 200), ale **nie spełnia progu wydajnościowego** przy 1000 VU. Po wyczyszczeniu cache większość żądań trafia w zimny render (L2 miss + SSR), co przy 8 instancjach na jednym hoście daje kolejkę i p95 ~3× powyżej progu. Mediana ~930 ms sugeruje, że po rozgrzaniu LRU/Redis część ruchu jest szybka, ale ogon (zimne strony, contention CPU) ciągnie p95 w górę. To oczekiwane w lokalnej symulacji — liczby bezwzględne są gorsze niż na produkcji, ale wzorzec (gorący cache szybki, zimny wolny) jest wiarygodny.

---

## 2. single-flight.js — thundering herd (80 VU, zimny URL)

| Metryka | Wynik | Próg | Status |
|---|---|---|---|
| Iteracje | 240 | — | — |
| Błędy HTTP | **0.00%** | — | ✅ |
| Checks | **100%** | > 99% | ✅ |
| p95 latency | 1.60 s | — | — |
| Unikalne DATA_TS | **2** (oczekiwane: 1) | 1 | ⚠️ |
| Wpisy w Redis index | **2** klucze | 1 | ⚠️ |

**Unikalne timestampy danych:**
- `2026-06-15T20:07:41.183Z` — **194** odpowiedzi (81%)
- `2026-06-15T20:07:41.324Z` — **46** odpowiedzi (19%)

**Interpretacja:** Single-flight **działa w większości** — 240 równoległych żądań zakończyło się bez błędów, a dane pochodzą z **dwóch bardzo bliskich** renderów (różnica 141 ms), nie z 80 niezależnych. Redis index `index:data:cache-lab:ca:hi` ma 2 wpisy zamiast 1. Prawdopodobna przyczyna: **race na starcie** — kilka instancji jednocześnie nie zdążyło złapać locka Redis i wykonało drugi render. To nie jest katastrofa (2 zamiast 80), ale warto monitorować przy wyższym contention.

---

## 3. invalidation.js — propagacja invalidacji (20 VU + 1 invalidator)

| Metryka | Wynik | Próg | Status |
|---|---|---|---|
| Reader requests | 9 741 | — | — |
| Błędy HTTP | **0.00%** | < 2% | ✅ |
| Propagacja E2E | **56.4 s** | p95 < 75 s | ✅ |
| Timeout invalidacji | **0%** | 0% | ✅ |
| Reader p95 latency | 7.8 ms | — | — |

**Interpretacja:** Invalidacja **handlera Redis** jest natychmiastowa (reader p95 ~8 ms — serwują z LRU). End-to-end propagacja nowego `DATA_TS` na instancji 3 zajęła **56.4 s**, co mieści się w oczekiwanym oknie **≤ 60 s revalidate** strony cache-lab + margines na re-render route ISR. To potwierdza dwuwarstwowy model: Redis invaliduje od razu cross-instance, ale HTML route cache odświeża się dopiero po `revalidate=60`.

---

## Podsumowanie

| Scenariusz | Werdykt | Kluczowy wniosek |
|---|---|---|
| **Load 1000 VU** | ⚠️ Częściowy | Stabilność OK, latency p95 przekroczona (zimny cache + lokalne CPU) |
| **Single-flight** | ⚠️ Prawie OK | 2 rendery zamiast 1 — lock działa, ale jest race na starcie |
| **Invalidation** | ✅ PASS | Propagacja ~56 s zgodna z ISR revalidate=60 |

## Pliki wyników

| Plik | Zawartość |
|---|---|
| `cache-load-summary.json` | Podsumowanie JSON load test |
| `cache-load-metrics.json` | Pełny strumień metryk load |
| `cache-load-console.txt` | Log konsoli k6 load |
| `single-flight-summary.json` | Podsumowanie single-flight |
| `single-flight-metrics.json` | Metryki single-flight |
| `single-flight-console.txt` | Log z DATA_TS |
| `invalidation-summary.json` | Podsumowanie invalidation |
| `invalidation-metrics.json` | Metryki invalidation |
| `invalidation-console.txt` | Log z PROPAGATION_MS |
