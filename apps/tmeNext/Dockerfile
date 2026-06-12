# Budowane z KONTEKSTEM = root monorepo:
#   docker build -f apps/tmeNext/Dockerfile -t tme-next:local .
# (docker-compose.yml robi to automatycznie)

FROM node:22-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json nx.json ./
COPY apps/tmeNext/package.json apps/tmeNext/package.json
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /repo
ENV NX_DAEMON=false \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /repo/node_modules ./node_modules
COPY package.json package-lock.json nx.json ./
COPY apps/tmeNext ./apps/tmeNext
# Build bez Redisa: handler wykrywa faze build i dziala na samym LRU
RUN npx nx build tmeNext

FROM node:22-alpine AS runner
WORKDIR /repo
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
# output: "standalone" odwzorowuje strukture monorepo wewnatrz .next/standalone
COPY --from=build /repo/apps/tmeNext/.next/standalone ./
COPY --from=build /repo/apps/tmeNext/.next/static ./apps/tmeNext/.next/static
COPY --from=build /repo/apps/tmeNext/public ./apps/tmeNext/public
EXPOSE 3000
CMD ["node", "apps/tmeNext/server.js"]
