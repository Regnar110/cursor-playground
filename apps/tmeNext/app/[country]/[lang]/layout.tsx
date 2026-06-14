import { notFound } from "next/navigation";
import { SiteNav } from "@/components/site-nav";
import {
  getCountry,
  getLabels,
  getLanguage,
  isValidCountry,
  isValidLang,
  STATIC_LOCALE_PARAMS,
  type CountryCode,
  type LangCode,
} from "@/lib/i18n";
import styles from "./layout.module.css";

type Props = {
  children: React.ReactNode;
  params: Promise<{ country: string; lang: string }>;
};

export function generateStaticParams() {
  return STATIC_LOCALE_PARAMS;
}

export default async function LocaleLayout({ children, params }: Props) {
  const { country, lang } = await params;

  if (!isValidCountry(country) || !isValidLang(lang)) {
    notFound();
  }

  const countryData = getCountry(country as CountryCode);
  const langData = getLanguage(lang as LangCode);
  const labels = getLabels(lang as LangCode);

  return (
    <div className={styles.shell}>
      <header className={styles.header}>
        <div className={styles.headerRow}>
          <div>
            <p className={styles.eyebrow}>Next.js 16.2 · cacheComponents · use cache: remote</p>
            <h1 className={styles.title}>{labels.playground}</h1>
            <p className={styles.subtitle}>{labels.cacheInfo}</p>
          </div>
          <div className={styles.localeCard}>
            <p>
              {countryData.flag} {countryData.name}
            </p>
            <p className={styles.localeLang}>{langData.name}</p>
          </div>
        </div>
        <SiteNav country={country as CountryCode} lang={lang as LangCode} />
      </header>
      <main className={styles.main}>{children}</main>
    </div>
  );
}
