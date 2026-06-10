import Image from "next/image";
import { cacheLife, cacheTag } from "next/cache";
import { getLabels, type LangCode } from "@/lib/i18n";
import { getProducts } from "@/lib/data/products";

type Props = {
  country: string;
  lang: LangCode;
};

export async function CachedProductsGrid({ country, lang }: Props) {
  "use cache: remote";
  cacheLife("hours");
  cacheTag("products-ui", `products-ui-${country}-${lang}`);

  const labels = getLabels(lang);
  const data = await getProducts(country, lang);

  return (
    <ul className="grid gap-4 sm:grid-cols-2">
      {data.products.map((product) => (
        <li
          key={product.id}
          className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-900"
        >
          <Image
            src={product.thumbnail}
            alt={product.title}
            width={400}
            height={200}
            className="h-40 w-full object-cover"
          />
          <div className="p-4">
            <h3 className="font-semibold text-zinc-900 dark:text-zinc-50">{product.title}</h3>
            <p className="mt-1 line-clamp-2 text-sm text-zinc-600 dark:text-zinc-400">
              {product.description}
            </p>
            <div className="mt-3 flex justify-between text-sm text-zinc-500">
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
