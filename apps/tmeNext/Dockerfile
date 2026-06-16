# Budowane z KONTEKSTEM = root monorepo:
#   docker build -f apps/tmeNext/Dockerfile -t tme-next:local .
# (docker-compose.yml robi to automatycznie)

FROM node:22-alpine AS deps
WORKDIR /repo
COPY package.json package-lock.json nx.json ./
COPY apps/tmeNext/package.json apps/tmeNext/package.json
COPY packages/cache-handler/package.json packages/cache-handler/package.json
RUN npm ci

FROM node:22-alpine AS build
WORKDIR /repo
ENV NX_DAEMON=false \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /repo/node_modules ./node_modules
COPY package.json package-lock.json nx.json ./
COPY packages/cache-handler ./packages/cache-handler
COPY apps/tmeNext ./apps/tmeNext
RUN npm run build -w @tme/cache-handler && npx nx build tmeNext

FROM node:22-alpine AS runner
WORKDIR /repo
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
COPY --from=build /repo/apps/tmeNext/.next/standalone ./
COPY --from=build /repo/apps/tmeNext/.next/static ./apps/tmeNext/.next/static
COPY --from=build /repo/apps/tmeNext/public ./apps/tmeNext/public
EXPOSE 3000
CMD ["node", "apps/tmeNext/server.js"]
