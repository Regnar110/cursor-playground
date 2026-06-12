/**
 * Adresowanie instancji tmeNext z wnetrza kontenera k6.
 *
 * W sieci docker-compose instancje to serwisy tme-next-1 ... tme-next-N,
 * kazdy nasluchuje na 3000. Szablon hosta i liczbe instancji mozna nadpisac:
 *   INSTANCES=8  HOST_TEMPLATE=tme-next-{i}:3000
 */
export const INSTANCES = Number(__ENV.INSTANCES || 8);

const HOST_TEMPLATE = __ENV.HOST_TEMPLATE || "tme-next-{i}:3000";

/** Bazowy URL instancji o numerze 1..INSTANCES. */
export function instanceUrl(i) {
  const n = ((i - 1) % INSTANCES) + 1;
  return `http://${HOST_TEMPLATE.replace("{i}", String(n))}`;
}

/** Rozklada VU po instancjach (jak ruch za load balancerem). */
export function urlForVu(vu) {
  return instanceUrl(vu);
}
