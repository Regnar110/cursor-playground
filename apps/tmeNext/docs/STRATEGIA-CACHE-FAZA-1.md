# Strategia cache — Faza 1 (tylko remote)

**Cel:** ustabilizować cache **danych** w Redis (współdzielony między podami) oraz **read-your-own-writes** na stronach z mutacją — zanim dołożysz ISR.

**Środowisko:** staging, dev, wczesna produkcja.

Powrót do indeksu: [STRATEGIA-CACHE.md](./STRATEGIA-CACHE.md) · Następny krok: [Faza 2](./STRATEGIA-CACHE-FAZA-2.md)

---

## Config

```ts
// next.config.ts
cacheComponents: true,
cacheHandlers: {
  remote: require.resolve("@tme/cache-handler"),
},
// brak cacheHandler (ISR)
```

---

## Dane (remote) — fundament na obie fazy

| Element | Gdzie | Zasady |
|---------|-------|--------|
| **DATA** | `lib/data/*.ts` | `"use cache: remote"` + `cacheLife` + `cacheTag` |
| **UI** | `components/cached-*.tsx` | to samo + woła DATA |

**Świeżość:**

| Sytuacja | Co robisz |
|----------|-----------|
| Odczyt, brak zapisu | `cacheLife` na DATA i UI |
| Użytkownik zapisał | `updateTag` (DATA **i** UI) → `router.refresh()` |

Profile: `hours` / `days` dla katalogów; `minutes` dla demo. Unikaj `cacheLife("max")` na danych edytowalnych przez użytkownika.

```ts
"use server";
import { updateTag } from "next/cache";

export async function saveResource(country: string, lang: string, data: FormData) {
  await persist(data);
  updateTag(dataTag("resource", country, lang));
  updateTag(uiTag("resource", country, lang));
}
```

---

## Strony — bez współdzielonego ISR

Route cache jest **lokalny per pod**. Dane w Redis są współdzielone; snapshot HTML strony — nie.

| Typ strony | Przykład | `connection()` | Dane | Strona |
|------------|----------|----------------|------|--------|
| **Odczyt** | `/posts`, `/products` | Nie | `cacheLife` | Lokalny per pod — możliwy rozjazd między instancjami |
| **Mutacja** | `/account`, formularze | **Tak** | `cacheLife` + `updateTag` | Render per-request |

### Strona mutacji

```tsx
import { connection } from "next/server";

async function AccountContent({ params }: { params: Promise<{ country: string; lang: string }> }) {
  await connection();
  const { country, lang } = await params;
  return <AccountForm country={country} lang={lang} />;
}
```

### Strona odczytu

```tsx
async function PostsContent({ params }) {
  const { country, lang } = await params;
  return <CachedPostsList country={country} lang={lang} />;
}
```

Po mutacji na kliencie: `router.refresh()`.

---

## Ograniczenia fazy 1

- Strony odczytu mogą **różnić się między podami** (lokalny route cache).
- To **nie jest** docelowa produkcja wieloinstancyjna dla katalogów — warunek wejścia w fazę 2 to działający model danych i mutacji.

---

## Kryteria akceptacji → przejście do fazy 2

**Infrastruktura**

- [ ] `cacheHandlers.remote` + Redis (L1 + L2) na stagingu.
- [ ] ≥ 2 instancje za load balancerem.
- [ ] Awaria Redis → degradacja L1, aplikacja bez 5xx.

**Dane**

- [ ] Zasoby produkcyjne: DATA + UI z `"use cache: remote"`.
- [ ] Każdy wpis: `cacheLife` + tag z `lib/cache-tags.ts`.
- [ ] Po zapisie: `updateTag` na DATA **i** UI we wszystkich Server Actions z mutacją.

**Strony**

- [ ] Route mutacji: `connection()` w treści strony.
- [ ] Route odczytu: zidentyfikowane (lista pod ISR w fazie 2).
- [ ] Po mutacji: `router.refresh()` na kliencie.

**Weryfikacja**

- [ ] Read-your-own-writes: zapis → od razu świeże dane.
- [ ] Zapis na podzie A → F5 na pod B → świeże dane (mutacja ma `connection()`).
- [ ] Cache hit w Redis na remote (nie tylko L1).
- [ ] Brak `revalidateTag` / `revalidatePath` w kodzie prod.

---

## Antywzorce (faza 1)

| Nie rób | Skutek |
|---------|--------|
| `updateTag` tylko na UI | Stary DATA wewnątrz UI |
| `router.refresh()` bez `updateTag` | Stary remote cache |
| `updateTag` bez mutacji | Zbędne |
| Pominięcie fazy 1 przed ISR | ISR maskuje zły model danych |

---

## Checklist — nowa funkcja (faza 1)

- [ ] DATA: `"use cache: remote"` + `cacheLife` + tag.
- [ ] UI: to samo, woła DATA.
- [ ] Server Action z mutacją: `updateTag` (DATA + UI).
- [ ] Strona mutacji: `connection()`.
- [ ] Strona odczytu: bez `connection()`.
