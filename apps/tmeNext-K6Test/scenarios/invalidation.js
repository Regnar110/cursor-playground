import http from "k6/http";
import { check, sleep } from "k6";
import { Trend, Rate } from "k6/metrics";
import { instanceUrl, urlForVu } from "./instances.js";

/**
 * Scenariusz: propagacja invalidacji miedzy instancjami pod obciazeniem.
 *
 * - readers: 20 VU czyta /cache-lab na wszystkich instancjach (LRU wszedzie gorace).
 * - invalidator: 1 cykl - invaliduje tagi DATA+UI przez POST /api/loadtest/invalidate
 *   na instancji 2 i mierzy, po jakim czasie instancja 3 serwuje swieze dane.
 *
 * UWAGA - dwie warstwy o roznej semantyce:
 * 1. Handler remote (Redis): invalidacja natychmiastowa i cross-instance
 *    (wpisy skasowane, Pub/Sub czysci LRU na kazdej instancji).
 * 2. Full route cache (ISR, s-maxage=60 + SWR): kazda instancja serwuje zbuforowany
 *    HTML do uplywu `revalidate` strony (cache-lab: 1 min). Dopiero re-render route'a
 *    pobiera swieze dane z Redis.
 * Stad oczekiwana propagacja END-TO-END: do ~65 s (revalidate + 1 zadanie).
 *
 * Uruchomienie:  nx run tmeNext-K6Test:invalidation
 */
const LOCALE = __ENV.LOCALE || "de/fr";
const TAGS = [
  `data:cache-lab:${LOCALE.replace("/", ":")}`,
  `ui:cache-lab:${LOCALE.replace("/", ":")}`,
];

const propagation = new Trend("invalidation_propagation_ms", true);
const propagationFailed = new Rate("invalidation_timeout");

export const options = {
  scenarios: {
    readers: {
      executor: "constant-vus",
      vus: 20,
      duration: "100s",
      exec: "reader",
    },
    invalidator: {
      executor: "per-vu-iterations",
      vus: 1,
      iterations: 1,
      maxDuration: "110s",
      exec: "invalidator",
    },
  },
  thresholds: {
    http_req_failed: ["rate<0.02"],
    invalidation_timeout: ["rate==0"],
    // revalidate strony = 60 s + margines na re-render
    invalidation_propagation_ms: ["p(95)<75000"],
  },
};

function extractDataTs(body) {
  const m = body && body.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  return m ? m[0] : null;
}

export function reader() {
  const res = http.get(`${urlForVu(__VU)}/${LOCALE}/cache-lab`);
  check(res, { "reader 200": (r) => r.status === 200 });
  sleep(0.2);
}

export function invalidator() {
  sleep(5);

  // Stan przed invalidacja - timestamp danych z instancji 1
  const before = http.get(`${instanceUrl(1)}/${LOCALE}/cache-lab`);
  const tsBefore = extractDataTs(before.body);

  // Invalidacja na instancji 2
  const t0 = Date.now();
  const inv = http.post(
    `${instanceUrl(2)}/api/loadtest/invalidate`,
    JSON.stringify({ tags: TAGS }),
    { headers: { "Content-Type": "application/json" } },
  );
  check(inv, { "invalidate 200": (r) => r.status === 200 });

  // Pomiar propagacji na instancji 3 (innej niz invalidator i baseline)
  for (let i = 0; i < 90; i++) {
    const res = http.get(`${instanceUrl(3)}/${LOCALE}/cache-lab`);
    const ts = extractDataTs(res.body);
    if (ts && ts !== tsBefore) {
      const ms = Date.now() - t0;
      propagation.add(ms);
      propagationFailed.add(false);
      console.log(`PROPAGATION_MS:${ms}`);
      return;
    }
    sleep(1);
  }
  propagationFailed.add(true);
}
