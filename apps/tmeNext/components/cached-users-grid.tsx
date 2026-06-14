import Image from "next/image";
import { cacheLife, cacheTag } from "next/cache";
import { uiTag } from "@/lib/cache-tags";
import { getLabels, type LangCode } from "@/lib/i18n";
import { getUsers } from "@/lib/data/users";
import styles from "./cached-users-grid.module.css";

type Props = {
  country: string;
  lang: LangCode;
};

export async function CachedUsersGrid({ country, lang }: Props) {
  "use cache: remote";
  cacheLife("hours");
  cacheTag(uiTag("users", country, lang));

  const labels = getLabels(lang);
  const data = await getUsers(country, lang);

  return (
    <ul className={styles.list}>
      {data.users.map((user) => (
        <li key={user.id} className={styles.item}>
          <Image
            src={user.image}
            alt={`${user.firstName} ${user.lastName}`}
            width={64}
            height={64}
            className={styles.avatar}
          />
          <div>
            <h3 className={styles.name}>
              {user.firstName} {user.lastName}
            </h3>
            <p className={styles.email}>
              {labels.email}: {user.email}
            </p>
            <p className={styles.company}>
              {labels.company}: {user.company.name}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
