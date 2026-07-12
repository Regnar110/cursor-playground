# 04 — Korzyści dla aplikacji

Co realnie zmienia wdrożenie `use cache: remote` z tą paczką — w porównaniu
z wbudowanym, in-process cache Next.js.

## Problem, który paczka rozwiązuje

Wbudowany `use cache` trzyma wpisy w pamięci pojedynczego procesu. Przy N
instancjach aplikacji (Kubernetes, autoscaling) oznacza to:

- każda instancja renderuje **te same** strony na własny rachunek — N renderów
  zamiast jednego,
- po deployu lub restarcie cache startuje **pusty** — fala zimnych renderów,
- `revalidateTag` czyści cache tylko w instancji, która obsłużyła żądanie —
  pozostałe serwują starą treść, aż wpisy same wygasną.

## Co się zmienia po wdrożeniu

### 1. Jeden render zamiast N

Wynik policzony przez dowolną instancję ląduje w Redis i jest natychmiast
dostępny dla wszystkich. Do tego single-flight pilnuje, żeby przy chybieniu
(np. po wygaśnięciu popularnego wpisu) renderowała **dokładnie jedna** instancja —
reszta czeka ułamek sekundy i przejmuje gotowy wynik.

Efekt: mniejsze zużycie CPU na renderowanie, mniejszy ruch do backendów/API,
z których cachowane funkcje czytają dane, brak „stampede" po wygaśnięciu wpisów.

### 2. Ciepły cache po deployu i restarcie

Redis żyje dłużej niż proces aplikacji. Nowa instancja od pierwszego żądania
korzysta z wpisów wyrenderowanych przez poprzedniczki — deploy nie powoduje
fali pełnych renderów.

### 3. Spójna inwalidacja w całym klastrze

`revalidateTag` działa globalnie: wpisy znikają z Redis, komunikat Pub/Sub czyści
L1 wszystkich instancji, a znaczniki czasu tagów domykają lukę, gdyby jakaś
instancja komunikat przegapiła. Edycja treści w CMS jest widoczna wszędzie,
nie tylko na jednej maszynie.

### 4. Użytkownik nie czeka na odświeżanie

Dzięki stale-while-revalidate (rozdział 02) przeterminowany-ale-żywy wpis jest
serwowany od ręki, a odświeżenie dzieje się w tle. Pełny, blokujący render
na ścieżce żądania zdarza się tylko po twardym `expire` albo po unieważnieniu taga.

### 5. Awaria Redis nie kładzie aplikacji

Handler degraduje się do trybu L1-only: aplikacja działa dalej, tylko cache
przestaje być współdzielony. Po 30-sekundowym cooldownie handler sam wraca
do Redis, a mechanizm znaczników czasu odtwarza spójność inwalidacji.

## Czego paczka NIE robi

Żeby uniknąć rozczarowań:

- **Nie przyspiesza pierwszego renderu** danego klucza — ktoś zawsze musi
  policzyć wynik. Paczka sprawia, że robi to raz, jedna instancja.
- **Nie zarządza tym, co cachować** — o tym decyduje aplikacja dyrektywą
  `use cache: remote`, profilem `cacheLife` i tagami `cacheTag`.
- **Nie zastępuje CDN** — działa na poziomie renderowania serwerowego,
  nie dystrybucji statycznych zasobów.

## Kiedy efekt jest największy

| Scenariusz | Zysk |
|-----------|------|
| Wiele instancji + powtarzalne strony (katalog, listingi) | Największy — N renderów spada do 1 |
| Częste deploye | Duży — brak zimnych startów cache |
| Treści edytowane w CMS z `revalidateTag` | Duży — spójna, natychmiastowa inwalidacja |
| Pojedyncza instancja, mało powtarzalnego ruchu | Mały — wbudowany cache może wystarczyć |
