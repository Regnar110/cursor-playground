# 01 — Mechanizmy

Ten rozdział opisuje, co dzieje się „pod maską", gdy Next.js prosi handler o wpis
albo oddaje mu świeżo wyrenderowany wynik. Celowo pomijamy szczegóły kodu —
liczy się zrozumienie przepływu.

## Dwa poziomy cache

| Poziom | Gdzie żyje | Jak długo | Rola |
|--------|-----------|-----------|------|
| **L1** | Pamięć procesu Node (LRU) | ~15 s | Amortyzuje gorące klucze — brak round-tripu do Redis przy każdym żądaniu |
| **L2** | Redis | do `expire` wpisu | Źródło prawdy współdzielone przez wszystkie instancje |

L1 jest świadomie krótkotrwały. To nie jest „drugi cache do zarządzania" — to bufor,
który przy dużym ruchu zdejmuje z Redisa powtarzalne odczyty tego samego klucza.
Po kilkunastu sekundach wpis w L1 wygasa i kolejne żądanie odświeży go z Redis.

## Odczyt — `get`

```mermaid
flowchart TD
    A["Next.js pyta o klucz"] --> B{"Wpis w L1\ni świeży?"}
    B -- tak --> HIT1["Zwróć z L1"]
    B -- nie --> C{"Redis dostępny?"}
    C -- nie --> MISS1["Miss — Next.js renderuje\n(tryb L1-only)"]
    C -- tak --> D{"Wpis w Redis\ni świeży?"}
    D -- tak --> HIT2["Zapisz do L1 i zwróć"]
    D -- nie --> E{"Ktoś inny właśnie\nrenderuje ten klucz?"}
    E -- tak --> F["Czekaj na jego wynik\n(do ~5 s)"]
    F -- "wynik pojawił się" --> HIT3["Zapisz do L1 i zwróć"]
    F -- timeout --> G
    E -- nie --> G{"Spróbuj przejąć\nblokadę renderowania"}
    G -- udało się --> MISS2["Miss — ta instancja renderuje,\nreszta czeka"]
    G -- "przegrany wyścig" --> F
```

Kluczowe decyzje po drodze:

- **Świeżość** sprawdzana jest przy każdym odczycie (patrz niżej).
- **Single-flight**: przy chybieniu tylko jedna instancja w klastrze renderuje dany
  klucz. Pozostałe odpytują Redis co 100 ms (maks. 50 prób) i przejmują wynik,
  gdy tylko się pojawi. To eliminuje „cache stampede" — sytuację, w której po
  wygaśnięciu popularnego wpisu wszystkie instancje naraz odpalają ten sam render.

## Zapis — `set`

```mermaid
flowchart TD
    A["Next.js oddaje wynik renderu"] --> B["Zapisz w L1"]
    B --> C{"Redis dostępny?"}
    C -- nie --> D["Koniec — wpis żyje tylko w L1"]
    C -- tak --> E["Zapisz w Redis z TTL = expire wpisu\n(min. 60 s)"]
    E --> F["Dopisz klucz do indeksów tagów\n(po jednym na każdy tag wpisu)"]
    F --> G["Zwolnij blokadę renderowania\n(jeśli ta instancja ją trzymała)"]
```

Dwa detale warte zapamiętania:

- **Indeksy tagów** — dla każdego taga wpisu Redis trzyma zbiór kluczy z tym tagiem.
  Dzięki temu unieważnienie taga wie dokładnie, które wpisy skasować
  (szczegóły w [03 — Inwalidacja](03-inwalidacja.md)).
- **TTL indeksu tylko rośnie** — indeks taga dostaje TTL nieco dłuższy niż najdłużej
  żyjący wpis. Krótki wpis nie skróci życia indeksu, w którym siedzą też dłuższe wpisy.

## Kiedy wpis jest „świeży"

Wpis zostaje odrzucony (traktowany jak nieistniejący), gdy zachodzi **którykolwiek**
z warunków:

1. **Minął `expire`** — twardy koniec życia wpisu. Uwaga: handler *nie* odrzuca wpisu
   po `revalidate` — to celowe, patrz [02 — Integracja z Next.js](02-integracja-z-nextjs.md#stale-while-revalidate).
2. **Tag wpisu został unieważniony** po tym, jak wpis powstał.
3. **Soft tag żądania został unieważniony** po powstaniu wpisu (soft tagi to tagi
   przekazywane przez Next.js przy odczycie, nie zapisane we wpisie — np. tagi ścieżki).

## Awaria Redis — degradacja, nie katastrofa

```mermaid
flowchart LR
    OK["Normalna praca\nL1 + Redis"] -- "połączenie pada" --> COOL["Tryb L1-only\nprzez 30 s"]
    COOL -- "kolejna operacja\npo upływie 30 s" --> RETRY["Próba reconnect"]
    RETRY -- sukces --> OK
    RETRY -- porażka --> COOL
```

Gdy Redis jest niedostępny:

- `get`/`set` działają dalej na samym L1 — aplikacja **nie przestaje działać**,
  spada tylko skuteczność cache (każda instancja renderuje dla siebie).
- Handler nie ponawia połączenia przy każdym żądaniu — odczekuje 30 s (cooldown),
  żeby nie dobijać wstającego Redisa.
- Po odzyskaniu połączenia subskrypcja Pub/Sub odtwarza się przy pierwszym żądaniu,
  a znaczniki czasu tagów (rozdział 03) domykają lukę po ewentualnie zgubionych
  komunikatach unieważnień.

## Faza builda

Podczas `next build` (produkcyjny build) handler w ogóle nie dotyka Redisa —
działa w trybie L1-only. Build nie powinien zależeć od sieci ani zapisywać
wpisów do współdzielonego cache.
