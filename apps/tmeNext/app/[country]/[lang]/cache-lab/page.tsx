import { Suspense } from "react";
import { notFound } from "next/navigation";
import { CacheBadge } from "@/components/cache-badge";
import { CacheLabControls } from "@/components/cache-lab-controls";
import { CacheLabDataPanel } from "@/components/cache-lab-data-panel";
import { CacheLabUiPanel } from "@/components/cache-lab-ui-panel";
import { dataTag, uiTag } from "@/lib/cache-tags";
import { getCacheLabData } from "@/lib/data/cache-lab";
import { getLabels, isValidCountry, isValidLang, type LangCode } from "@/lib/i18n";
import shared from "@/styles/shared.module.css";

type Props = {
  params: Promise<{ country: string; lang: string }>;
};

function PanelSkeleton() {
  return <div className={shared.skeletonPanel} />;
}

export default async function CacheLabPage({ params }: Props) {
  const { country, lang } = await params;

  if (!isValidCountry(country) || !isValidLang(lang)) {
    notFound();
  }

  const labels = getLabels(lang as LangCode);
  const cachedData = await getCacheLabData(country, lang);
  const dataTagValue = dataTag("cache-lab", country, lang);
  const uiTagValue = uiTag("cache-lab", country, lang);

  return (
    <section className={shared.sectionLg}>
      <div className={shared.introBlock}>
        <div className={shared.introTitleRow}>
          <h2 className={shared.pageTitle}>{labels.cacheLab}</h2>
          <CacheBadge label="LRU → Redis + Pub/Sub" />
        </div>
        <p className={shared.introText}>
          Produkcja: jeden tag 1:1 per wpis cache — warstwa (
          <code className={shared.inlineCode}>data:</code> /{" "}
          <code className={shared.inlineCode}>ui:</code>), zasób i locale (np.{" "}
          <code className={shared.inlineCode}>{dataTagValue}</code>).
        </p>
      </div>

      <div className={shared.panelGrid}>
        <CacheLabDataPanel data={cachedData} country={country} lang={lang} />
        <Suspense fallback={<PanelSkeleton />}>
          <CacheLabUiPanel country={country} lang={lang as LangCode} />
        </Suspense>
      </div>

      <div className={shared.infoBox}>
        <h3 className={shared.infoBoxTitle}>Konwencja tagów</h3>
        <ul className={shared.infoList}>
          <li>
            DATA: <code className={shared.inlineCode}>{dataTagValue}</code>
          </li>
          <li>
            UI: <code className={shared.inlineCode}>{uiTagValue}</code>
          </li>
        </ul>
        <h3 className={shared.infoBoxTitleSpaced}>Redis Insight</h3>
        <ul className={shared.infoListSpaced}>
          <li>
            Wpis cache = cacheKey Next.js z <code className={shared.inlineCode}>:</code> →{" "}
            <code className={shared.inlineCode}>;</code> (JSON ze{" "}
            <code className={shared.inlineCode}>:</code> rozbijałby drzewo); pole{" "}
            <code className={shared.inlineCode}>_meta</code> w payloadzie v8
          </li>
          <li>
            <code className={shared.inlineCode}>index:data:posts:pl:pl</code> /{" "}
            <code className={shared.inlineCode}>index:ui:posts:pl:pl</code> — SET; member = ten sam
            string co klucz wpisu (drzewo{" "}
            <code className={shared.inlineCode}>index:data</code> /{" "}
            <code className={shared.inlineCode}>index:ui</code>)
          </li>
          <li>
            <code className={shared.inlineCode}>meta:revalidated-at:…</code> — timestamp invalidacji,
            nie treść cache
          </li>
        </ul>
      </div>

      <CacheLabControls country={country} lang={lang as LangCode} />
    </section>
  );
}
