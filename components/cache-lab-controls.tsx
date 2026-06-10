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

const actions: Record<
  ActionKey,
  (country: string, lang: string) => Promise<CacheLabActionResult>
> = {
  "updateTag-data": cacheLabUpdateTagData,
  "updateTag-ui": cacheLabUpdateTagUi,
  "revalidateTag-data": cacheLabRevalidateTagData,
  "revalidateTag-ui": cacheLabRevalidateTagUi,
  revalidatePath: cacheLabRevalidatePath,
};

export function CacheLabControls({ country, lang }: Props) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [result, setResult] = useState<CacheLabActionResult | null>(null);

  function runAction(key: ActionKey) {
    startTransition(async () => {
      const res = await actions[key](country, lang);
      setResult(res);
      router.refresh();
    });
  }

  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2">
        <ActionGroup title="updateTag() — natychmiast">
          <ActionButton
            disabled={pending}
            onClick={() => runAction("updateTag-data")}
            label="updateTag → DATA"
            hint="Unieważnia getCacheLabData(), zwraca świeże dane w tej samej akcji"
          />
          <ActionButton
            disabled={pending}
            onClick={() => runAction("updateTag-ui")}
            label="updateTag → UI"
            hint="Unieważnia CacheLabUiPanel — widać po router.refresh()"
          />
        </ActionGroup>

        <ActionGroup title="revalidateTag() — w tle">
          <ActionButton
            disabled={pending}
            onClick={() => runAction("revalidateTag-data")}
            label="revalidateTag → DATA"
            hint="Stale-while-revalidate; świeże dane przy następnym requeście"
          />
          <ActionButton
            disabled={pending}
            onClick={() => runAction("revalidateTag-ui")}
            label="revalidateTag → UI"
            hint="Rewalidacja komponentu UI w tle"
          />
        </ActionGroup>

        <ActionGroup title="revalidatePath() — soft tagi">
          <ActionButton
            disabled={pending}
            onClick={() => runAction("revalidatePath")}
            label={`revalidatePath(/${country}/${lang}/cache-lab)`}
            hint="Invaliduje cache powiązany ze ścieżką (DATA + UI tej strony)"
          />
        </ActionGroup>

        <ActionGroup title="cacheLife() — konfiguracja">
          <p className="text-sm text-zinc-600 dark:text-zinc-400">
            Profil <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">minutes</code> na
            DATA i UI. Po upływie <code className="rounded bg-zinc-100 px-1 dark:bg-zinc-800">revalidate</code>{" "}
            Next.js odświeża wpis w tle. Sprawdź timestampy powyżej — jeśli się nie zmieniają, cache
            nadal trzyma wpis w LRU lub Redis.
          </p>
        </ActionGroup>
      </div>

      {pending && (
        <p className="text-sm text-zinc-500">Wykonywanie akcji cache…</p>
      )}

      {result && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm dark:border-amber-800 dark:bg-amber-950/40">
          <p className="font-semibold text-amber-900 dark:text-amber-200">
            {result.action}
          </p>
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
