/*
 * Server-side reverse proxy (CroxyProxy-style), universal.
 *
 * Key design: the PROXIED PAGE KEEPS ITS REAL PATHNAME. The active target host
 * is stored in a cookie (__phost), exactly like CroxyProxy. This is essential
 * for SPAs (Next.js/React) that read the meeting id / route from
 * location.pathname — a "/p/<host>/..." path prefix breaks their routing.
 *
 * Routing:
 *   /                          -> landing page (enter any URL)
 *   /go?url=<url>              -> set __phost cookie, redirect to clean <path>
 *   <any path>                 -> proxied to https://<__phost cookie><path>
 *   /__h/<host>/<path>         -> cross-host HTTP (other subdomains/CDNs)
 *   /__w/<host>/<path>?__po=   -> cross-host WebSocket (server-side handshake)
 *
 * All egress is server-side with a shared tough-cookie jar (so HttpOnly auth
 * cookies flow to every subdomain AND to WebSocket handshakes — which the
 * client-side Ultraviolet model could not do).
 */
import { createServer } from "node:http";
import { hostname } from "node:os";
import { Readable } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import { CookieJar } from "tough-cookie";

const jar = new CookieJar();
const PHOST_COOKIE = "__phost";

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const LANDING_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Proxy</title>
<style>
  body{font:16px system-ui,sans-serif;background:#0d1117;color:#e6edf3;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
  .box{width:min(560px,90vw);text-align:center}
  h1{font-weight:600;margin:0 0 8px}
  p{color:#8b949e;margin:0 0 24px}
  form{display:flex;gap:8px}
  input{flex:1;padding:14px 16px;border-radius:10px;border:1px solid #30363d;background:#161b22;color:#e6edf3;font-size:16px}
  button{padding:14px 22px;border-radius:10px;border:0;background:#238636;color:#fff;font-size:16px;cursor:pointer}
  button:hover{background:#2ea043}
</style></head><body><div class="box">
  <h1>Server-side proxy</h1>
  <p>Enter any URL — proxied server-side (HTTP + WebSocket, shared cookie jar).</p>
  <form action="/go" method="get">
    <input name="url" placeholder="https://example.com" autofocus autocomplete="off" spellcheck="false">
    <button type="submit">Go</button>
  </form>
</div></body></html>`;

const STRIP_REQUEST_HEADERS = new Set([
	"host",
	"connection",
	"keep-alive",
	"proxy-connection",
	"transfer-encoding",
	"upgrade",
	"accept-encoding", // identity so we can rewrite text bodies
	"x-forwarded-for",
	"x-forwarded-host",
	"x-forwarded-proto",
	"forwarded",
	"via",
	"cookie", // we attach the server-side jar instead
]);

const STRIP_RESPONSE_HEADERS = new Set([
	"content-security-policy",
	"content-security-policy-report-only",
	"x-frame-options",
	"content-encoding",
	"content-length",
	"transfer-encoding",
	"connection",
	"keep-alive",
	"strict-transport-security",
	"referrer-policy",
	"report-to",
	"nel",
	"set-cookie", // stored server-side in the jar
]);

// Rewrite URLs only in CSS. HTML is NOT rewritten (it corrupts Next.js RSC
// flight data -> empty render); JS/JSON not rewritten (corrupts minified JS).
// The injected client hook handles runtime URLs instead.
const HTML_TYPE = /text\/html/i;
const CSS_TYPE = /text\/css/i;

function getCookie(req, name) {
	const raw = req.headers["cookie"];
	if (!raw) return null;
	for (const part of raw.split(";")) {
		const i = part.indexOf("=");
		if (i === -1) continue;
		if (part.slice(0, i).trim() === name)
			return decodeURIComponent(part.slice(i + 1).trim());
	}
	return null;
}

// ---------------------------------------------------------------------------
// Client hook injected into proxied HTML. Rewrites runtime URLs:
//   same-host absolute  -> root-relative (served via __phost cookie)
//   cross-host absolute -> /__h/<host>/<path>
//   ws/wss              -> /__w/<host>/<path>?__po=<page origin>
// ---------------------------------------------------------------------------
function clientHook(pHost) {
	return `<script>(function(){
  var ORIGIN = location.origin;
  var PHOST = ${JSON.stringify(pHost)};
  function abs(u){
    try{
      u = String(u);
      if(!u || u.startsWith("data:") || u.startsWith("blob:") || u.startsWith("javascript:") || u.startsWith("#") || u.startsWith("mailto:") || u.startsWith("tel:")) return u;
      if(u.startsWith(ORIGIN+"/__h/") || u.startsWith(ORIGIN+"/__w/") || u.startsWith("/__h/") || u.startsWith("/__w/")) return u;
      if(/^wss?:\\/\\//i.test(u)){ var w=new URL(u); var s=location.protocol==="https:"?"wss:":"ws:"; var b=s+"//"+location.host+"/__w/"+w.host+w.pathname+w.search; return b+(w.search?"&":"?")+"__po="+encodeURIComponent("https://"+PHOST); }
      if(/^https?:\\/\\//i.test(u)){ var x=new URL(u); if(x.host===location.host||x.host===PHOST) return x.pathname+x.search+x.hash; return ORIGIN+"/__h/"+x.host+x.pathname+x.search+x.hash; }
      if(u.startsWith("//")){ var p=new URL(location.protocol+u); if(p.host===location.host||p.host===PHOST) return p.pathname+p.search+p.hash; return ORIGIN+"/__h/"+p.host+p.pathname+p.search+p.hash; }
      return u; // root-relative or relative: kept; resolves to ORIGIN -> __phost host
    }catch(e){ return u; }
  }
  var of = window.fetch;
  if(of) window.fetch = function(input, init){
    try{
      if(typeof input === "string"){ input = abs(input); }
      else if(input && input.url){ input = new Request(abs(input.url), input); }
    }catch(e){}
    return of.call(this, input, init);
  };
  var OW = window.WebSocket;
  if(OW){
    var NW = function(u, p){ u = abs(u); return arguments.length>1 ? new OW(u,p) : new OW(u); };
    NW.prototype = OW.prototype;
    NW.CONNECTING=OW.CONNECTING; NW.OPEN=OW.OPEN; NW.CLOSING=OW.CLOSING; NW.CLOSED=OW.CLOSED;
    window.WebSocket = NW;
  }
  var xo = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(m,u){ try{ arguments[1]=abs(u);}catch(e){} return xo.apply(this, arguments); };
  if(navigator.sendBeacon){ var sb = navigator.sendBeacon.bind(navigator); navigator.sendBeacon = function(u,d){ return sb(abs(u), d); }; }
  if(window.EventSource){ var OE=window.EventSource; var NE=function(u,c){ return new OE(abs(u),c); }; NE.prototype=OE.prototype; window.EventSource=NE; }
  // Neutralize canonical-host redirects (app does location.hostname="www.deepl.com",
  // location.assign/replace/href = absolute url). Keep navigation on our origin.
  try{
    var L = window.location;
    try{ var oa=L.assign.bind(L); L.assign=function(u){ return oa(abs(u)); }; }catch(e){}
    try{ var orp=L.replace.bind(L); L.replace=function(u){ return orp(abs(u)); }; }catch(e){}
    // If app sets location.hostname/host/href to the canonical host, re-route.
    try{
      Object.defineProperty(L, "hostname", { configurable:true, get:function(){ return PHOST.split(":")[0]; }, set:function(){ /* ignore canonical-host redirect */ } });
    }catch(e){}
    try{
      Object.defineProperty(L, "host", { configurable:true, get:function(){ return PHOST; }, set:function(){} });
    }catch(e){}
    try{
      var hrefDesc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(L), "href") || Object.getOwnPropertyDescriptor(L, "href");
      var setHref = hrefDesc && hrefDesc.set ? hrefDesc.set.bind(L) : null;
      Object.defineProperty(L, "href", { configurable:true, get:function(){ return (hrefDesc&&hrefDesc.get?hrefDesc.get.call(L):ORIGIN); }, set:function(u){ if(setHref) setHref(abs(u)); } });
    }catch(e){}
  }catch(e){}
  // Spoof origin/host reads so app's "am I on the canonical host?" checks pass.
  try{ Object.defineProperty(document, "domain", { configurable:true, get:function(){ return PHOST.split(":")[0]; }, set:function(){} }); }catch(e){}
})();</script>`;
}

function injectHook(html, pHost) {
	const meta = `<meta name="referrer" content="unsafe-url">`;
	// Hide the DeepL cookie-consent banner (its close button doesn't work
	// through the proxy). CSS hides it; a tiny observer removes it if React
	// re-renders it.
	const style = `<style>[data-testid="dl-cookieBanner"]{display:none!important}</style>`;
	const killBanner = `<script>(function(){function k(){document.querySelectorAll('[data-testid="dl-cookieBanner"]').forEach(function(e){e.remove();});}try{new MutationObserver(k).observe(document.documentElement,{childList:true,subtree:true});}catch(e){}document.addEventListener("DOMContentLoaded",k);})();</script>`;
	const hook = meta + style + clientHook(pHost) + killBanner;
	if (/<head[^>]*>/i.test(html)) {
		return html.replace(/<head[^>]*>/i, (m) => m + hook);
	}
	return hook + html;
}

// Rewrite absolute URLs in CSS to cross-host proxy paths.
function rewriteCss(text, selfOrigin) {
	return text
		.replace(
			/https:\/\/([a-zA-Z0-9.-]+(?::\d+)?)/g,
			`${selfOrigin}/__h/$1`
		)
		.replace(/https:\\\/\\\/([a-zA-Z0-9.-]+(?::\d+)?)/g, `${selfOrigin}/__h/$1`);
}

// Parse "/__h/<host>/<rest>" -> { host, rest }
function parseHostPath(prefix, urlPath) {
	const after = urlPath.slice(prefix.length);
	const slash = after.indexOf("/");
	if (slash === -1) return { host: after, rest: "/" };
	return { host: after.slice(0, slash), rest: after.slice(slash) };
}

// ---------------------------------------------------------------------------
// HTTP proxy handler
// ---------------------------------------------------------------------------
async function handleHttp(req, res) {
	const url = new URL(req.url, "http://localhost");
	const path = url.pathname;

	// Universal entry. `/?url=<url>` or `/go?url=<url>` set the active host
	// cookie and redirect to the clean path. Bare `/` shows the landing page.
	if (path === "/" || path === "" || path === "/go") {
		const raw = url.searchParams.get("url");
		if (!raw) {
			res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			res.end(LANDING_HTML);
			return;
		}
		let u = raw.trim();
		if (!/^[a-z]+:\/\//i.test(u)) u = "https://" + u;
		try {
			const t = new URL(u);
			res.writeHead(302, {
				"set-cookie": `${PHOST_COOKIE}=${encodeURIComponent(
					t.host
				)}; Path=/; SameSite=Lax`,
				location: (t.pathname || "/") + t.search + t.hash,
			});
			res.end();
		} catch {
			res.writeHead(400, { "content-type": "text/plain; charset=utf-8" });
			res.end("bad url: " + u);
		}
		return;
	}

	const destDocument = req.headers["sec-fetch-dest"] === "document";
	let host, rest;
	let rebaseCookie = null;

	if (path.startsWith("/__h/")) {
		({ host, rest } = parseHostPath("/__h/", path));
		// A top-level navigation to a different host: re-base the active host
		// and redirect to the clean path so SPA routing keeps working.
		if (destDocument) {
			res.writeHead(302, {
				"set-cookie": `${PHOST_COOKIE}=${encodeURIComponent(
					host
				)}; Path=/; SameSite=Lax`,
				location: rest + url.search,
			});
			res.end();
			return;
		}
	} else {
		host = getCookie(req, PHOST_COOKIE);
		rest = path;
		if (!host) {
			// No active host yet (e.g. asset loaded before navigation). Fall back
			// to the Referer's path? Without context we can't know — show landing.
			res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
			res.end("No active proxy host. Open via / or /go?url=<url>");
			return;
		}
	}

	const target = "https://" + host + rest + url.search;
	const pageHost = getCookie(req, PHOST_COOKIE) || host;

	const headers = {};
	for (const [k, v] of Object.entries(req.headers)) {
		if (STRIP_REQUEST_HEADERS.has(k.toLowerCase())) continue;
		headers[k] = v;
	}
	headers["user-agent"] = UA;
	headers["accept-encoding"] = "identity";
	// Present requests as coming from the active page origin.
	if (headers["origin"]) headers["origin"] = "https://" + pageHost;
	if (headers["referer"]) headers["referer"] = "https://" + pageHost + "/";

	const cookie = await jar.getCookieString(target).catch(() => "");
	if (cookie) headers["cookie"] = cookie;

	const method = req.method || "GET";
	const hasBody = !["GET", "HEAD"].includes(method);

	let upstream;
	try {
		upstream = await fetch(target, {
			method,
			headers,
			body: hasBody ? Readable.toWeb(req) : undefined,
			duplex: hasBody ? "half" : undefined,
			redirect: "manual",
		});
	} catch (err) {
		res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
		res.end("Upstream fetch failed: " + err.message + "\n" + target);
		return;
	}

	const setCookies = upstream.headers.getSetCookie?.() || [];
	for (const sc of setCookies) {
		try {
			await jar.setCookie(sc, target, { ignoreError: true });
		} catch {
			/* ignore */
		}
	}

	const outHeaders = {};
	for (const [k, v] of upstream.headers.entries()) {
		if (STRIP_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
		outHeaders[k] = v;
	}
	if (rebaseCookie) outHeaders["set-cookie"] = rebaseCookie;

	// Rewrite redirects to stay inside the proxy.
	if (upstream.status >= 300 && upstream.status < 400) {
		const loc = upstream.headers.get("location");
		if (loc) {
			try {
				const a = new URL(loc, target);
				outHeaders["location"] =
					a.host === host
						? a.pathname + a.search + a.hash
						: "/__h/" + a.host + a.pathname + a.search + a.hash;
			} catch {
				/* leave */
			}
		}
		res.writeHead(upstream.status, outHeaders);
		res.end();
		return;
	}

	const ctype = upstream.headers.get("content-type") || "";
	const isHtml = HTML_TYPE.test(ctype);
	const isText =
		isHtml ||
		/text\/css|javascript|application\/json|application\/manifest|text\/plain/i.test(
			ctype
		);
	if (isText) {
		let text = await upstream.text();
		const ourHost = req.headers.host || "";
		// CRITICAL: swap the canonical proxied host -> our host so the app's
		// location.hostname === "<canonical>" check passes (no off-proxy
		// redirect). Done ONLY in JS/JSON — NOT in HTML, because HTML carries
		// Next.js RSC flight rows with byte-length prefixes (`T<len>,...`) that a
		// length-changing swap would corrupt (empty render). The canonical-host
		// check lives in a JS chunk, so swapping JS is enough.
		if (!isHtml && pageHost && ourHost && pageHost !== ourHost) {
			text = text.split(pageHost).join(ourHost);
		}
		// Inject the hook AFTER any swap so its PHOST literal keeps the real host
		// (needed for the correct WebSocket Origin via __po).
		if (isHtml) text = injectHook(text, host);
		const buf = Buffer.from(text, "utf8");
		outHeaders["content-length"] = String(buf.length);
		res.writeHead(upstream.status, outHeaders);
		res.end(buf);
		return;
	}

	res.writeHead(upstream.status, outHeaders);
	if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
	else res.end();
}

// ---------------------------------------------------------------------------
// WebSocket proxy (server-side handshake with Origin + cookies)
// ---------------------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true });

async function handleUpgrade(req, socket, head) {
	const url = new URL(req.url, "http://localhost");
	let host, rest;
	if (url.pathname.startsWith("/__w/")) {
		({ host, rest } = parseHostPath("/__w/", url.pathname));
	} else {
		socket.destroy();
		return;
	}
	const sp = new URLSearchParams(url.search);
	const pageOrigin = sp.get("__po");
	sp.delete("__po");
	const cleanSearch = sp.toString() ? "?" + sp.toString() : "";
	const target = "wss://" + host + rest + cleanSearch;
	const cookieTarget = "https://" + host + rest;
	const cookie = await jar.getCookieString(cookieTarget).catch(() => "");
	const originToSend = pageOrigin || "https://" + host;

	const upstreamHeaders = { "User-Agent": UA, Origin: originToSend };
	if (cookie) upstreamHeaders["Cookie"] = cookie;

	const protoHeader = req.headers["sec-websocket-protocol"];
	const protocols = protoHeader
		? protoHeader.split(",").map((s) => s.trim())
		: undefined;

	const upstream = new WebSocket(target, protocols, {
		headers: upstreamHeaders,
		origin: originToSend,
		followRedirects: true,
	});

	upstream.on("unexpected-response", (_q, r) => {
		console.error(`[ws] rejected ${target} -> ${r.statusCode}`);
		socket.destroy();
	});
	upstream.on("error", (err) => {
		console.error(`[ws] error ${target}: ${err.message}`);
		socket.destroy();
	});
	upstream.once("open", () => {
		wss.handleUpgrade(req, socket, head, (client) => {
			console.log(`[ws] tunnel open -> ${target}`);
			const pump = (from, to) => {
				from.on("message", (data, isBinary) => {
					if (to.readyState === WebSocket.OPEN)
						to.send(data, { binary: isBinary });
				});
				from.on("close", (code, reason) => {
					try {
						to.close(code >= 1000 && code <= 4999 ? code : 1000, reason);
					} catch {
						/* ignore */
					}
				});
				from.on("error", () => {
					try {
						to.close();
					} catch {
						/* ignore */
					}
				});
			};
			pump(client, upstream);
			pump(upstream, client);
		});
	});
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
let port = parseInt(process.env.PORT || "");
if (isNaN(port)) port = 8081;

const server = createServer((req, res) => {
	handleHttp(req, res).catch((err) => {
		console.error("handler error:", err);
		if (!res.headersSent) res.writeHead(500);
		res.end("proxy error: " + err.message);
	});
});

server.on("upgrade", (req, socket, head) => {
	handleUpgrade(req, socket, head).catch((err) => {
		console.error("upgrade error:", err);
		socket.destroy();
	});
});

server.on("listening", () => {
	console.log("Server-side reverse proxy listening on:");
	console.log(`\thttp://localhost:${port}/`);
	console.log(`\thttp://${hostname()}:${port}/`);
	console.log(`Open any site: http://localhost:${port}/go?url=<url>`);
});

process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));

server.listen({ port });
