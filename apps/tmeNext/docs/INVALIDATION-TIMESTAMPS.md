# Timestampy invalidacji (backstop)

Handler invaliduje cache na dwa sposoby naraz:

| Sposób | Co robi | Kiedy wystarczy sam |
|---|---|---|
| **Kasowanie + Pub/Sub** | kasuje wpisy w Redis, czyści L1 na instancjach | normalna invalidacja |
| **Timestampy** | zapisuje *kiedy* tag został unieważniony; przy odczycie odrzuca wpisy starsze niż ta chwila | wyścig zapisu, restart instancji, utrata Pub/Sub |

Ten dokument opisuje **timestampy** — drugi, „bezpiecznikowy” mechanizm.

Implementacja: `cache-handlers/remote-handler.mjs`. Więcej kontekstu: [CACHING.md §4](./CACHING.md).

---

## Legenda — co oznaczają skróty

W przykładach używamy kilku nazw. Wszystkie to **zwykłe liczby — milisekundy od 1970-01-01** (jak `Date.now()`).

| Skrót w tekście | Pełna nazwa | Co to jest |
|---|---|---|
| **`timestamp wpisu`** | `entry.timestamp` | Kiedy **powstał** ten wpis cache (moment startu renderu) |
| **`T_invalid`** | wartość w `meta:revalidated-at:{tag}` | Kiedy **unieważniono** tag (moment `updateTag`) |
| **`T1`, `T2`** | kolejne invalidacje tego samego tagu | `T2` jest nowsze niż `T1` — nadpisuje poprzednią granicę |
| **`T_old`** | stary timestamp wpisu | Wpis sprzed ostatniej invalidacji |
| **`T_inv`** | to samo co `T_invalid` | Skrót w tabelkach |

**Jedyna reguła decyzyjna:**

```
jeśli  T_invalid  >  timestamp wpisu   →   wpis jest nieaktualny, odrzuć (miss)
jeśli  T_invalid  ≤  timestamp wpisu   →   wpis jest OK, zwróć (hit)
```

Czytaj to jak: *„invalidacja była **później** niż powstanie wpisu → wpis jest śmieciem”*.

Przykład liczbowy:

```
T_invalid     = 1 700 000 002 000   (invalidacja o 12:00:02)
timestamp wpisu = 1 700 000 000 000   (wpis z 12:00:00)

1 700 000 002 000  >  1 700 000 000 000  →  true  →  odrzuć wpis
```

---

## Klucze w Redis

Po `updateTag("data:posts:pl:pl")` handler zapisuje **metadane**, nie dane aplikacji:

| Klucz | Zawartość |
|---|---|
| `meta:revalidated-at:data:posts:pl:pl` | `T_invalid` jako string, TTL = 7 dni |
| `meta:revalidated-tags` | set nazw tagów — rejestr „o co pytać” w `refreshTags()` |

W Redis Insight zobaczysz samą liczbę (ms), nie HTML ani JSON.

```bash
GET meta:revalidated-at:data:posts:pl:pl
# "1700000002000"

SMEMBERS meta:revalidated-tags
# "data:posts:pl:pl"
```

---

## Jak to działa

### Zapis — `updateTags()`

```
Server Action
    → handler ustawia T_invalid w pamięci (localTagTimestamps)
    → handler czyści L1
    → Redis: kasuje wpisy z indeksu tagu
    → Redis: SET meta:revalidated-at:{tag} = T_invalid  (TTL 7 dni)
    → Redis: SADD meta:revalidated-tags
    → Redis: PUBLISH (inne instancje czyszczą L1)
```

Instancja, która invaliduje, od razu zna `T_invalid` — nie czeka na `refreshTags()`.

### Odczyt — `refreshTags()` + `get()`

```
Każdy request:
    refreshTags()  →  pobierz T_invalid z Redis do localTagTimestamps

get(cacheKey):
    jeśli wpis w Redis/L1 istnieje
        dla każdego tagu wpisu:
            jeśli T_invalid > timestamp wpisu  →  miss (odrzuć)
        inaczej  →  hit (zwróć)
```

Kod w skrócie:

```js
if (tagTs > entry.timestamp) return true; // wpis nieaktualny
```

---

## Przykłady

### A. Wyścig zapisu (zombie wpis)

Instancja C zaczęła render **przed** invalidacją, ale zapisała wynik **po** niej.

| Czas | Co się dzieje |
|---|---|
| 12:00:00 | Instancja C **startuje** render postów |
| 12:00:02 | Admin: `updateTag` → `T_invalid = 12:00:02`, wpisy skasowane z indeksu |
| 12:00:03 | Instancja C **kończy** render i zapisuje wpis z `timestamp = 12:00:00` (moment startu!) |

Wpis wylądował w Redis mimo invalidacji — to „zombie”.

Request o 12:00:05:

1. `refreshTags()` → instancja zna `T_invalid = 12:00:02`
2. `get()` → zombie w Redis
3. Porównanie: `12:00:02 > 12:00:00` → **tak** → odrzuć → świeży render

**Bez timestampów:** zombie byłby serwowany do końca TTL wpisu (~24 h przy profilu `hours`).

### B. Restart instancji (Pub/Sub przepadł)

| Czas | Co się dzieje |
|---|---|
| 11:59 | Instancja D ma gorący wpis w L1 |
| 12:00 | **Restart** D — L1 puste, Pub/Sub nie działał |
| 12:00:01 | Inna instancja invaliduje tag → `T_invalid` w Redis |
| 12:00:30 | Pierwszy request na D po restarcie |

Na D:

1. L1 puste → odczyt z Redis
2. `refreshTags()` ładuje `T_invalid` z Redisa (nie z Pub/Sub)
3. Wpis ma `timestamp` sprzed invalidacji → odrzucony

Pub/Sub = szybka ścieżka. Timestampy = gwarancja dla instancji, które wiadomości nie usłyszały.

### C. Dwie invalidacje tego samego tagu

| Czas | Akcja | `T_invalid` w Redis |
|---|---|---|
| 10:00 | pierwsza invalidacja | `T1 = 10:00` |
| 14:00 | druga invalidacja | `T2 = 14:00` (nadpisuje T1) |
| 14:05 | nowy wpis z renderu | `timestamp = 14:05` → **OK** (14:05 > 14:00) |
| — | stary wpis sprzed południa | `timestamp = 11:00` → **odrzucony** (14:00 > 11:00) |

Każda invalidacja przesuwa granicę do przodu.

### D. Po 7 dniach meta znika — i to jest OK

Wpis cache ma własny TTL (minuty–dni). Meta invalidacji trzyma się **7 dni**.

```
życie wpisu:        |==== TTL wpisu (np. 24 h) ====|
invalidacja:        ↑ T_invalid
meta w Redis:       |=========== 7 dni ===========|
                                              ↑ wygasa
```

Po 7 dniach:

- klucz `meta:revalidated-at:...` wygasa
- handler usuwa tag z `meta:revalidated-tags`
- instancja „zapomina” invalidację

To bezpieczne — po tygodniu żaden wpis sprzed invalidacji już fizycznie nie istnieje w Redis.

### E. Invalidacja gdy Redis nie działa

| Czas | Co się dzieje |
|---|---|
| 12:00 | Redis padnie |
| 12:01 | `updateTag` na A → `T_invalid` tylko **lokalnie** na A, brak zapisu do Redis |
| 12:05 | Redis wraca |
| 12:06 | Instancja B **nie wie** o invalidacji z 12:01 |

**Znana granica:** invalidacja w trakcie awarii obowiązuje tylko na instancji, która ją wykonała. Pełna spójność wraca po kolejnej invalidacji albo naturalnym wygaśnięciu wpisów. Szczegóły: [ADR-0001](./adr/0001-zdalny-cache-redis.md).

---

## Kasowanie vs timestampy — kiedy co pomaga

| Sytuacja | Samo kasowanie | + timestampy |
|---|---|---|
| Normalna invalidacja | wpisy znikają | to samo |
| Zombie wpis po wyścigu | stary wpis wraca i jest serwowany | odrzucony (`T_invalid > timestamp`) |
| Restart, Pub/Sub przepadł | stary wpis w Redis może przejść | `refreshTags()` ładuje `T_invalid`, wpis odrzucony |

---

## Debugowanie

1. **`meta:revalidated-at:{tag}`** — liczba w ms; konwersja: `new Date(1700000002000).toISOString()`
2. **Wpis cache** — porównaj `_meta.createdAt` z `T_invalid`
3. **`TTL meta:revalidated-at:*`** — maleje (max 7 dni)
4. **`SMEMBERS meta:revalidated-tags`** — ile tagów jest w rejestrze

Testy: `npx nx test tmeNext` — scenariusze `invalidation` i `refreshTags` w `remote-handler.test.js`.

---

## Ściągawka

```
Zapis:    SET meta:revalidated-at:{tag} = Date.now()   (TTL 7 dni)
          + kasowanie wpisów + Pub/Sub

Odczyt:   refreshTags() → załaduj T_invalid do pamięci
          get() → odrzuć gdy T_invalid > timestamp wpisu

Reguła:   invalidacja późniejsza niż wpis → miss
```
