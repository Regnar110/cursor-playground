import { Suspense } from "react";
import { CacheDebugPageContent } from "./cache-debug-content";
import styles from "./page.module.css";

type Props = {
  searchParams: Promise<{ token?: string }>;
};

export default function CacheDebugPage({ searchParams }: Props) {
  return (
    <Suspense
      fallback={
        <main className={styles.loading}>Loading cache debug…</main>
      }
    >
      <CacheDebugPageContent searchParams={searchParams} />
    </Suspense>
  );
}
