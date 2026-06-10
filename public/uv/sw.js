/*global UVServiceWorker,__uv$config*/
/*
 * Custom service worker.
 * Overrides the stock /uv/sw.js (served from node_modules) because ./public
 * is mounted before the vendor static dir in src/index.js.
 *
 * Adds request/response header rewriting on top of the stock UV behaviour.
 */
importScripts("uv.bundle.js");
importScripts("uv.config.js");
importScripts(__uv$config.sw || "uv.sw.js");

const uv = new UVServiceWorker();

/**
 * Header rewriting rules.
 *
 * Each rule is matched against the *destination* hostname (the real site being
 * proxied, e.g. "www.deepl.com"). `null` host = applies to every request.
 *
 *  - setRequestHeaders:    headers to force on the outgoing request.
 *      Values may be a string, or a function (destUrl, currentHeaders) => string.
 *  - removeRequestHeaders: header names to delete from the outgoing request.
 *  - setResponseHeaders:   headers to force on the response handed back to the page.
 *  - removeResponseHeaders:header names to delete from the response.
 *
 * Header names MUST be lowercase (UV normalises them to lowercase).
 */
// Headers that can betray that the traffic came through a proxy/relay or an
// automation layer. Stripped from EVERY outgoing request so the destination
// only ever sees a plain first-party browser request.
const PROXY_REVEALING_HEADERS = [
	// Classic forwarding/relay trail.
	"x-forwarded-for",
	"x-forwarded-host",
	"x-forwarded-proto",
	"x-forwarded-port",
	"x-forwarded-server",
	"forwarded",
	"via",
	"x-real-ip",
	"x-client-ip",
	"x-originating-ip",
	"client-ip",
	"true-client-ip",
	"cf-connecting-ip",
	"fastly-client-ip",
	"x-cluster-client-ip",
	"proxy-connection",
	"proxy-authorization",
	"cdn-loop",
	// Bare-server / Ultraviolet / TompHTTP plumbing.
	"x-bare-host",
	"x-bare-port",
	"x-bare-protocol",
	"x-bare-path",
	"x-bare-headers",
	"x-bare-forward-headers",
	"x-bare-pass-headers",
	"x-bare-pass-status",
	// Anything our own infra might tack on.
	"x-uv-host",
	"x-proxy-host",
];

const HEADER_RULES = [
	{
		// Global rule: applies to every proxied site.
		host: null,
		setRequestHeaders: {
			// Present consistent, real-browser fetch metadata + client hints so
			// the request can't be told apart from a normal first-party fetch.
			"sec-fetch-site": "same-origin",
			"sec-fetch-mode": "cors",
			"sec-fetch-dest": "empty",
			"sec-ch-ua":
				'"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
			"sec-ch-ua-mobile": "?0",
			"sec-ch-ua-platform": '"Windows"',
		},
		removeRequestHeaders: PROXY_REVEALING_HEADERS,
		setResponseHeaders: {},
		// Strip framing/CSP guards from responses so the proxied page renders
		// inside the UV iframe instead of being blocked.
		removeResponseHeaders: [
			"x-frame-options",
			"content-security-policy",
			"content-security-policy-report-only",
		],
	},
	{
		// DeepL: make API/XHR calls look like genuine first-party requests.
		host: /(^|\.)deepl\.com$/i,
		setRequestHeaders: {
			// Force Origin/Referer to the site's own origin so the backend
			// treats the request as same-site instead of cross-origin.
			origin: (destUrl) => destUrl.origin,
			referer: (destUrl) => destUrl.origin + "/",
		},
		removeRequestHeaders: [],
		setResponseHeaders: {},
		removeResponseHeaders: [],
	},

	// To inject a real auth token/cookie for an authenticated endpoint, add:
	// {
	// 	host: /(^|\.)deepl\.com$/i,
	// 	setRequestHeaders: {
	// 		authorization: "Bearer <token>",
	// 		cookie: "<name>=<value>; ...",
	// 	},
	// },
];

function ruleMatches(rule, hostname) {
	if (!rule.host) return true;
	if (rule.host instanceof RegExp) return rule.host.test(hostname);
	return rule.host.toLowerCase() === hostname.toLowerCase();
}

function applyHeaderMap(headers, map, destUrl) {
	if (!map) return;
	for (const name in map) {
		const value = map[name];
		const key = name.toLowerCase();
		headers[key] =
			typeof value === "function" ? value(destUrl, headers) : value;
	}
}

function removeHeaders(headers, names) {
	if (!names) return;
	for (const name of names) delete headers[name.toLowerCase()];
}

uv.on("request", (event) => {
	// event.data = { url (URL), headers (object), method, body, ... }
	const headers = event.data.headers;
	const destUrl = new URL(event.data.url);

	for (const rule of HEADER_RULES) {
		if (!ruleMatches(rule, destUrl.hostname)) continue;
		applyHeaderMap(headers, rule.setRequestHeaders, destUrl);
		removeHeaders(headers, rule.removeRequestHeaders);
	}
});

uv.on("response", (event) => {
	// event.data = { headers (object), body, status, statusText, ... }
	const headers = event.data.headers;
	// The proxied page's real URL is available on the request side; for the
	// response we match against the same destination via the bound request.
	const destUrl =
		event.data.url ? new URL(event.data.url) : null;

	for (const rule of HEADER_RULES) {
		if (destUrl && !ruleMatches(rule, destUrl.hostname)) continue;
		applyHeaderMap(headers, rule.setResponseHeaders, destUrl);
		removeHeaders(headers, rule.removeResponseHeaders);
	}
});

async function handleRequest(event) {
	if (uv.route(event)) {
		return await uv.fetch(event);
	}
	return await fetch(event.request);
}

self.addEventListener("fetch", (event) => {
	event.respondWith(handleRequest(event));
});
