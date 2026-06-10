"use server";

import { revalidatePath, revalidateTag, updateTag } from "next/cache";
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
  updateTag("cache-lab-data");
  updateTag(`cache-lab-data-${country}-${lang}`);

  const fresh = await getCacheLabData(country, lang);

  return {
    action: "updateTag",
    message:
      "Natychmiastowa invalidacja tagu cache-lab-data. Ten sam request widzi świeże dane z funkcji DATA.",
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
  updateTag("cache-lab-ui");
  updateTag(`cache-lab-ui-${country}-${lang}`);

  return {
    action: "updateTag",
    message:
      "Natychmiastowa invalidacja tagu cache-lab-ui. Przy odświeżeniu strony komponent UI przerenderuje się z nowym uiRenderedAt.",
  };
}

export async function cacheLabRevalidateTagData(
  country: string,
  lang: string,
): Promise<CacheLabActionResult> {
  revalidateTag("cache-lab-data", "max");
  revalidateTag(`cache-lab-data-${country}-${lang}`, "max");

  return {
    action: "revalidateTag",
    message:
      "Rewalidacja w tle (stale-while-revalidate). Bieżąca odpowiedź może być jeszcze stara — świeże dane pojawią się przy następnym żądaniu.",
  };
}

export async function cacheLabRevalidateTagUi(
  country: string,
  lang: string,
): Promise<CacheLabActionResult> {
  revalidateTag("cache-lab-ui", "max");
  revalidateTag(`cache-lab-ui-${country}-${lang}`, "max");

  return {
    action: "revalidateTag",
    message:
      "Rewalidacja UI w tle. Następne żądanie wyrenderuje nowy komponent UI (nowy uiRenderedAt), ale DATA wewnątrz może pochodzić ze swojego cache.",
  };
}

export async function cacheLabRevalidatePath(
  country: string,
  lang: string,
): Promise<CacheLabActionResult> {
  revalidatePath(`/${country}/${lang}/cache-lab`);

  return {
    action: "revalidatePath",
    message:
      "Invalidacja przez soft tagi ścieżki. Wpływa na cache powiązany z tą trasą (DATA + UI na tej podstronie).",
  };
}
