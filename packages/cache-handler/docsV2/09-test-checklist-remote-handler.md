# 09 — Checklist testów remote cache handlera

Checklist do testów **wyłącznie remote cache handlera** — metody `get`, `set`,
`updateTags`, `refreshTags`, `getExpiration`. Bez ISR, bez CMS/webhooków, bez
wzorców aplikacyjnych.

Można wkleić sekcje do Jiry (nagłówki, tabele, checkboxy).

---

## 0. Warunki wstępne

| # | Kroki | Oczekiwany wynik |
|---|-------|------------------|
| 0.1 | Uruchom handler z poprawną konfiguracją Redis (host, port) | Handler łączy się z Redis przy pierwszej operacji cache |
| 0.2 | Uruchom drugą instancję handlera (osobny proces) wskazującą na ten sam Redis | Obie instancje współdzielą L2 |
| 0.3 | Włącz logi handlera na poziomie info/debug | Widoczne zdarzenia GET / SET / INVALIDATE / REFRESH |

---

## 1. `set()` — zapis wpisu

| # | Kroki | Oczekiwany wynik |
|---|-------|------------------|
| 1.1 | Wywołaj `set(key, entry)` z nowym kluczem | Wpis zapisany w L1 |
| 1.2 | Sprawdź Redis po `set` | Klucz wpisu istnieje w Redis |
| 1.3 | Sprawdź TTL klucza w Redis | TTL = `max(entry.expire, 60)` sekund |
| 1.4 | Wywołaj `set` z wpisem mającym tagi `[tag-a, tag-b]` | W Redis powstają indeksy tagów (zestawy kluczy per tag) |
| 1.5 | Zapisz wpis z krótszym `expire`, potem dłuższym — ten sam tag | TTL indeksu tagu rośnie (GT), nie maleje |
| 1.6 | Po `set` — sprawdź render lock | Lock zwolniony po zakończeniu `set` |

---

## 2. `get()` — odczyt i warstwy cache

| # | Kroki | Oczekiwany wynik |
|---|-------|------------------|
| 2.1 | `set(key)` → natychmiast `get(key)` na tej samej instancji | HIT z L1 |
| 2.2 | `set(key)` → odczekaj TTL L1 (~15 s) → `get(key)` | HIT z L2; wpis promowany do L1 |
| 2.3 | `get(nieistniejący_klucz)` przy dostępnym Redis | MISS — zwraca `undefined` |
| 2.4 | `get(key_A)` i `get(key_B)` — różne klucze | Niezależne wpisy, brak krzyżowego trafienia |
| 2.5 | Instancja A: `set(key)` → Instancja B: `get(key)` | B: HIT z L2 (bez własnego renderu) |

---

## 3. Świeżość wpisu — `expire` vs `revalidate`

Handler egzekwuje tylko `expire`. `revalidate` jest ignorowany przy `get`.

| # | Kroki | Oczekiwany wynik |
|---|-------|------------------|
| 3.1 | Zapisz wpis z `expire` za 5 min; odczytaj po 1 min | HIT — wpis świeży |
| 3.2 | Ten sam wpis; odczytaj po upływie `expire` | STALE / MISS — handler odrzuca wpis |
| 3.3 | Zapisz wpis z `revalidate=60s`, `expire=300s`; odczytaj po 90 s (po `revalidate`, przed `expire`) | HIT — handler *nie* odrzuca wpisu z powodu `revalidate` |
| 3.4 | Porównaj zachowanie tuż przed i tuż po `expire` | Skok z HIT na odrzucenie dopiero po `expire` |

---

## 4. `updateTags()` — invalidacja

| # | Kroki | Oczekiwany wynik |
|---|-------|------------------|
| 4.1 | `set(key1, tags=[tag-x])` → `updateTags([tag-x])` → `get(key1)` | MISS — wpis usunięty |
| 4.2 | Po `updateTags` — sprawdź Redis | Klucz wpisu i indeks `tag-x` usunięte |
| 4.3 | `set(key1, tag-x)` + `set(key2, tag-x)` → `updateTags([tag-x])` | Oba wpisy usunięte (invalidacja po indeksie tagu) |
| 4.4 | `set(key1, tag-x)` + `set(key2, tag-y)` → `updateTags([tag-x])` | Usunięty tylko `key1`; `key2` nadal HIT |
| 4.5 | Po `updateTags` — sprawdź timestamp tagu w Redis | Marker `revalidated-at` zapisany z TTL ~7 dni |
| 4.6 | Po `updateTags` — L1 na instancji wykonującej invalidację | Wpisy z danym tagiem wyczyszczone z L1 |
| 4.7 | `updateTags` na tagu bez wpisów | Brak błędu; timestamp tagu i tak zapisany |

---

## 5. Pub/Sub — synchronizacja L1 między instancjami

| # | Kroki | Oczekiwany wynik |
|---|-------|------------------|
| 5.1 | Instancja A: `set(key, tag-x)` → B: `get(key)` (HIT L2) → B: ponowny `get` w oknie L1 (HIT L1) | B ma wpis w L1 |
| 5.2 | Instancja A: `updateTags([tag-x])` | — |
| 5.3 | Instancja B: `get(key)` bez restartu | MISS — L1 wyczyszczone przez Pub/Sub |
| 5.4 | Sprawdź logi B po invalidacji | Odebrana wiadomość Pub/Sub, czyszczenie L1 |

---

## 6. `refreshTags()` + timestampy — backstop gdy Pub/Sub nie dotarł

| # | Kroki | Oczekiwany wynik |
|---|-------|------------------|
| 6.1 | A: `set(key, tag-x)` → B: `get(key)` (wpis w L1 na B) | B: HIT L1 |
| 6.2 | Zatrzymaj / odłącz subskrypcję Pub/Sub na B (lub zrestartuj B przed invalidacją) | — |
| 6.3 | A: `updateTags([tag-x])` | Wpis usunięty z Redis |
| 6.4 | B: uruchom ponownie → `refreshTags()` → `get(key)` | MISS — wpis odrzucony mimo ewentualnego „zombie” w L1 (timestamp tagu nowszy niż `entry.timestamp`) |
| 6.5 | `refreshTags()` gdy brak invalidowanych tagów w Redis | Brak zmian, brak błędu |
| 6.6 | Po wygaśnięciu markera tagu w Redis → `refreshTags()` | Lokalny timestamp tagu usunięty |

---

## 7. Soft tags przy `get()`

| # | Kroki | Oczekiwany wynik |
|---|-------|------------------|
| 7.1 | `set(key, tags=[tag-a])` → `get(key, softTags=[])` | HIT |
| 7.2 | `updateTags([tag-b])` gdzie `tag-b` *nie* jest na wpisie | Wpis nadal HIT |
| 7.3 | `get(key, softTags=[tag-c])` po `updateTags([tag-c])` | MISS / STALE — soft tag invalidowany po utworzeniu wpisu |
| 7.4 | Tag na wpisie invalidowany po `entry.timestamp` | Wpis odrzucony przy `get` (tag stale) |

---

## 8. `getExpiration()`

| # | Kroki | Oczekiwany wynik |
|---|-------|------------------|
| 8.1 | Brak invalidacji tagów → `getExpiration([tag-x])` | Zwraca `0` |
| 8.2 | Po `updateTags([tag-x])` → `getExpiration([tag-x])` | Zwraca timestamp invalidacji (> 0) |
| 8.3 | `getExpiration([tag-a, tag-b])` — tylko `tag-b` invalidowany | Zwraca max z timestampów (= timestamp `tag-b`) |

---

## 9. `pendingSets` — spójność w jednym procesie

| # | Kroki | Oczekiwany wynik |
|---|-------|------------------|
| 9.1 | Rozpocznij `set(key, slowPromise)` (set jeszcze trwa) | `pendingSets` aktywny |
| 9.2 | Równolegle wywołaj `get(key)` na tej samej instancji | `get` czeka na zakończenie `set`, nie zwraca MISS |
| 9.3 | Po zakończeniu `set` → `get(key)` | HIT z L1 |
| 9.4 | Po zakończeniu `set` (sukces lub błąd) | `pendingSets` wyczyszczony |

---

## 10. Single-flight przy MISS

| # | Kroki | Oczekiwany wynik |
|---|-------|------------------|
| 10.1 | Brak wpisu w Redis → równoległe `get(key)` z wielu instancji | Tylko jedna instancja dostaje sygnał do renderu (acquired lock); reszta czeka |
| 10.2 | Instancja z lockiem wykonuje `set(key)` | Wpis w Redis; lock zwolniony |
| 10.3 | Instancje czekające podczas `set` | Po pojawieniu się wpisu: HIT (bez własnego renderu) |
| 10.4 | Sprawdź klucz locka w Redis podczas oczekiwania | Lock istnieje z TTL ~30 s |
| 10.5 | Lock istnieje, ale `set` nie nadejdzie w czasie pollingu (~5 s) | Czekające instancje: MISS lub własna próba renderu |
| 10.6 | Po wygaśnięciu wpisu (`expire`) — burst równoległych `get` | Jeden render, nie stampede |

---

## 11. Awaria Redis — tryb L1-only

| # | Kroki | Oczekiwany wynik |
|---|-------|------------------|
| 11.1 | Zatrzymaj Redis w trakcie działania | Handler nie rzuca nieobsłużonego wyjątku na żądanie |
| 11.2 | `get(key)` przy niedostępnym Redis | MISS (`undefined`) |
| 11.3 | `set(key)` przy niedostępnym Redis | Wpis tylko w L1 lokalnej instancji |
| 11.4 | Instancja A i B bez Redis — ten sam klucz | Każda instancja ma własny L1; brak współdzielenia |
| 11.5 | `updateTags` przy niedostępnym Redis | Invalidacja lokalna (L1 + lokalne timestampy); brak operacji na Redis |
| 11.6 | Po błędzie połączenia — kolejne operacje przez ~30 s | Cooldown — brak agresywnego reconnectu na każde żądanie |
| 11.7 | Przywróć Redis po cooldown | Połączenie odbudowane; `set`/`get` wracają do L1+L2 |
| 11.8 | Po powrocie Redis — subskrypcja Pub/Sub | Odtworzona przy następnej operacji cache |

---

## 12. Faza build — brak Redis

| # | Kroki | Oczekiwany wynik |
|---|-------|------------------|
| 12.1 | Uruchom handler z `NEXT_PHASE=phase-production-build` | Handler nie łączy się z Redis |
| 12.2 | `set` / `get` w fazie build | Działa wyłącznie L1; brak zapisów do współdzielonego Redis |

---

## 13. Odporność na błędy

| # | Kroki | Oczekiwany wynik |
|---|-------|------------------|
| 13.1 | `get` gdy Redis zwraca błąd sieciowy | MISS; błąd zalogowany; brak crashu procesu |
| 13.2 | `set` gdy pipeline Redis się wyłoży | Błąd zalogowany; `pendingSets` i lock zwolnione w `finally` |
| 13.3 | `updateTags` gdy Redis niedostępny | Lokalna invalidacja; brak crashu |
| 13.4 | `refreshTags` gdy Redis niedostępny | Ciche wyjście; brak crashu |

---

## 14. Konfiguracja handlera (zmienne środowiskowe)

| # | Co sprawdzić | Oczekiwany wynik |
|---|--------------|------------------|
| 14.1 | Brak `REDIS_HOST` / `REDIS_PORT` | Tryb L1-only od startu |
| 14.2 | `REMOTE_CACHE_LRU_TTL_MS` (np. 5000) | L1 wygasa po ustawionym czasie, potem odczyt z L2 |
| 14.3 | `REMOTE_CACHE_LRU_MAX_ENTRIES` / `MAX_SIZE_MB` | Przy przepełnieniu LRU — evict najstarszych wpisów |
| 14.4 | `REDIS_CACHE_PREFIX` | Wszystkie klucze w Redis mają prefix |
| 14.5 | `SINGLE_FLIGHT_LOCK_TTL` / `POLLING_MS` / `ATTEMPTS` | Czas oczekiwania i TTL locka zgodne z konfiguracją |

---

## 15. Scenariusze akceptacyjne (handler only)

### Scenariusz A — happy path

- [ ] `set` → `get` = HIT L1
- [ ] Po TTL L1 → `get` = HIT L2 + promocja do L1
- [ ] Instancja B widzi wpis zapisany przez A

### Scenariusz B — wygaśnięcie `expire`

- [ ] Przed `expire` = HIT
- [ ] Po `expire` = odrzucenie wpisu
- [ ] `revalidate` przed `expire` nie powoduje odrzucenia

### Scenariusz C — invalidacja tagu

- [ ] `updateTags` kasuje wpisy w Redis i L1 (wszystkie instancje przez Pub/Sub)
- [ ] Timestamp tagu działa jako backstop gdy Pub/Sub nie dotarł

### Scenariusz D — single-flight

- [ ] Równoległy MISS na wielu instancjach = jeden zapis, reszta czeka

### Scenariusz E — degradacja

- [ ] Brak Redis = L1-only, aplikacja działa
- [ ] Powrót Redis po cooldown = pełna funkcjonalność L2

---

## Legenda statusów

| Status | Znaczenie |
|--------|-----------|
| Pass | Zachowanie zgodne z oczekiwaniem |
| Fail | Rozbieżność — dołącz: klucz cache, tagi, instancja (A/B), warstwa (L1/L2), timestamp wpisu vs timestamp invalidacji, stan Redis |
| Blocked | Brak infrastruktury (np. druga instancja, Redis) |
| N/A | Poza zakresem testu |
