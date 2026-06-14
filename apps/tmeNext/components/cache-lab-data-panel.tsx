import { dataTag } from "@/lib/cache-tags";
import type { CacheLabData } from "@/lib/data/cache-lab";
import styles from "./cache-lab-data-panel.module.css";

type Props = {
  data: CacheLabData;
  country: string;
  lang: string;
};

export function CacheLabDataPanel({ data, country, lang }: Props) {
  const dataTagValue = dataTag("cache-lab", country, lang);

  return (
    <div className={styles.panel}>
      <div className={styles.header}>
        <span className={styles.badge}>WARSTWA DATA</span>
        <span className={styles.meta}>
          tag: {dataTagValue} · getCacheLabData()
        </span>
      </div>

      <p className={styles.quote}>
        <strong>Cytat:</strong> {data.quote}
      </p>
      <p className={styles.author}>— {data.author}</p>

      <dl className={styles.grid}>
        <div className={styles.cell}>
          <dt className={styles.cellLabel}>Dane pobrane</dt>
          <dd className={styles.cellValue}>{data.dataFetchedAt}</dd>
        </div>
        <div className={styles.cell}>
          <dt className={styles.cellLabel}>Instancja DATA (pid)</dt>
          <dd className={styles.cellValue}>{data.dataInstance}</dd>
        </div>
        <div className={styles.cell}>
          <dt className={styles.cellLabel}>cacheLife profil</dt>
          <dd className={styles.cellValue}>{data.cacheProfile}</dd>
        </div>
      </dl>
    </div>
  );
}
