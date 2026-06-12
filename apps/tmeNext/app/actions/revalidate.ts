"use server";

import { revalidateTag } from "next/cache";
import { dataTag, uiTag, type CacheResource } from "@/lib/cache-tags";

function revalidateResource(resource: CacheResource, country: string, lang: string) {
  revalidateTag(dataTag(resource, country, lang), "max");
  revalidateTag(uiTag(resource, country, lang), "max");
}

export async function revalidatePosts(country: string, lang: string) {
  revalidateResource("posts", country, lang);
}

export async function revalidateUsers(country: string, lang: string) {
  revalidateResource("users", country, lang);
}

export async function revalidateProducts(country: string, lang: string) {
  revalidateResource("products", country, lang);
}
