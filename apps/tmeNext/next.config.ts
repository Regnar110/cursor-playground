import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Wymagane dla obrazu Docker: minimalny serwer + przesledzone zaleznosci
  output: "standalone",
  cacheComponents: true,
  cacheHandlers: {
    remote: require.resolve("@tme/cache-handler"),
  },
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
