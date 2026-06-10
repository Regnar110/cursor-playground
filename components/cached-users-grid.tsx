import Image from "next/image";
import { cacheLife, cacheTag } from "next/cache";
import { getLabels, type LangCode } from "@/lib/i18n";
import { getUsers } from "@/lib/data/users";

type Props = {
  country: string;
  lang: LangCode;
};

export async function CachedUsersGrid({ country, lang }: Props) {
  "use cache: remote";
  cacheLife("hours");
  cacheTag("users-ui", `users-ui-${country}-${lang}`);

  const labels = getLabels(lang);
  const data = await getUsers(country, lang);

  return (
    <ul className="grid gap-4 sm:grid-cols-2">
      {data.users.map((user) => (
        <li
          key={user.id}
          className="flex gap-4 rounded-xl border border-zinc-200 bg-white p-4 shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
        >
          <Image
            src={user.image}
            alt={`${user.firstName} ${user.lastName}`}
            width={64}
            height={64}
            className="h-16 w-16 rounded-full object-cover"
          />
          <div>
            <h3 className="font-semibold text-zinc-900 dark:text-zinc-50">
              {user.firstName} {user.lastName}
            </h3>
            <p className="text-sm text-zinc-600 dark:text-zinc-400">
              {labels.email}: {user.email}
            </p>
            <p className="text-sm text-zinc-500">
              {labels.company}: {user.company.name}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
