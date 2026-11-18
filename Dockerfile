# syntax=docker/dockerfile:1

FROM node:26-slim AS build
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.base.json tsconfig.web.json ./
COPY web ./web
COPY src ./src

RUN npm run build:web
RUN npm prune --omit=dev

FROM node:26-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build --chown=node:node /app/package.json ./package.json
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/web/dist ./web/dist
COPY --chown=node:node migrations ./migrations

USER node
EXPOSE 4747
CMD ["node", "src/composition/server.ts"]
