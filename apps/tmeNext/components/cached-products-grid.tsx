import Image from "next/image";
import { cacheLife, cacheTag } from "next/cache";
import { uiTag } from "@/lib/cache-tags";
import { getLabels, type LangCode } from "@/lib/i18n";
import { getProducts } from "@/lib/data/products";
import styles from "./cached-products-grid.module.css";

type Props = {
  country: string;
  lang: LangCode;
};

export async function CachedProductsGrid({ country, lang }: Props) {
  "use cache: remote";
  cacheLife("hours");
  cacheTag(uiTag("products", country, lang));

  const labels = getLabels(lang);
  const data = await getProducts(country, lang);

  return (
    <ul className={styles.list}>
      {data.products.map((product) => (
        <li key={product.id} className={styles.item}>
          <Image
            src={product.thumbnail}
            alt={product.title}
            width={400}
            height={200}
            className={styles.thumbnail}
          />
          <div className={styles.content}>
            <h3 className={styles.title}>{product.title}</h3>
            <p className={styles.description}>{product.description}</p>
            <div className={styles.footer}>
              <span>
                {labels.price}: ${product.price}
              </span>
              <span>
                {labels.rating}: {product.rating}
              </span>
            </div>
          </div>
        </li>
      ))}
    </ul>
  );
}
