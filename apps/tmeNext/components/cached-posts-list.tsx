import { cacheLife, cacheTag } from "next/cache";
import { uiTag } from "@/lib/cache-tags";
import { getLabels, type LangCode } from "@/lib/i18n";
import { getPosts } from "@/lib/data/posts";
import styles from "./cached-posts-list.module.css";

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
    <ul className={styles.list}>
      {data.posts.map((post) => (
        <li key={post.id} className={styles.item}>
          <h3 className={styles.title}>{post.title}</h3>
          <p className={styles.body}>{post.body}</p>
          <div className={styles.meta}>
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
