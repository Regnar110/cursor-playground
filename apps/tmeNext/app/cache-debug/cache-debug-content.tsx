import { notFound } from "next/navigation";
import { connection } from "next/server";
import { CacheDebugDashboard } from "@/components/cache-debug-dashboard";
import { authorizeDebugToken, isDebugEnabled } from "@/cache-handlers/cache-debug.mjs";
import styles from "./cache-debug-content.module.css";

type Props = {
  searchParams: Promise<{ token?: string }>;
};

export async function CacheDebugPageContent({ searchParams }: Props) {
  await connection();

  if (!isDebugEnabled()) {
    notFound();
  }

  const { token } = await searchParams;
  if (!token || !authorizeDebugToken(token)) {
    notFound();
  }

  return (
    <main className={styles.main}>
      <CacheDebugDashboard token={token} />
    </main>
  );
}
