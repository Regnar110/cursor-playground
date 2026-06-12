import { cacheLife, cacheTag } from "next/cache";
import { dataTag } from "@/lib/cache-tags";

export type Product = {
  id: number;
  title: string;
  description: string;
  price: number;
  rating: number;
  brand: string;
  thumbnail: string;
};

export type ProductsResponse = {
  products: Product[];
  total: number;
  skip: number;
  limit: number;
};

export async function getProducts(country: string, lang: string): Promise<ProductsResponse> {
  "use cache: remote";
  cacheLife("hours");
  cacheTag(dataTag("products", country, lang));

  const res = await fetch(
    "https://dummyjson.com/products?limit=8&select=title,description,price,rating,brand,thumbnail",
    { next: { revalidate: 3600 } },
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch products: ${res.status}`);
  }

  return res.json();
}
