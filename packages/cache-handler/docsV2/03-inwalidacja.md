# 03 — Inwalidacja

Unieważnianie cache to najtrudniejszy problem w systemie wieloinstancyjnym:
komunikat „skasuj wpisy z tagiem X" musi dotrzeć do **każdej** instancji, także
takiej, która akurat traciła połączenie. Ta paczka rozwiązuje to dwoma
uzupełniającymi się mechanizmami.

## Dwa mechanizmy, jeden cel

| Mechanizm | Szybkość | Niezawodność | Rola |
|-----------|----------|--------------|------|
| **Pub/Sub** | natychmiast | „fire and forget" — komunikat może przepaść | Szybkie czyszczenie L1 we wszystkich instancjach |
| **Znaczniki czasu tagów** | przy najbliższym żądaniu | trwałe (klucze w Redis, TTL 7 dni) | Siatka bezpieczeństwa, gdy Pub/Sub zawiedzie |

## Przepływ unieważnienia — `updateTags`

Gdy aplikacja woła `revalidateTag(...)`, Next.js przekazuje to do handlera:

```mermaid
sequenceDiagram
    participant App as Aplikacja (revalidateTag)
    participant H as Handler (instancja A)
    participant R as Redis
    participant B as Instancje B, C, ...

    App->>H: unieważnij tag "data:posts:pl:pl"
    H->>H: zapisz czas unieważnienia lokalnie,<br/>wyczyść pasujące wpisy z własnego L1
    H->>R: odczytaj indeks taga → lista kluczy
    H->>R: skasuj wpisy + indeks,<br/>zapisz znacznik czasu unieważnienia (TTL 7 dni)
    H->>R: opublikuj komunikat Pub/Sub
    R-->>B: komunikat "tag X unieważniony, klucze: [...]"
    B->>B: wyczyść pasujące wpisy z L1
```

Po tej sekwencji:

- w Redis nie ma już wpisów z tym tagiem (ani jego indeksu),
- każda żywa instancja wyczyściła swoje L1,
- w Redis został **znacznik czasu**: „tag X unieważniono o godzinie T".

Gdy Redis jest niedostępny, unieważnienie i tak czyści lokalne L1 i lokalne
znaczniki — instancja, która je wykonała, natychmiast widzi świeże dane.

## Siatka bezpieczeństwa — znaczniki czasu tagów

Co jeśli instancja **nie dostała** komunikatu Pub/Sub (restart, chwilowy brak
połączenia, restart samego Redisa)? Wpis w jej L1 albo świeżo odczytany z Redis
mógłby być „zombie" — skasowany logicznie, ale wciąż serwowany.

Tu wchodzi drugi mechanizm:

1. Każde unieważnienie zapisuje w Redis trwały znacznik: *tag → czas unieważnienia*
   (żyje 7 dni, potem Redis go sprząta).
2. Przed obsługą żądania Next.js woła `refreshTags` — handler zaciąga wtedy
   wszystkie znaczniki do lokalnej mapy w pamięci.
3. Przy **każdym** odczycie handler porównuje: czy któryś tag wpisu ma znacznik
   nowszy niż czas powstania wpisu? Jeśli tak — wpis jest odrzucany, niezależnie
   od tego, skąd przyszedł (L1 czy Redis).

```mermaid
flowchart TD
    A["Odczyt wpisu\n(z L1 albo Redis)"] --> B{"Czas unieważnienia\nktóregoś taga wpisu\n> czas powstania wpisu?"}
    B -- tak --> R["Odrzuć — wpis powstał\nprzed unieważnieniem"]
    B -- nie --> OK["Wpis przechodzi\ndalsze kontrole świeżości"]
```

Dzięki temu nawet instancja, która przespała komunikat Pub/Sub, odrzuci
nieaktualny wpis najpóźniej przy pierwszym żądaniu po odzyskaniu łączności.

## Soft tagi

Oprócz tagów zapisanych we wpisie, Next.js może przy odczycie przekazać
**soft tagi** — tagi kontekstu żądania (np. tag ścieżki), których nie ma we wpisie.
Handler sprawdza je tym samym mechanizmem znaczników czasu: unieważnienie soft
taga po powstaniu wpisu również go odrzuca.

## Dlaczego dwa mechanizmy, a nie jeden

- Sam Pub/Sub jest szybki, ale zawodny — Redis nie gwarantuje dostarczenia
  komunikatu subskrybentom, którzy byli offline.
- Same znaczniki czasu są niezawodne, ale leniwie egzekwowane — czyszczą wpis
  dopiero przy odczycie, więc L1 mogłoby przez kilkanaście sekund serwować
  starą treść.
- Razem dają: **natychmiastowość** (Pub/Sub czyści L1 od razu) i **gwarancję**
  (znacznik czasu domyka każdą lukę).
