# @tme/cache-handler — dokumentacja v2

Ta dokumentacja tłumaczy **jak działa** paczka i **co daje aplikacji** — bez wchodzenia
w szczegóły implementacji. Jeśli szukasz opisu konkretnych funkcji i plików, zajrzyj do
kodu w `src/lib/` — jest krótki i dobrze podzielony.

## Czym jest ta paczka

`@tme/cache-handler` to **zdalny cache handler** dla Next.js 16 (Cache Components).
Podpina się pod dyrektywę `use cache: remote` i zastępuje wbudowany cache Next.js
własnym, dwupoziomowym magazynem:

- **L1** — mały, szybki cache w pamięci procesu Node (LRU),
- **L2** — Redis, współdzielony przez wszystkie instancje aplikacji.

Dzięki temu wynik renderowania policzony przez jedną instancję jest natychmiast
dostępny dla wszystkich pozostałych, a unieważnienie (np. po edycji treści w CMS)
działa spójnie w całym klastrze.

## Mentalny model w 30 sekund

1. Next.js pyta handler: „masz wynik dla tego klucza?" (`get`).
2. Handler patrzy najpierw do L1, potem do Redis. Jak znajdzie świeży wpis — zwraca go.
3. Jak nie znajdzie — mówi „nie mam", Next.js renderuje, a wynik trafia z powrotem
   do handlera (`set`), który zapisuje go w L1 i Redis.
4. Gdy ktoś unieważni tag (`revalidateTag` → `updateTags`), handler kasuje wpisy
   z Redis i rozgłasza przez Pub/Sub „wyczyśćcie swoje L1" do wszystkich instancji.

## Spis treści

| Rozdział | Co wyjaśnia |
|----------|-------------|
| [01 — Mechanizmy](01-mechanizmy.md) | L1/L2, przepływ `get` i `set`, single-flight, świeżość wpisów, zachowanie przy awarii Redis |
| [02 — Integracja z Next.js](02-integracja-z-nextjs.md) | `use cache: remote`, `cacheTag`, `cacheLife`, stale-while-revalidate w Next.js 16 |
| [03 — Inwalidacja](03-inwalidacja.md) | Jak działa unieważnianie tagów: Pub/Sub, znaczniki czasu, synchronizacja między instancjami |
| [04 — Korzyści dla aplikacji](04-korzysci-dla-aplikacji.md) | Czego się spodziewać po wdrożeniu: mniej renderów, spójność między instancjami, odporność na awarie |

## Najważniejsze wartości domyślne

| Parametr | Domyślnie | Po co |
|----------|-----------|-------|
| Pojemność L1 | 500 wpisów / 50 MB | Gorące klucze nie chodzą do Redis przy każdym żądaniu |
| Życie wpisu w L1 | 15 sekund | L1 jest tylko buforem — źródłem prawdy jest Redis |
| Blokada renderowania (single-flight) | 30 sekund | Przy cache miss renderuje tylko jedna instancja |
| Oczekiwanie na cudzy render | do ~5 sekund (50 prób co 100 ms) | Pozostałe instancje czekają na wynik zamiast renderować |
| Metadane inwalidacji tagów | 7 dni | Zabezpieczenie na wypadek zgubionego komunikatu Pub/Sub |
| Przerwa po awarii Redis | 30 sekund | Handler nie zasypuje padniętego Redisa próbami połączenia |

Wszystkie wartości można zmienić zmiennymi środowiskowymi — pełna lista w
[docs/CONFIGURATION.md](../docs/CONFIGURATION.md).
