import { dataTag } from "@/lib/cache-tags";
import type { CacheLabData } from "@/lib/data/cache-lab";

type Props = {
  data: CacheLabData;
  country: string;
  lang: string;
};

export function CacheLabDataPanel({ data, country, lang }: Props) {
  const dataTagValue = dataTag("cache-lab", country, lang);

  return (
    <div className="space-y-4 rounded-xl border-2 border-sky-300 bg-sky-50 p-5 dark:border-sky-800 dark:bg-sky-950/40">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-sky-600 px-2.5 py-0.5 text-xs font-semibold text-white">
          WARSTWA DATA
        </span>
        <span className="text-xs text-sky-700 dark:text-sky-300">
          tag: {dataTagValue} · getCacheLabData()
        </span>
      </div>

      <p className="text-sm text-zinc-700 dark:text-zinc-300">
        <strong>Cytat:</strong> {data.quote}
      </p>
      <p className="text-sm text-zinc-500">— {data.author}</p>

      <dl className="grid gap-2 text-xs sm:grid-cols-2">
        <div className="rounded-lg bg-white/70 p-3 dark:bg-zinc-900/70">
          <dt className="font-medium text-zinc-500">Dane pobrane</dt>
          <dd className="mt-0.5 font-mono">{data.dataFetchedAt}</dd>
        </div>
        <div className="rounded-lg bg-white/70 p-3 dark:bg-zinc-900/70">
          <dt className="font-medium text-zinc-500">Instancja DATA (pid)</dt>
          <dd className="mt-0.5 font-mono">{data.dataInstance}</dd>
        </div>
        <div className="rounded-lg bg-white/70 p-3 dark:bg-zinc-900/70">
          <dt className="font-medium text-zinc-500">cacheLife profil</dt>
          <dd className="mt-0.5 font-mono">{data.cacheProfile}</dd>
        </div>
      </dl>
    </div>
  );
}
