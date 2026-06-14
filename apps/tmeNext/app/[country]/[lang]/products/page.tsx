import { Suspense } from "react";
import { notFound } from "next/navigation";
import { CacheBadge } from "@/components/cache-badge";
import { CachedProductsGrid } from "@/components/cached-products-grid";
import { RevalidateButton } from "@/components/revalidate-button";
import { getLabels, isValidCountry, isValidLang, type LangCode } from "@/lib/i18n";
import shared from "@/styles/shared.module.css";

type Props = {
  params: Promise<{ country: string; lang: string }>;
};

function ProductsSkeleton() {
  return (
    <div className={shared.skeletonGrid2}>
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className={shared.skeletonProduct} />
      ))}
    </div>
  );
}

export default async function ProductsPage({ params }: Props) {
  const { country, lang } = await params;

  if (!isValidCountry(country) || !isValidLang(lang)) {
    notFound();
  }

  const labels = getLabels(lang as LangCode);

  return (
    <section className={shared.section}>
      <div className={shared.pageHeader}>
        <div className={shared.pageHeaderLeft}>
          <h2 className={shared.pageTitle}>{labels.products}</h2>
          <CacheBadge label="remote cache: data + UI" />
        </div>
        <RevalidateButton
          label={labels.revalidate}
          resource="products"
          country={country}
          lang={lang}
        />
      </div>
      <p className={shared.mutedSm}>{labels.fromApi}</p>
      <Suspense fallback={<ProductsSkeleton />}>
        <CachedProductsGrid country={country} lang={lang as LangCode} />
      </Suspense>
    </section>
  );
}
