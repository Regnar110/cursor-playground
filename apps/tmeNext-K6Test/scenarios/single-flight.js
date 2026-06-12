import http from "k6/http";
import { check } from "k6";
import { urlForVu } from "./instances.js";

/**
 * Scenariusz: single-flight / thundering herd.
 *
 * 80 VU naraz uderza w JEDEN zimny URL rozlozony na wszystkie instancje.
 * Oczekiwanie: dane wyrenderowala dokladnie JEDNA instancja (lock w Redis),
 * reszta odczytala wynik z Redis.
 *
 * Weryfikacja: kazda odpowiedz loguje "DATA_TS:<timestamp>" (czas pobrania danych
 * z panelu DATA). Po tescie policz unikalne wartosci - oczekiwana liczba: 1.
 *   nx run tmeNext-K6Test:single-flight 2>&1 | Select-String "DATA_TS:" | Sort-Object -Unique
 *
 * TARGET powinien byc lokalem, ktorego nikt wczesniej nie odwiedzil (zimny cache),
 * np. ca/hi, br/th, jp/ko. Kolejny przebieg = inny TARGET albo FLUSHDB w Redis:
 *   docker compose exec redis redis-cli FLUSHDB
 */
const TARGET = __ENV.TARGET || "ca/hi/cache-lab";

export const options = {
  scenarios: {
    burst: {
      executor: "shared-iterations",
      vus: 80,
      iterations: 240,
      maxDuration: "90s",
    },
  },
  thresholds: {
    checks: ["rate>0.99"],
  },
};

export default function () {
  const res = http.get(`${urlForVu(__VU)}/${TARGET}`);

  check(res, { "status 200": (r) => r.status === 200 });

  // Pierwszy ISO timestamp w HTML = panel DATA "Dane pobrane".
  // Unikalnych wartosci powinno byc 1 - dowod, ze DATA renderowala sie raz.
  const ts = res.body && res.body.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/);
  if (ts) {
    console.log(`DATA_TS:${ts[0]}`);
  }
}
