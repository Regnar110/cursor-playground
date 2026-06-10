import { CacheBadge } from "@/components/cache-badge";
import { getLabels, isValidCountry, isValidLang, type LangCode } from "@/lib/i18n";
import { notFound } from "next/navigation";

type Props = {
  params: Promise<{ country: string; lang: string }>;
};

export default async function LocaleHomePage({ params }: Props) {
  const { country, lang } = await params;

  if (!isValidCountry(country) || !isValidLang(lang)) {
    notFound();
  }

  const labels = getLabels(lang as LangCode);

  return (
    <section className="space-y-6 rounded-2xl border border-zinc-200 bg-white p-8 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-2xl font-semibold">{labels.home}</h2>
        <CacheBadge label="use cache: remote" />
      </div>
      <p className="text-zinc-600 dark:text-zinc-400">
        Ten playground demonstruje routing <code className="rounded bg-zinc-100 px-1.5 py-0.5 text-sm dark:bg-zinc-800">/[country]/[lang]</code>{" "}
        z 10 krajami i 30 językami. Każda podstrona pobiera dane z DummyJSON i cache&apos;uje zarówno funkcje danych, jak i komponenty UI przez Redis z warstwą LRU.
      </p>
      <dl className="grid gap-4 sm:grid-cols-3">
        <div className="rounded-xl bg-zinc-50 p-4 dark:bg-zinc-950">
          <dt className="text-xs uppercase tracking-wide text-zinc-500">Warstwa L1</dt>
          <dd className="mt-1 font-medium">LRU (in-process)</dd>
        </div>
        <div className="rounded-xl bg-zinc-50 p-4 dark:bg-zinc-950">
          <dt className="text-xs uppercase tracking-wide text-zinc-500">Warstwa L2</dt>
          <dd className="mt-1 font-medium">Redis (remote handler)</dd>
        </div>
        <div className="rounded-xl bg-zinc-50 p-4 dark:bg-zinc-950">
          <dt className="text-xs uppercase tracking-wide text-zinc-500">Dyrektywa</dt>
          <dd className="mt-1 font-mono text-sm">use cache: remote</dd>
        </div>
      </dl>
    </section>
  );
}
