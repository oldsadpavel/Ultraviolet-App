/*
 * Transparent MITM reverse proxy.
 *
 * Used together with Chrome launched with:
 *   --host-resolver-rules="MAP *.deepl.com 127.0.0.1:8443"
 *   --ignore-certificate-errors
 *
 * Chrome then routes every *.deepl.com request to this proxy, but the BROWSER
 * still believes it is on the real domains: location.hostname === "www.deepl.com",
 * origin === "https://www.deepl.com", cookies are stored per real domain, etc.
 * So the app's canonical-host redirect never fires and NO URL rewriting / JS
 * hooking is needed. This proxy just forwards each request to the real host
 * (Node resolves the real IP via normal DNS — Chrome's rules don't affect Node)
 * and pipes WebSockets through, passing cookies/Origin straight through.
 */
import { createServer } from "node:https";
import { Readable } from "node:stream";
import { connect as tlsConnect } from "node:tls";
import { WebSocketServer, WebSocket } from "ws";
import selfsigned from "selfsigned";

const pems = selfsigned.generate(
	[{ name: "commonName", value: "deepl.com" }],
	{
		days: 3650,
		keySize: 2048,
		algorithm: "sha256",
		altNames: [
			{ type: 2, value: "deepl.com" },
			{ type: 2, value: "*.deepl.com" },
		],
	}
);
const tlsOpts = { key: pems.private, cert: pems.cert };

const UA =
	"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

// Hop-by-hop headers not to forward.
const STRIP_REQ = new Set([
	"connection",
	"keep-alive",
	"proxy-connection",
	"transfer-encoding",
	"upgrade",
	"accept-encoding", // identity so we can pipe without decoding
]);
const STRIP_RES = new Set([
	"content-encoding",
	"content-length",
	"transfer-encoding",
	"connection",
	"keep-alive",
]);

function hostOf(req) {
	return (req.headers.host || "").split(":")[0];
}

async function handleHttp(req, res) {
	const host = hostOf(req);
	if (!host) {
		res.writeHead(400);
		res.end("no host");
		return;
	}
	const target = "https://" + host + req.url;

	const headers = {};
	for (const [k, v] of Object.entries(req.headers)) {
		if (STRIP_REQ.has(k.toLowerCase())) continue;
		headers[k] = v;
	}
	headers["host"] = host;
	headers["accept-encoding"] = "identity";
	headers["user-agent"] = headers["user-agent"] || UA;

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
		res.end("upstream failed: " + err.message + "\n" + target);
		return;
	}

	const outHeaders = {};
	for (const [k, v] of upstream.headers.entries()) {
		if (STRIP_RES.has(k.toLowerCase())) continue;
		outHeaders[k] = v;
	}
	// Pass Set-Cookie through verbatim (browser stores per real domain).
	const sc = upstream.headers.getSetCookie?.();
	if (sc && sc.length) outHeaders["set-cookie"] = sc;

	res.writeHead(upstream.status, outHeaders);
	if (upstream.body) Readable.fromWeb(upstream.body).pipe(res);
	else res.end();
}

// --- WebSocket: transparent server-side tunnel to the real host ---
const wss = new WebSocketServer({ noServer: true });

function handleUpgrade(req, socket, head) {
	const host = hostOf(req);
	const target = "wss://" + host + req.url;

	const upstreamHeaders = {};
	for (const [k, v] of Object.entries(req.headers)) {
		const lk = k.toLowerCase();
		if (
			lk === "connection" ||
			lk === "upgrade" ||
			lk.startsWith("sec-websocket-") ||
			lk === "host"
		)
			continue;
		upstreamHeaders[k] = v;
	}
	upstreamHeaders["Host"] = host;

	const protoHeader = req.headers["sec-websocket-protocol"];
	const protocols = protoHeader
		? protoHeader.split(",").map((s) => s.trim())
		: undefined;

	const upstream = new WebSocket(target, protocols, {
		headers: upstreamHeaders,
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

let port = parseInt(process.env.PORT || "");
if (isNaN(port)) port = 8443;

const server = createServer(tlsOpts, (req, res) => {
	handleHttp(req, res).catch((err) => {
		console.error("handler error:", err);
		if (!res.headersSent) res.writeHead(500);
		res.end("proxy error: " + err.message);
	});
});
server.on("upgrade", handleUpgrade);
server.on("listening", () => {
	console.log(`Transparent MITM proxy (TLS) on https://127.0.0.1:${port}`);
	console.log("Launch Chrome with:");
	console.log(
		`  --host-resolver-rules="MAP *.deepl.com 127.0.0.1:${port}, MAP deepl.com 127.0.0.1:${port}" --ignore-certificate-errors`
	);
});
process.on("SIGINT", () => server.close(() => process.exit(0)));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
server.listen({ port });
