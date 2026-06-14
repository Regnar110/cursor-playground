import { cacheLife, cacheTag } from "next/cache";
import { uiTag } from "@/lib/cache-tags";
import { getCacheLabData } from "@/lib/data/cache-lab";
import styles from "./cache-lab-ui-panel.module.css";

type Props = {
  country: string;
  lang: string;
};

export async function CacheLabUiPanel({ country, lang }: Props) {
  "use cache: remote";
  cacheLife("minutes");
  cacheTag(uiTag("cache-lab", country, lang));

  const data = await getCacheLabData(country, lang);
  const uiRenderedAt = new Date().toISOString();

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.badge}>WARSTWA UI</span>
        <span className={styles.meta}>
          tag: {uiTag("cache-lab", country, lang)} · use cache: remote
        </span>
      </div>

      <blockquote className={styles.blockquote}>
        &ldquo;{data.quote}&rdquo;
        <footer className={styles.footer}>— {data.author}</footer>
      </blockquote>

      <dl className={styles.grid}>
        <div className={styles.cell}>
          <dt className={styles.cellLabel}>UI wyrenderowane</dt>
          <dd className={styles.cellValue}>{uiRenderedAt}</dd>
        </div>
        <div className={styles.cell}>
          <dt className={styles.cellLabel}>Instancja UI (pid)</dt>
          <dd className={styles.cellValue}>{`pid-${process.pid}`}</dd>
        </div>
        <div className={styles.cell}>
          <dt className={styles.cellLabel}>Dane z warstwy DATA (wewnątrz UI)</dt>
          <dd className={styles.cellValue}>{data.dataFetchedAt}</dd>
        </div>
        <div className={styles.cell}>
          <dt className={styles.cellLabel}>Instancja DATA (pid)</dt>
          <dd className={styles.cellValue}>{data.dataInstance}</dd>
        </div>
      </dl>
    </div>
  );
}
