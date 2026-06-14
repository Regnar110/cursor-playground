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
import shared from "@/styles/shared.module.css";
import styles from "./cache-lab-controls.module.css";

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
    <div className={styles.root}>
      <div className={shared.controlsGrid}>
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

      {pending && <p className={styles.pending}>Wykonywanie akcji cache…</p>}

      {result && (
        <div className={styles.result}>
          <p className={styles.resultTitle}>{result.action}</p>
          <p className={styles.resultMessage}>{result.message}</p>
          {result.freshData && (
            <pre className={styles.resultPre}>{JSON.stringify(result.freshData, null, 2)}</pre>
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
    <div className={styles.group}>
      <h3 className={styles.groupTitle}>{title}</h3>
      <div className={styles.groupActions}>{children}</div>
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
    <button type="button" disabled={disabled} onClick={onClick} className={styles.actionButton}>
      <span className={styles.actionLabel}>{label}</span>
      <span className={styles.actionHint}>{hint}</span>
    </button>
  );
}
