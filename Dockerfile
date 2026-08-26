# syntax=docker/dockerfile:1

# --- deps: install full (dev+prod) dependencies once, cached by lockfile ---
FROM node:22-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml* ./
RUN yarn install --frozen-lockfile

# --- build: compile TypeScript with tsc ---
FROM node:22-slim AS build
WORKDIR /app
RUN corepack enable
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN yarn build
# The spec sources (src/docs/*.yml, jsdoc comments in src/routes) are not compiled into
# dist/ and are not shipped in the runtime stage below, so swagger-jsdoc cannot assemble
# the spec there. Bake it once here instead; the script fails the build if the result is
# empty. See src/docs/openapiSpec.ts.
RUN node dist/scripts/generateOpenApiSpec.js

# --- prod-deps: install production-only dependencies for the final image ---
FROM node:22-slim AS prod-deps
WORKDIR /app
RUN corepack enable
COPY package.json yarn.lock .yarnrc.yml* ./
RUN yarn install --frozen-lockfile --production

# --- runtime: minimal final image ---
FROM node:22-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app

# Non-root user
RUN groupadd --system --gid 1001 nodejs && useradd --system --uid 1001 --gid nodejs nodejs

COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/openapi.json ./
COPY package.json ./
COPY report_templates ./report_templates
COPY goals ./goals

RUN mkdir -p /app/rag_documents && chown -R nodejs:nodejs /app

USER nodejs

# api-port (PORT) and ws-port (WEBSOCKET_BASE_PORT) — see .env.example.
# Match these if the corresponding env vars are overridden at deploy time.
EXPOSE 3000
EXPOSE 5555

CMD ["node", "dist/src/index.js"]
