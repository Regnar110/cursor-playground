"use client";

import { useTransition } from "react";
import styles from "./revalidate-button.module.css";

type Props = {
  label: string;
  action: () => Promise<void>;
};

export function ActionButton({ label, action }: Props) {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => action())}
      className={styles.button}
    >
      {pending ? "…" : label}
    </button>
  );
}
