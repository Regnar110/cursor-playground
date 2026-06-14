import Link from "next/link";
import { getLabels, type CountryCode, type LangCode } from "@/lib/i18n";
import styles from "./site-nav.module.css";

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
    <nav className={styles.nav}>
      {links.map((link) => (
        <Link key={link.href} href={link.href} className={styles.link}>
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
