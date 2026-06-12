"use server";

import { revalidatePath, revalidateTag, updateTag } from "next/cache";
import { dataTag, uiTag } from "@/lib/cache-tags";
import { getCacheLabData } from "@/lib/data/cache-lab";

export type CacheLabActionResult = {
  action: string;
  message: string;
  freshData?: {
    quote: string;
    author: string;
    dataFetchedAt: string;
    dataInstance: string;
  };
};

export async function cacheLabUpdateTagData(
  country: string,
  lang: string,
): Promise<CacheLabActionResult> {
  const tag = dataTag("cache-lab", country, lang);
  updateTag(tag);

  const fresh = await getCacheLabData(country, lang);

  return {
    action: "updateTag",
    message: `Natychmiastowa invalidacja ${tag}.`,
    freshData: {
      quote: fresh.quote,
      author: fresh.author,
      dataFetchedAt: fresh.dataFetchedAt,
      dataInstance: fresh.dataInstance,
    },
  };
}

export async function cacheLabUpdateTagUi(
  country: string,
  lang: string,
): Promise<CacheLabActionResult> {
  const tag = uiTag("cache-lab", country, lang);
  updateTag(tag);

  return {
    action: "updateTag",
    message: `Natychmiastowa invalidacja ${tag}.`,
  };
}

export async function cacheLabRevalidateTagData(
  country: string,
  lang: string,
): Promise<CacheLabActionResult> {
  const tag = dataTag("cache-lab", country, lang);
  revalidateTag(tag, "max");

  return {
    action: "revalidateTag",
    message: `Rewalidacja w tle: ${tag}`,
  };
}

export async function cacheLabRevalidateTagUi(
  country: string,
  lang: string,
): Promise<CacheLabActionResult> {
  const tag = uiTag("cache-lab", country, lang);
  revalidateTag(tag, "max");

  return {
    action: "revalidateTag",
    message: `Rewalidacja w tle: ${tag}`,
  };
}

export async function cacheLabRevalidatePath(
  country: string,
  lang: string,
): Promise<CacheLabActionResult> {
  revalidatePath(`/${country}/${lang}/cache-lab`);

  return {
    action: "revalidatePath",
    message: `Invalidacja soft tagów ścieżki /${country}/${lang}/cache-lab`,
  };
}
