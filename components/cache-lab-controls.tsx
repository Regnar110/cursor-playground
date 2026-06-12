"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import {
  cacheLabRevalidatePath,
  cacheLabRevalidateTagData,
  cacheLabRevalidateTagUi,
  cacheLabUpdateTagData,
  cacheLabUpdateTagUi,
  type CacheLabActionResult,
} from "@/app/actions/cache-lab";
import { dataTag, uiTag } from "@/lib/cache-tags";

type Props = {
  country: string;
  lang: string;
};

type ActionKey =
  | "updateTag-data"
  | "updateTag-ui"
  | "revalidateTag-data"
  | "revalidateTag-ui"
  | "revalidatePath";

export function CacheLabControls({ country, lang }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<CacheLabActionResult | null>(null);

  const dataTagValue = dataTag("cache-lab", country, lang);
  const uiTagValue = uiTag("cache-lab", country, lang);

  function runAction(key: ActionKey) {
    startTransition(async () => {
      const res = await {
        "updateTag-data": () => cacheLabUpdateTagData(country, lang),
        "updateTag-ui": () => cacheLabUpdateTagUi(country, lang),
        "revalidateTag-data": () => cacheLabRevalidateTagData(country, lang),
        "revalidateTag-ui": () => cacheLabRevalidateTagUi(country, lang),
        revalidatePath: () => cacheLabRevalidatePath(country, lang),
      }[key]();
      setResult(res);
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-3 lg:grid-cols-2">
        <ActionGroup title="updateTag() — natychmiast">
          <ActionButton
            disabled={pending}
            onClick={() => runAction("updateTag-data")}
            label={`DATA → ${dataTagValue}`}
            hint="Invalidacja danych dla bieżącego country/lang"
          />
          <ActionButton
            disabled={pending}
            onClick={() => runAction("updateTag-ui")}
            label={`UI → ${uiTagValue}`}
            hint="Invalidacja UI dla bieżącego country/lang"
          />
        </ActionGroup>

        <ActionGroup title="revalidateTag() — w tle (SWR)">
          <ActionButton
            disabled={pending}
            onClick={() => runAction("revalidateTag-data")}
            label={`revalidate ${dataTagValue}`}
            hint="Rewalidacja danych — tylko to locale"
          />
          <ActionButton
            disabled={pending}
            onClick={() => runAction("revalidateTag-ui")}
            label={`revalidate ${uiTagValue}`}
            hint="Rewalidacja UI — tylko to locale"
          />
        </ActionGroup>

        <ActionGroup title="revalidatePath()">
          <ActionButton
            disabled={pending}
            onClick={() => runAction("revalidatePath")}
            label={`revalidatePath(/${country}/${lang}/cache-lab)`}
            hint="Invalidacja przez soft tagi ścieżki"
          />
        </ActionGroup>
      </div>

      {pending && <p className="text-sm text-zinc-500">Wykonywanie akcji cache…</p>}

      {result && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950/40">
          <p className="font-semibold text-amber-900 dark:text-amber-200">{result.action}</p>
          <p className="mt-1 text-amber-800 dark:text-amber-300">{result.message}</p>
          {result.freshData && (
            <pre className="mt-3 overflow-x-auto rounded-lg bg-white/80 p-3 text-xs dark:bg-zinc-900/80">
              {JSON.stringify(result.freshData, null, 2)}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}

function ActionGroup({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <h3 className="mb-3 text-sm font-semibold text-zinc-800 dark:text-zinc-200">{title}</h3>
      <div className="space-y-2">{children}</div>
    </div>
  );
}

function ActionButton({
  label,
  hint,
  disabled,
  onClick,
}: {
  label: string;
  hint: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="w-full rounded-lg border border-zinc-200 px-3 py-2 text-left text-sm transition hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-800"
    >
      <span className="font-medium">{label}</span>
      <span className="mt-0.5 block text-xs text-zinc-500">{hint}</span>
    </button>
  );
}
