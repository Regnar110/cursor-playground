import { cacheLife, cacheTag } from "next/cache";
import { dataTag } from "@/lib/cache-tags";

export type Post = {
  id: number;
  title: string;
  body: string;
  userId: number;
  tags: string[];
  reactions: { likes: number; dislikes: number };
};

export type PostsResponse = {
  posts: Post[];
  total: number;
  skip: number;
  limit: number;
};

export async function getPosts(country: string, lang: string): Promise<PostsResponse> {
  "use cache: remote";
  cacheLife("hours");
  cacheTag(dataTag("posts", country, lang));

  const res = await fetch("https://dummyjson.com/posts?limit=8&select=title,body,userId,tags,reactions", {
    next: { revalidate: 3600 },
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch posts: ${res.status}`);
  }

  return res.json();
}
