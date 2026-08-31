FROM node:24-alpine

LABEL summary="Server-side reverse proxy (rproxy) — universal HTTP + WebSocket proxy"

ENV NODE_ENV=production
# Coolify routes its assigned domain (with Let's Encrypt HTTPS) to this port.
ENV PORT=8080

WORKDIR /app

RUN npm install --global corepack@latest

COPY package.json pnpm-lock.yaml ./
RUN corepack enable && corepack install
# Only production deps (skips playwright/eslint/prettier devDependencies).
RUN pnpm install --prod --frozen-lockfile

COPY . /app

EXPOSE 8080

# Server-side reverse proxy. To run the original Ultraviolet app instead,
# override the command with: node src/index.js
CMD ["node", "src/rproxy.js"]

