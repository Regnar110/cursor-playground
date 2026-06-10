import { notFound } from "next/navigation";
import { SiteNav } from "@/components/site-nav";
import {
  COUNTRIES,
  LANGUAGES,
  getCountry,
  getLabels,
  getLanguage,
  isValidCountry,
  isValidLang,
  type CountryCode,
  type LangCode,
} from "@/lib/i18n";

type Props = {
  children: React.ReactNode;
  params: Promise<{ country: string; lang: string }>;
};

export async function generateStaticParams() {
  return COUNTRIES.flatMap((country) =>
    LANGUAGES.map((lang) => ({
      country: country.code,
      lang: lang.code,
    })),
  );
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
    <div className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-8 px-4 py-10">
      <header className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
              Next.js 16.2 · cacheComponents · use cache: remote
            </p>
            <h1 className="mt-1 text-3xl font-bold tracking-tight">{labels.playground}</h1>
            <p className="mt-2 max-w-2xl text-sm text-zinc-600 dark:text-zinc-400">
              {labels.cacheInfo}
            </p>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm dark:border-zinc-800 dark:bg-zinc-900">
            <p>
              {countryData.flag} {countryData.name}
            </p>
            <p className="text-zinc-500">{langData.name}</p>
          </div>
        </div>
        <SiteNav country={country as CountryCode} lang={lang as LangCode} />
      </header>
      <main>{children}</main>
    </div>
  );
}
