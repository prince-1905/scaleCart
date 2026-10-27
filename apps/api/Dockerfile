# syntax=docker/dockerfile:1

# ---- build: compile TypeScript, then drop dev dependencies ----
FROM node:24.22.1-trixie-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json nest-cli.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

# ---- runtime: only compiled JS + production node_modules, running as non-root ----
FROM node:24.22.1-trixie-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /app/package.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
USER node
EXPOSE 3000
# Exec form so Node is PID 1 and receives SIGTERM directly (needed for graceful shutdown).
CMD ["node", "dist/main.js"]
