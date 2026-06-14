import { CacheBadge } from "@/components/cache-badge";
import { getLabels, isValidCountry, isValidLang, type LangCode } from "@/lib/i18n";
import { notFound } from "next/navigation";
import shared from "@/styles/shared.module.css";

type Props = {
  params: Promise<{ country: string; lang: string }>;
};

export default async function LocaleHomePage({ params }: Props) {
  const { country, lang } = await params;

  if (!isValidCountry(country) || !isValidLang(lang)) {
    notFound();
  }

  const labels = getLabels(lang as LangCode);

  return (
    <section className={shared.cardSection}>
      <div className={shared.introTitleRow}>
        <h2 className={shared.pageTitle}>{labels.home}</h2>
        <CacheBadge label="use cache: remote" />
      </div>
      <p className={shared.introText}>
        Ten playground demonstruje routing{" "}
        <code className={shared.inlineCode}>/{country}/{lang}</code> z 10 krajami i 30 językami.
        Każda podstrona pobiera dane z DummyJSON i cache&apos;uje zarówno funkcje danych, jak i
        komponenty UI przez Redis z warstwą LRU.
      </p>
      <dl className={shared.infoGrid}>
        <div className={shared.statBox}>
          <dt className={shared.statLabel}>Warstwa L1</dt>
          <dd className={shared.statValue}>LRU (in-process)</dd>
        </div>
        <div className={shared.statBox}>
          <dt className={shared.statLabel}>Warstwa L2</dt>
          <dd className={shared.statValue}>Redis (remote handler)</dd>
        </div>
        <div className={shared.statBox}>
          <dt className={shared.statLabel}>Dyrektywa</dt>
          <dd className={shared.statValueMono}>use cache: remote</dd>
        </div>
      </dl>
    </section>
  );
}
