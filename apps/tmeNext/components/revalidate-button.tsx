"use client";

import { useTransition } from "react";
import { revalidatePosts, revalidateUsers, revalidateProducts } from "@/app/actions/revalidate";
import type { CacheResource } from "@/lib/cache-tags";
import styles from "./revalidate-button.module.css";

type Props = {
  label: string;
  resource: Exclude<CacheResource, "cache-lab">;
  country: string;
  lang: string;
};

const actions = {
  posts: revalidatePosts,
  users: revalidateUsers,
  products: revalidateProducts,
};

export function RevalidateButton({ label, resource, country, lang }: Props) {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      disabled={pending}
      onClick={() => startTransition(() => actions[resource](country, lang))}
      className={styles.button}
    >
      {pending ? "…" : label}
    </button>
  );
}
