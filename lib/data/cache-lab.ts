import { cacheLife, cacheTag } from "next/cache";
import { dataTag } from "@/lib/cache-tags";

export type CacheLabData = {
  quote: string;
  author: string;
  dataFetchedAt: string;
  dataInstance: string;
  cacheProfile: string;
};

export async function getCacheLabData(
  country: string,
  lang: string,
): Promise<CacheLabData> {
  "use cache: remote";
  cacheLife("minutes");
  cacheTag(dataTag("cache-lab", country, lang));

  const res = await fetch("https://dummyjson.com/quotes/random", {
    next: { revalidate: 300 },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch quote: ${res.status}`);
  }

  const json = (await res.json()) as { quote: string; author: string };

  return {
    quote: json.quote,
    author: json.author,
    dataFetchedAt: new Date().toISOString(),
    dataInstance: `pid-${process.pid}`,
    cacheProfile: "minutes",
  };
}
