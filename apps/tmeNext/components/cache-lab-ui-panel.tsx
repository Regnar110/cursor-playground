import { cacheLife, cacheTag } from "next/cache";
import { uiTag } from "@/lib/cache-tags";
import { getCacheLabData } from "@/lib/data/cache-lab";

type Props = {
  country: string;
  lang: string;
};

export async function CacheLabUiPanel({ country, lang }: Props) {
  "use cache: remote";
  cacheLife("minutes");
  cacheTag(uiTag("cache-lab", country, lang));

  const data = await getCacheLabData(country, lang);
  const uiRenderedAt = new Date().toISOString();

  return (
    <div className="space-y-4 rounded-xl border-2 border-violet-300 bg-violet-50 p-5 dark:border-violet-800 dark:bg-violet-950/40">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded-full bg-violet-600 px-2.5 py-0.5 text-xs font-semibold text-white">
          WARSTWA UI
        </span>
        <span className="text-xs text-violet-700 dark:text-violet-300">
          tag: {uiTag("cache-lab", country, lang)} · use cache: remote
        </span>
      </div>

      <blockquote className="border-l-4 border-violet-400 pl-4 text-lg italic text-zinc-800 dark:text-zinc-100">
        &ldquo;{data.quote}&rdquo;
        <footer className="mt-2 text-sm not-italic text-zinc-500">— {data.author}</footer>
      </blockquote>

      <dl className="grid gap-2 text-xs sm:grid-cols-2">
        <div className="rounded-lg bg-white/70 p-3 dark:bg-zinc-900/70">
          <dt className="font-medium text-zinc-500">UI wyrenderowane</dt>
          <dd className="mt-0.5 font-mono">{uiRenderedAt}</dd>
        </div>
        <div className="rounded-lg bg-white/70 p-3 dark:bg-zinc-900/70">
          <dt className="font-medium text-zinc-500">Instancja UI (pid)</dt>
          <dd className="mt-0.5 font-mono">{`pid-${process.pid}`}</dd>
        </div>
        <div className="rounded-lg bg-white/70 p-3 dark:bg-zinc-900/70">
          <dt className="font-medium text-zinc-500">Dane z warstwy DATA (wewnątrz UI)</dt>
          <dd className="mt-0.5 font-mono">{data.dataFetchedAt}</dd>
        </div>
        <div className="rounded-lg bg-white/70 p-3 dark:bg-zinc-900/70">
          <dt className="font-medium text-zinc-500">Instancja DATA (pid)</dt>
          <dd className="mt-0.5 font-mono">{data.dataInstance}</dd>
        </div>
      </dl>
    </div>
  );
}
