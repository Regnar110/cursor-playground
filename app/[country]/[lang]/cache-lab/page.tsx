import { Suspense } from "react";
import { notFound } from "next/navigation";
import { CacheBadge } from "@/components/cache-badge";
import { CacheLabControls } from "@/components/cache-lab-controls";
import { CacheLabDataPanel } from "@/components/cache-lab-data-panel";
import { CacheLabUiPanel } from "@/components/cache-lab-ui-panel";
import { dataTag, uiTag } from "@/lib/cache-tags";
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
  const dataTagValue = dataTag("cache-lab", country, lang);
  const uiTagValue = uiTag("cache-lab", country, lang);

  return (
    <section className="space-y-8">
      <div className="space-y-3">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-semibold">{labels.cacheLab}</h2>
          <CacheBadge label="LRU → Redis + Pub/Sub" />
        </div>
        <p className="max-w-3xl text-sm text-zinc-600 dark:text-zinc-400">
          Produkcja: jeden tag 1:1 per wpis cache — warstwa (<code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">data:</code> /{" "}
          <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">ui:</code>), zasób i locale
          (np. <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">{dataTagValue}</code>).
        </p>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        <CacheLabDataPanel data={cachedData} country={country} lang={lang} />
        <Suspense fallback={<PanelSkeleton />}>
          <CacheLabUiPanel country={country} lang={lang as LangCode} />
        </Suspense>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-zinc-100/50 p-5 text-sm dark:border-zinc-800 dark:bg-zinc-900/50">
        <h3 className="font-semibold">Konwencja tagów</h3>
        <ul className="mt-2 list-inside list-disc space-y-1 text-zinc-600 dark:text-zinc-400">
          <li>
            DATA: <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-800">{dataTagValue}</code>
          </li>
          <li>
            UI: <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-800">{uiTagValue}</code>
          </li>
        </ul>
        <h3 className="mt-4 font-semibold">Redis Insight</h3>
        <ul className="mt-2 list-inside list-disc space-y-1 text-zinc-600 dark:text-zinc-400">
          <li>
            Wpis cache = cacheKey Next.js z{" "}
            <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-800">:</code> →{" "}
            <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-800">;</code> (JSON ze{" "}
            <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-800">:</code> rozbijałby drzewo); pole{" "}
            <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-800">_meta</code> w payloadzie v8
          </li>
          <li>
            <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-800">index:data:posts:pl:pl</code> /{" "}
            <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-800">index:ui:posts:pl:pl</code> — SET; member =
            ten sam string co klucz wpisu (drzewo <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-800">index:data</code> /{" "}
            <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-800">index:ui</code>)
          </li>
          <li>
            <code className="rounded bg-zinc-200 px-1 dark:bg-zinc-800">meta:revalidated-at:…</code> — timestamp
            invalidacji, nie treść cache
          </li>
        </ul>
      </div>

      <CacheLabControls country={country} lang={lang as LangCode} />
    </section>
  );
}
