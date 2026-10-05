FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

FROM node:22-alpine
ARG GIT_SHA=unknown
ENV GIT_SHA=$GIT_SHA \
    NODE_ENV=production \
    STATE_PATH=/data/state.json \
    SYNC_INTERVAL_MINUTES=60
WORKDIR /app
COPY --from=build /app/dist ./dist
COPY package.json ./
RUN mkdir /data && chown node:node /data
USER node
VOLUME /data
# Unhealthy when no sync has succeeded within two intervals (see src/monitor.ts).
HEALTHCHECK --interval=5m --timeout=10s --start-period=5m --retries=1 CMD ["node", "dist/healthcheck.js"]
ENTRYPOINT ["node", "dist/cli.js"]
