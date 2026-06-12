import { Suspense } from "react";
import { notFound } from "next/navigation";
import { CacheBadge } from "@/components/cache-badge";
import { CachedProductsGrid } from "@/components/cached-products-grid";
import { RevalidateButton } from "@/components/revalidate-button";
import { getLabels, isValidCountry, isValidLang, type LangCode } from "@/lib/i18n";

type Props = {
  params: Promise<{ country: string; lang: string }>;
};

function ProductsSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {Array.from({ length: 4 }).map((_, i) => (
        <div key={i} className="h-56 animate-pulse rounded-xl bg-zinc-200 dark:bg-zinc-800" />
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
    <section className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="flex flex-wrap items-center gap-3">
          <h2 className="text-2xl font-semibold">{labels.products}</h2>
          <CacheBadge label="remote cache: data + UI" />
        </div>
        <RevalidateButton
          label={labels.revalidate}
          resource="products"
          country={country}
          lang={lang}
        />
      </div>
      <p className="text-sm text-zinc-500">{labels.fromApi}</p>
      <Suspense fallback={<ProductsSkeleton />}>
        <CachedProductsGrid country={country} lang={lang as LangCode} />
      </Suspense>
    </section>
  );
}
