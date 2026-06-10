import { cacheLife, cacheTag } from "next/cache";

export type User = {
  id: number;
  firstName: string;
  lastName: string;
  email: string;
  company: { name: string };
  image: string;
};

export type UsersResponse = {
  users: User[];
  total: number;
  skip: number;
  limit: number;
};

export async function getUsers(country: string, lang: string): Promise<UsersResponse> {
  "use cache: remote";
  cacheLife("hours");
  cacheTag("users", `users-${country}-${lang}`);

  const res = await fetch(
    "https://dummyjson.com/users?limit=8&select=firstName,lastName,email,company,image",
    { next: { revalidate: 3600 } },
  );

  if (!res.ok) {
    throw new Error(`Failed to fetch users: ${res.status}`);
  }

  return res.json();
}
