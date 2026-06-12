# Architectural Decision Records (ADR)

Rejestr istotnych decyzji architektonicznych aplikacji tmeNext. ADR opisuje **kontekst**
decyzji, **rozważane opcje** i **konsekwencje** — żeby za rok było wiadomo nie tylko
„jak jest", ale „dlaczego tak".

## Jak dodać nowy ADR

1. Skopiuj [template.md](./template.md) jako `NNNN-krotki-tytul.md` (kolejny numer).
2. Wypełnij sekcje; status zaczyna się od `Propozycja`, po akceptacji → `Zaakceptowana`.
3. ADR-ów **nie edytuje się po akceptacji** (poza statusem) — zmiana decyzji = nowy ADR
   ze statusem starego ustawionym na `Zastąpiona przez ADR-NNNN`.
4. Dopisz wpis do indeksu poniżej.

## Indeks

| Nr | Tytuł | Status | Data |
|---|---|---|---|
| [0001](./0001-zdalny-cache-redis.md) | Zdalny cache `use cache: remote` na własnym handlerze (LRU + Redis + Pub/Sub) | Zaakceptowana | 2026-06-12 |
