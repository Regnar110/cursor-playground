# Obraz testow obciazeniowych: grafana/k6 + scenariusze wbudowane w obraz.
#   docker build -t tme-next-k6test:local apps/tmeNext-K6Test
# Uruchamianie (przez compose, w sieci z instancjami tme-next):
#   docker compose run --rm k6 run /scenarios/cache-load.js
FROM grafana/k6:latest
COPY scenarios /scenarios
WORKDIR /scenarios
