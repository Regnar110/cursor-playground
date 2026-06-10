"use server";

import { revalidateTag } from "next/cache";

export async function revalidatePosts() {
  revalidateTag("posts", "max");
  revalidateTag("posts-ui", "max");
}

export async function revalidateUsers() {
  revalidateTag("users", "max");
  revalidateTag("users-ui", "max");
}

export async function revalidateProducts() {
  revalidateTag("products", "max");
  revalidateTag("products-ui", "max");
}
