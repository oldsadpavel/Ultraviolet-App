# Deploying the server-side proxy to Coolify

This repo's `Dockerfile` builds and runs the **server-side reverse proxy**
(`src/rproxy.js`) — a universal HTTP + WebSocket proxy with a shared cookie jar.

## Coolify steps

1. **New Resource → Application → Public/Private Git repository**, point it at
   this repo and the branch you push to (e.g. `main`).
2. **Build Pack: `Dockerfile`** (Coolify auto-detects the `Dockerfile`).
3. **Port**: set *Ports Exposes* to `8080` (the container listens on `$PORT`,
   defaulting to `8080`).
4. **Domain**: assign a domain in Coolify. It provisions HTTPS (Let's Encrypt)
   automatically and routes it to the container — **no self-signed cert needed**.
5. **WebSockets**: work out of the box (Coolify's Traefik proxies upgrades).
6. Deploy.

After deploy the proxy is at `https://<your-domain>/`:

- `https://<your-domain>/` — landing page with a URL box
- `https://<your-domain>/go?url=<any-url>` — open any site
- WebSockets are proxied server-side automatically.

## Environment

- `PORT` — listen port (Dockerfile sets `8080`; Coolify can override).
- No other config required.

## What works / known limitation

Works: general sites, cross-subdomain APIs, a **shared server-side cookie jar**,
and **server-side WebSocket proxying** (the browser-side Ultraviolet model can't
attach cookies to a WS handshake; this proxy can).

Known limitation — **DeepL Voice (and apps that hard-redirect to a canonical
host)**: the app runs `location.hostname = "www.deepl.com"` on load. Because the
browser is on the proxy's domain (not `www.deepl.com`), the app redirects itself
off the proxy. The WebSocket and all server-side proxying work, but the meeting
UI bounces to the real host. Neutralizing this requires a full JS-rewriting
engine (what CroxyProxy/Ultraviolet implement) or running the browser under
`--host-resolver-rules` so it believes it is on the real domain. This is a
client-side app behavior and is independent of where the proxy is deployed.

## Run locally

```sh
pnpm install
pnpm start:proxy        # http://localhost:8081
# or the original Ultraviolet app:
pnpm start              # http://localhost:8080
```
