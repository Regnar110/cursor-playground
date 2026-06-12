import Link from "next/link";
import { getLabels, type CountryCode, type LangCode } from "@/lib/i18n";

type Props = {
  country: CountryCode;
  lang: LangCode;
};

export function SiteNav({ country, lang }: Props) {
  const labels = getLabels(lang);
  const base = `/${country}/${lang}`;

  const links = [
    { href: base, label: labels.home },
    { href: `${base}/posts`, label: labels.posts },
    { href: `${base}/users`, label: labels.users },
    { href: `${base}/products`, label: labels.products },
    { href: `${base}/cache-lab`, label: labels.cacheLab },
  ];

  return (
    <nav className="flex flex-wrap gap-2">
      {links.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className="rounded-lg border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-800"
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
