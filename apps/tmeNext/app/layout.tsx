import type { Metadata } from "next";
import { Geist } from "next/font/google";
import "./globals.css";
import styles from "./layout.module.css";

const geistSans = Geist({
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Next.js Cache Playground",
  description: "Edukacyjny playground Next.js 16 z use cache: remote i Redis",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.className} ${styles.html}`}>
      <body className={styles.body}>{children}</body>
    </html>
  );
}
