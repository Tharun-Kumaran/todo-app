# syntax=docker/dockerfile:1

# --- Build the frontend -----------------------------------------------------
FROM node:22-bookworm-slim AS build
WORKDIR /app
ENV npm_config_update_notifier=false

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json vite.config.ts index.html ./
COPY src ./src
COPY server ./server
COPY shared ./shared
COPY scripts ./scripts

RUN npm run build

# --- Runtime ---------------------------------------------------------------
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3001 \
    TODO_TIME_MACHINE_FILE=/data/time-machine.json \
    TODO_INVITES_FILE=/data/invites.json

COPY package.json package-lock.json ./
# tsx is a runtime dependency because `npm start` executes TypeScript directly.
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY --from=build /app/server ./server
COPY --from=build /app/shared ./shared
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/tsconfig.json ./tsconfig.json

# JSON stores live outside /app so a volume can be mounted at /data.
RUN mkdir -p /data

EXPOSE 3001

# /api/ready also checks the database, so a broken deploy fails its health check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || 3001) + '/api/ready').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "start"]
