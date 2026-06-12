import http from "k6/http";
import { check } from "k6";
import { Rate, Trend } from "k6/metrics";
import { urlForVu } from "./instances.js";

/**
 * Scenariusz: ogolne obciazenie cache na wszystkich instancjach tmeNext.
 *
 * Kazdy VU trafia w "swoja" instancje (symulacja ruchu za load balancerem).
 * Mix lokali i podstron: czesc trafia w gorace LRU (L1), czesc w Redis (L2),
 * czesc w zimny cache (render + zapis).
 *
 * Uruchomienie:  nx run tmeNext-K6Test:load
 */
const LOCALES = ["pl/pl", "us/en", "de/fr", "fr/de", "es/es", "it/it", "gb/en", "jp/ja"];
const PAGES = ["", "/posts", "/users", "/products", "/cache-lab"];

const errorRate = new Rate("app_errors");
const ttfb = new Trend("app_ttfb", true);

export const options = {
  scenarios: {
    load: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: 40 },
        { duration: "45s", target: 40 },
        { duration: "5s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    http_req_duration: ["p(95)<1500"],
  },
};

export default function () {
  const locale = LOCALES[Math.floor(Math.random() * LOCALES.length)];
  const page = PAGES[Math.floor(Math.random() * PAGES.length)];

  const res = http.get(`${urlForVu(__VU)}/${locale}${page}`, {
    tags: { page: page || "home" },
  });

  const ok = check(res, { "status 200": (r) => r.status === 200 });
  errorRate.add(!ok);
  ttfb.add(res.timings.waiting);
}
