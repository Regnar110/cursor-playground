import { Suspense } from "react";
import { notFound } from "next/navigation";
import { CacheBadge } from "@/components/cache-badge";
import { CacheLabControls } from "@/components/cache-lab-controls";
import { CacheLabDataPanel } from "@/components/cache-lab-data-panel";
import { CacheLabUiPanel } from "@/components/cache-lab-ui-panel";
import { getCacheLabData } from "@/lib/data/cache-lab";
import { getLabels, isValidCountry, isValidLang, type LangCode } from "@/lib/i18n";

type Props = {
  params: Promise<{ country: string; lang: string }>;
};

function PanelSkeleton() {
  return <div className="h-48 animate-pulse rounded-xl bg-zinc-200 dark:bg-zinc-800" />;
}

export default async function CacheLabPage({ params }: Props) {
  const { country, lang } = await params;

  if (!isValidCountry(country) || !isValidLang(lang)) {
    notFound();
  }

  const labels = getLabels(lang as LangCode);
  const cachedData = await getCacheLabData(country, lang);

  return (
    <section className="space-y-8">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-semibold">{labels.cacheLab}</h2>
          <CacheBadge label="LRU → Redis + Pub/Sub" />
        </div>
        <p className="max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
          Ta strona demonstruje różnicę między cache&apos;owaniem{" "}
          <strong>funkcji danych</strong> (niebieski panel) a cache&apos;owaniem{" "}
          <strong>komponentu UI</strong> (fioletowy panel). Oba używają{" "}
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">use cache: remote</code>, ale
          mają osobne tagi — możesz invalidować je niezależnie.
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <CacheLabDataPanel data={cachedData} />
        <Suspense fallback={<PanelSkeleton />}>
          <CacheLabUiPanel country={country} lang={lang as LangCode} />
        </Suspense>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-zinc-100/50 p-5 text-sm dark:border-zinc-800 dark:bg-zinc-900/50">
        <h3 className="font-semibold">Jak czytać wyniki</h3>
        <ul className="mt-2 list-inside list-disc space-y-1 text-zinc-600 dark:text-zinc-400">
          <li>
            <strong>DATA</strong> — <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-800">getCacheLabData()</code>{" "}
            wołane na poziomie strony; timestamp i pid powinny zostać takie same po odświeżeniu (dopóki tag nie
            zostanie unieważniony)
          </li>
          <li>
            <strong>UI</strong> — <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-800">uiRenderedAt</code>{" "}
            zmienia się tylko gdy invalidujesz tag <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-800">cache-lab-ui</code>
          </li>
          <li>
            Invalidacja tylko DATA nie odświeża UI (UI wciąż serwuje stary HTML z cache)
          </li>
          <li>
            Invalidacja UI wymusza nowy render, ale DATA wewnątrz może być nadal z cache
          </li>
          <li>
            Przy 15 instancjach: Pub/Sub czyści LRU na wszystkich; Redis jest współdzielony
          </li>
        </ul>
      </div>

      <CacheLabControls country={country} lang={lang as LangCode} />
    </section>
  );
}
