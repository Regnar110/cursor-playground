# Niuanse Redis/ioredis w remote cache handlerze

Każdy punkt w formule: **problem → naiwne rozwiązanie → dlaczego się psuje → jak robi to
handler** (`packages/cache-handler`). Część z tych pułapek odkryliśmy
empirycznie podczas debugowania — to dokument typu "czemu ten kod wygląda dziwnie".

Przewodnik po całości cachowania: [CACHING.md](./CACHING.md).

---

## 1. `SET ... NX EX` — atomowe przejęcie locka

**Problem:** przy cache miss na 8 instancjach tylko jedna ma renderować (single-flight).
Trzeba rozstrzygnąć wyścig "kto pierwszy".

**Naiwnie:** `GET lock` (wolny?) → `SET lock`. To check-then-act: między GET a SET inna
instancja zdąży założyć locka i obie "wygrywają" — renderują równolegle.

**Handler:** jedna atomowa komenda:

```js
redis.set(lockKey, instanceId, "EX", 30, "NX")
```

- `NX` (*Not eXists*) — zapisz **tylko jeśli klucz nie istnieje**; istniejący → `null`
  zamiast `"OK"`. Redis jest jednowątkowy, więc z 8 równoczesnych `SET NX` dokładnie
  jeden zwróci `"OK"`.
- `EX 30` **w tej samej komendzie** — TTL nadany atomowo z zapisem. Gdyby TTL ustawiać
  osobnym `EXPIRE`, śmierć procesu między `SET` a `EXPIRE` zostawiłaby locka bez TTL
  → klucz zablokowany na zawsze. Z `EX` najgorszy skutek padu = 30 s czekania.
- Wartość locka = `instanceId` — potrzebna do bezpiecznego zwolnienia (pkt 2).

## 2. Lua compare-and-delete — bezpieczne zwolnienie locka

**Problem:** lock wygasa po 30 s. Jeśli render instancji A trwa dłużej, lock wygaśnie
i przejmie go instancja B. Gdy A w końcu skończy i zawoła "zwolnij locka"…

**Naiwnie:** `DEL lock` — A kasuje locka **należącego już do B**. Teraz C może przejąć
"wolnego" locka i mamy dwa render-y naraz; domino się rozkręca.

**Trochę lepiej, wciąż źle:** `GET` (czy mój?) → `DEL`. Znowu check-then-act — lock może
wygasnąć i zostać przejęty dokładnie między GET a DEL.

**Handler:** atomowy skrypt Lua (`EVAL` wykonuje się w całości, nic się nie wciśnie):

```lua
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
```

`ARGV[1]` = nasz `instanceId` (`pid-{pid}-{48 losowych bitów}` — sam PID nie wystarcza,
bo w kontenerach każdy proces może mieć PID 1). Kasujemy tylko własnego locka.

## 3. `EXPIRE ... NX` + `GT` — pułapka kluczy bez TTL

**Problem:** indeks `index:{tag}` (SET kluczy wpisów) musi żyć co najmniej tak długo,
jak najtrwalszy wpis — inaczej `updateTags` nie znajdzie czego kasować. Ale nie może żyć
wiecznie, bo akumulowałby martwe membery.

**Naiwnie:** przy każdym zapisie `EXPIRE index {ttl_wpisu + 60}`. Psuje się w drugą
stronę: wpis krótkotrwały (np. 60 s) **skróciłby** TTL indeksu, w którym siedzą jeszcze
wpisy godzinne — indeks zniknie, a one zostaną bez indeksu (nieusuwalne przez tag).

**Pierwsza próba naprawy (też błędna, odkryte na żywym Redisie):** samo
`EXPIRE index ttl GT` ("przedłuż tylko w górę"). Niespodzianka: **`GT` pomija klucze,
które nie mają TTL** — Redis traktuje brak TTL jako nieskończoność, a nic nie jest
większe od nieskończoności. Świeżo utworzony indeks (po `SADD` nie ma TTL!) nigdy by go
nie dostał → `TTL = -1` na zawsze.

**Handler:** dwie komendy w pipeline, w tej kolejności:

```js
pipeline.expire(indexKey, ttl + 60, "NX"); // klucz bez TTL → nadaj
pipeline.expire(indexKey, ttl + 60, "GT"); // klucz z TTL → przedłuż tylko w górę
```

Razem: nowy indeks dostaje TTL, długi wpis przedłuża, krótki niczego nie skraca.

## 4. `getBuffer` vs `get` — binarka nie przeżyje dekodowania do stringa

**Problem:** wpisy są serializowane `v8.serialize` → **binarny** Buffer w Redis.

**Naiwnie:** `redis.get(key)` — klient "pomocnie" dekoduje odpowiedź jako string UTF-8.
Bajty niebędące poprawnym UTF-8 są po cichu zamieniane na znak zastępczy (U+FFFD) —
dane są **nieodwracalnie uszkodzone**. Objaw, który debugowaliśmy:
`Unable to deserialize cloned data due to invalid or unsupported version`.

**Handler:** `redis.getBuffer(key)` — ioredis zwraca surowy `Buffer`, `v8.deserialize`
dostaje dokładnie te bajty, które zapisaliśmy. (W node-redis odpowiednikiem był type
mapping na `Buffer` — to właśnie tam pierwotnie leżał bug.)

## 5. Pub/Sub — szybki, ale ulotny; i wymaga osobnego połączenia

**Problem:** po invalidacji wszystkie instancje muszą natychmiast wyczyścić swoje L1.

**Niuans 1 — fire-and-forget:** Redis Pub/Sub niczego nie przechowuje. Subskrybent
odłączony w momencie `PUBLISH` traci komunikat **bezpowrotnie** (to nie kolejka).
Dlatego Pub/Sub jest tylko optymalizacją szybkości — gwarancję poprawności daje
backstop timestampów `meta:revalidated-at:*` porównywanych z `entry.timestamp`
przy każdym odczycie (szczegóły i przykłady: [INVALIDATION-TIMESTAMPS.md](./INVALIDATION-TIMESTAMPS.md)).

**Niuans 2 — tryb subscribe blokuje klienta:** połączenie po `SUBSCRIBE` może wykonywać
wyłącznie komendy sub/unsub — żadnych `GET`/`SET`. Dlatego handler utrzymuje **dwa**
połączenia: główne (komendy) i subskrybenta (`setupSubscriber`).

**Niuans 3 — re-subskrypcja:** przy zwykłym zerwaniu połączenia ioredis po reconnect
sam odtwarza subskrypcje. Ale po permanentnej śmierci klienta (pkt 9) trzeba zbudować
nowego subskrybenta — handler robi to leniwie przy pierwszym requeście dotykającym
`use cache: remote`.

## 6. `MULTI`/pipeline — co naprawdę gwarantuje

**Problem:** zapis wpisu to kilka komend (SET payload, SADD do indeksów, 2× EXPIRE).
Osobne round-tripy = wolno i ryzyko przeplotu.

**Czego pipeline NIE daje:** to nie jest transakcja SQL. Nie ma rollbacku — jak trzecia
komenda się wywali, dwie pierwsze **zostają**. Błędy nie rzucają z `exec()`, tylko
wracają per komenda jako pary `[err, result]` (handler obecnie je ignoruje — świadomy
kompromis, najwyżej zadziała backstop/TTL).

**Co daje:** jeden round-trip sieciowy i — dzięki `MULTI` — wykonanie całej paczki
**bez przeplotu** z komendami innych klientów. Wystarcza nam w zupełności: kolejność
"payload przed indeksem" jest zachowana, więc nie istnieje moment, w którym indeks
wskazuje na nieistniejący wpis.

## 7. Indeks `SET` per tag — bo Redis nie umie "DEL WHERE tag = X"

**Problem:** `updateTags(["data:posts:pl:pl"])` musi skasować wszystkie wpisy z tym
tagiem, ale tag siedzi **wewnątrz** zserializowanego payloadu — Redis go nie widzi.

**Naiwnie:** `KEYS *` / `SCAN` + deserializacja każdego wpisu i sprawdzenie tagów.
`KEYS` blokuje cały Redis (O(N) na jednowątkowym serwerze — w prod to incydent),
`SCAN` nie blokuje, ale czytanie i deserializowanie wszystkiego przy każdej invalidacji
jest absurdalnie drogie.

**Handler:** odwrócony indeks utrzymywany przy zapisie: `SADD index:{tag} {kluczWpisu}`.
Invalidacja = `SMEMBERS index:{tag}` → `DEL` po liście → `DEL` indeksu. Koszt
proporcjonalny do liczby wpisów z tagiem, nie do rozmiaru bazy. Member SETa jest
**identyczny** z nazwą klucza wpisu (1:1) — to, co widzisz w indeksie, możesz wkleić
w Redis Insight.

## 8. `MGET` — N kluczy w jednym round-tripie

**Problem:** `refreshTags()` przed requestem musi pobrać timestampy wszystkich
invalidowanych tagów.

**Naiwnie:** pętla `GET` po tagach — N round-tripów × latencja sieci przy każdym
requeście HTTP.

**Handler:** `SMEMBERS meta:revalidated-tags` (lista tagów) + jeden
`MGET tag1 tag2 ...` (wszystkie timestampy naraz). `MGET` zwraca `null` dla kluczy,
których nie ma — co handler wykorzystuje do wykrywania wygasłych timestampów
i przycinania rejestru (`SREM`).

## 9. ioredis: `lazyConnect`, `enableOfflineQueue: false`, `retryStrategy`, zdarzenie `end`

Domyślna konfiguracja ioredis jest zaprojektowana pod "Redis to krytyczna baza —
czekaj na niego w nieskończoność". Dla cache to dokładnie odwrotność tego, czego chcemy:

| Opcja | Domyślnie | Czemu to złe dla cache | U nas |
|---|---|---|---|
| połączenie | przy `new Redis()` | konstruktor w top-level modułu zaczyna łączyć się w trakcie buildu/importu | `lazyConnect: true` — łączymy jawnie w `getRedis()` i kontrolujemy fallback |
| offline queue | włączona | komendy bez połączenia **wiszą w kolejce** czekając na reconnect → requesty HTTP wiszą razem z nimi | `enableOfflineQueue: false` — natychmiastowy błąd → łapiemy → serwujemy z L1 |
| retry | w nieskończoność | klient wiecznie reconnectuje, a my wiecznie "zaraz będzie" | `retryStrategy`: 5 prób (~5 s), potem rezygnacja |

**Najgroźniejszy niuans — `end`:** gdy `retryStrategy` zwróci `null`, ioredis emituje
zdarzenie `end` i klient jest **martwy na zawsze** — żadna komenda ani auto-reconnect
już nie zadziała. Trzymanie referencji do takiego klienta = permanentna degradacja do
L1 aż do restartu procesu (to był nasz krytyczny bug). Handler nasłuchuje `end`
i zeruje referencje (główny klient i subskrybent) + ustawia 30 s cooldown — następne
żądanie buduje świeże połączenie:

```js
client.on("end", () => {
  if (redisClient === client) {
    redisClient = null;
    redisConnecting = null;
    redisUnavailableUntil = Date.now() + 30_000;
  }
  // analogicznie dla subskrybenta
});
```

**Cooldown** (30 s bez prób) to ochrona przed dobijaniem się do martwego Redisa przy
każdym requeście — timeout połączenia × RPS = samozadana awaria.

## 10. `v8.serialize` — szybko i binarnie, ale przywiązane do wersji Node

**Problem:** wpis cache zawiera Buffery (payload RSC) + metadane.

**Naiwnie:** `JSON.stringify` — nie umie Bufferów (trzeba by base64 = +33% rozmiaru
i kopiowanie), gubi typy, wolniejszy na dużych strukturach.

**Handler:** `v8.serialize`/`v8.deserialize` — natywna serializacja strukturalna Node:
Buffery przechodzą bez konwersji, szybka, kompaktowa. **Cena:** format jest wewnętrzny
dla V8 i może się zmienić między wersjami Node. Stara wersja Node potrafi nie odczytać
wpisu z nowszej (`invalid or unsupported version`). Zasada: **wszystkie instancje na tej
samej wersji runtime** — u nas gwarantuje to wspólny obraz Docker. Rolling deploy ze
zmianą wersji Node = stare wpisy będą missami (nie błędami — handler łapie wyjątek),
cache wygrzeje się od nowa.

## 11. Przestrzeń kluczy pod Redis Insight — czemu `;` zamiast `:`

**Problem:** Redis Insight buduje drzewo kluczy, dzieląc nazwy po `:`. cacheKey
Next.js to JSON w stylu `["abc","hash",[{"country":"pl"}]]` — ze `:` w środku.

**Naiwnie:** surowy cacheKey jako klucz → Insight tnie go po każdym `:` z JSON-a
i drzewo rozpada się na śmieciowe gałęzie (`{"country"`, `"pl"}` …). Alternatywa
base64/hash — drzewo czyste, ale klucze nieczytelne dla człowieka.

**Handler:** minimalna transformacja `:` → `;` **tylko w cacheKey** (`encodeCacheKey`).
Klucz pozostaje czytelnym JSON-em, a Insight widzi go jako jeden węzeł. Tagi i prefiksy
(`index:…`, `meta:…`, `lock:…`) celowo zachowują `:` — to one budują sensowne drzewo
(`index:data`, `index:ui`, `meta:revalidated-at`). Założenie: cacheKey nigdy nie zawiera
`;` (dla kluczy generowanych przez Next.js — spełnione).

---

## Ściągawka

```
SET NX EX        atomowe "przejmij locka z TTL" — bez check-then-act
EVAL (Lua)       atomowe "skasuj locka tylko jeśli mój"
EXPIRE NX + GT   nadaj TTL nowemu / przedłuż istniejący — nigdy nie skracaj
GETBUFFER        binarka v8 musi wrócić jako Buffer, nie string
Pub/Sub          szybki ale ulotny → poprawność daje backstop timestampów
MULTI            1 round-trip + brak przeplotu; to NIE transakcja z rollbackiem
SET per tag      odwrócony indeks, bo nie ma "DEL po tagu" (i nigdy KEYS w prod!)
MGET             timestampy wszystkich tagów w jednym strzale
ioredis          lazyConnect + bez offline queue + krótki retry + obsługa "end"
v8.serialize     szybkie Buffery, ale jedna wersja Node na wszystkich instancjach
klucze z ";"     czytelne drzewo w Redis Insight
```
