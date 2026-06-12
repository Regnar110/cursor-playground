import { cacheLife, cacheTag } from "next/cache";
import { uiTag } from "@/lib/cache-tags";
import { getLabels, type LangCode } from "@/lib/i18n";
import { getPosts } from "@/lib/data/posts";

type Props = {
  country: string;
  lang: LangCode;
};

export async function CachedPostsList({ country, lang }: Props) {
  "use cache: remote";
  cacheLife("hours");
  cacheTag(uiTag("posts", country, lang));

  const labels = getLabels(lang);
  const data = await getPosts(country, lang);

  return (
    <ul className="grid gap-4">
      {data.posts.map((post) => (
        <li
          key={post.id}
          className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
        >
          <h3 className="text-lg font-semibold text-zinc-900 dark:text-zinc-50">{post.title}</h3>
          <p className="mt-2 line-clamp-3 text-sm text-zinc-600 dark:text-zinc-400">{post.body}</p>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-zinc-500">
            <span>
              {labels.author}: #{post.userId}
            </span>
            <span>👍 {post.reactions.likes}</span>
            <span>👎 {post.reactions.dislikes}</span>
          </div>
        </li>
      ))}
    </ul>
  );
}
