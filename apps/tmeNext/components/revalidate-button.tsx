"use client";

import { useTransition } from "react";
import { revalidatePosts, revalidateUsers, revalidateProducts } from "@/app/actions/revalidate";
import type { CacheResource } from "@/lib/cache-tags";

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
      className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
    >
      {pending ? "…" : label}
    </button>
  );
}
