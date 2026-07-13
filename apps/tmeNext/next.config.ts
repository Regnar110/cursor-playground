import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Wymagane dla obrazu Docker: minimalny serwer + przesledzone zaleznosci
  output: "standalone",
  cacheComponents: true,
  // Handler dla wpisow `use cache: remote` (L1 LRU + Redis + Pub/Sub)
  cacheHandlers: {
    remote: require.resolve("@tme/cache-handler"),
  },
  // Handler dla full route cache / ISR / fetch cache - wspoldzielony przez Redis,
  // zeby wszystkie instancje serwowaly ten sam snapshot HTML
  cacheHandler: require.resolve("@tme/cache-handler/isr"),
  // Bez lokalnego cache w pamieci - jedynym zrodlem prawdy dla ISR jest Redis
  cacheMaxMemorySize: 0,
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "cdn.dummyjson.com",
        pathname: "/**",
      },
      {
        protocol: "https",
        hostname: "dummyjson.com",
        pathname: "/**",
      },
    ],
  },
};

export default nextConfig;
