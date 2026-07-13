import Image from "next/image";
import { cacheLife, cacheTag, revalidatePath, revalidateTag, updateTag } from "next/cache";
import { Suspense } from "react";
import { notFound } from "next/navigation";
import { ActionButton } from "@/components/action-button";
import { CacheBadge } from "@/components/cache-badge";
import { uiTag } from "@/lib/cache-tags";
import { isValidCountry, isValidLang } from "@/lib/i18n";
import shared from "@/styles/shared.module.css";

type Props = {
  params: Promise<{ country: string; lang: string }>;
};

interface DummyProduct {
  id: number;
  price: number;
  thumbnail: string;
  title: string;
}

const getRandomProducts = async (): Promise<DummyProduct[]> => {
  const randomSkip = Math.floor(Math.random() * 90);
  const res = await fetch(`https://dummyjson.com/products?limit=3&skip=${randomSkip}`);
  const data = await res.json();
  return data.products;
};

const CachedProducts = async () => {
  "use cache: remote";
  cacheLife("hours");
  cacheTag(uiTag("products"));
  const products = await getRandomProducts();
  const fetchedAt = new Date().toISOString();

  return (
    <>
      <div style={{ color: "#858585", fontFamily: "monospace" }}>
        {`products fetched at › ${fetchedAt}`}
      </div>
      <div style={{ display: "flex", gap: "12px", marginBottom: "16px" }}>
        {products.map((product) => (
          <div
            key={product.id}
            style={{ border: "1px solid #333", borderRadius: "6px", padding: "12px", width: "160px" }}
          >
            <Image
              alt={product.title}
              src={product.thumbnail}
              width={136}
              height={136}
              style={{ borderRadius: "4px", height: "auto", width: "100%" }}
            />
            <div style={{ fontSize: "13px", marginTop: "8px" }}>{product.title}</div>
            <div style={{ color: "#4ec9b0", fontWeight: "bold" }}>{`$${product.price}`}</div>
          </div>
        ))}
      </div>
    </>
  );
};

const NewsPageShell = async ({ country, lang }: { country: string; lang: string }) => {
  "use cache: remote";
  cacheLife("minutes");
  cacheTag(uiTag("news", country, lang));

  const renderedAt = new Date().toISOString();

  return (
    <div
      style={{
        background: "#1e1e1e",
        borderRadius: "6px",
        color: "#4ec9b0",
        fontFamily: "monospace",
        marginBottom: "16px",
        padding: "12px",
      }}
    >
      <span style={{ color: "#858585" }}>{"page rendered at › "}</span>
      {renderedAt}
    </div>
  );
};

export default async function NewsPage({ params }: Props) {
  const { country, lang } = await params;

  if (!isValidCountry(country) || !isValidLang(lang)) {
    notFound();
  }

  const newsTagValue = uiTag("news", country, lang);
  const productsTagValue = uiTag("products");

  const revalidateNewsPath = async () => {
    "use server";
    revalidatePath("/[country]/[lang]/news", "page");
  };

  const updateNewsTag = async () => {
    "use server";
    updateTag(uiTag("news", country, lang));
  };

  const revalidateNewsTag = async () => {
    "use server";
    revalidateTag(uiTag("news", country, lang), "max");
  };

  const updateProductsTag = async () => {
    "use server";
    updateTag(uiTag("products"));
  };

  const revalidateProductsTag = async () => {
    "use server";
    revalidateTag(uiTag("products"), "max");
  };

  return (
    <section className={shared.section}>
      <div className={shared.pageHeader}>
        <div className={shared.pageHeaderLeft}>
          <h2 className={shared.pageTitle}>News</h2>
          <CacheBadge label="remote cache: UI" />
        </div>
      </div>
      <NewsPageShell country={country} lang={lang} />
      <Suspense fallback={<span>{"Loading..."}</span>}>
        <CachedProducts />
      </Suspense>
      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
        <ActionButton label="revalidatePath /news" action={revalidateNewsPath} />
        <ActionButton label={`updateTag ${newsTagValue}`} action={updateNewsTag} />
        <ActionButton label={`revalidateTag ${newsTagValue}`} action={revalidateNewsTag} />
        <ActionButton label={`updateTag ${productsTagValue}`} action={updateProductsTag} />
        <ActionButton label={`revalidateTag ${productsTagValue}`} action={revalidateProductsTag} />
      </div>
    </section>
  );
}
