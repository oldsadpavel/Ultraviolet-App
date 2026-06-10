import { chromium } from "playwright";

const target = process.argv[2];
const waitMs = parseInt(process.argv[3] || "15000");
if (!target) {
	console.error("usage: node test-proxy.mjs <proxied-url> [waitMs]");
	process.exit(1);
}

const browser = await chromium.launch({
	headless: true,
	args: [
		"--use-fake-ui-for-media-stream",
		"--use-fake-device-for-media-stream",
		"--autoplay-policy=no-user-gesture-required",
	],
});
const origin = new URL(target).origin;
const ctx = await browser.newContext({
	ignoreHTTPSErrors: true,
	permissions: ["microphone", "camera"],
});
await ctx.grantPermissions(["microphone", "camera"], { origin }).catch(() => {});
const page = await ctx.newPage();

const consoleErrors = [];
const pageErrors = [];
const failed = [];
const httpErrors = [];
const sockets = [];

const allConsole = [];
page.on("console", (msg) => {
	allConsole.push(`[${msg.type()}] ${msg.text().slice(0, 200)}`);
	if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 300));
});
const reqLog = [];
const pending = new Map();
page.on("request", (req) => pending.set(req, `${req.method()} ${req.url().slice(0, 130)}`));
page.on("response", (resp) => {
	reqLog.push(`${resp.status()} ${resp.request().method()} ${resp.url().slice(0, 120)}`);
});
page.on("requestfinished", (req) => pending.delete(req));
page.on("requestfailed", (req) => pending.delete(req));
const navs = [];
page.on("framenavigated", (f) => {
	if (f === page.mainFrame()) navs.push(f.url().slice(0, 150));
});
page.on("pageerror", (err) =>
	pageErrors.push((err.stack || String(err)).slice(0, 600))
);
page.on("requestfailed", (req) => {
	failed.push(`${req.method()} ${req.url().slice(0, 140)} :: ${req.failure()?.errorText}`);
});
page.on("response", (resp) => {
	const s = resp.status();
	if (s >= 400) httpErrors.push(`${s} ${resp.url().slice(0, 140)}`);
});
page.on("websocket", (ws) => {
	const rec = { url: ws.url(), sent: 0, recv: 0, closed: false, error: null };
	sockets.push(rec);
	ws.on("framesent", () => rec.sent++);
	ws.on("framereceived", () => rec.recv++);
	ws.on("close", () => (rec.closed = true));
	ws.on("socketerror", (e) => (rec.error = String(e)));
});

let navStatus = "ok";
try {
	const resp = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 });
	navStatus = `HTTP ${resp?.status()}`;
} catch (e) {
	navStatus = "NAV ERROR: " + e.message;
}

await page.waitForTimeout(waitMs);

const title = await page.title().catch(() => "");
const bodyText = (await page.evaluate(() => document.body?.innerText || "").catch(() => "")).slice(0, 400);
const bodyLen = (await page.evaluate(() => document.body?.innerText?.length || 0).catch(() => 0));
const diag = await page
	.evaluate(() => ({
		htmlLen: document.documentElement.outerHTML.length,
		bodyChildren: document.body?.children.length,
		nextChildren: document.querySelector("#__next")?.children.length ?? "no #__next",
		rootChildren: document.querySelector("#root,#app,[data-reactroot]")?.children.length ?? "n/a",
		scripts: document.querySelectorAll("script[src]").length,
		firstScripts: [...document.querySelectorAll("script[src]")].slice(0, 3).map((s) => s.src.slice(0, 90)),
		bodyHTML: document.body?.innerHTML.replace(/<script[\s\S]*?<\/script>/gi, "").slice(0, 1500),
	}))
	.catch((e) => ({ err: String(e) }));
await page.screenshot({ path: "E:/sites/Ultraviolet-App/shot.png", fullPage: true }).catch(() => {});
console.log("Diag       :", JSON.stringify(diag));

console.log("\n================ PROXY TEST REPORT ================");
console.log("Target     :", target);
console.log("Navigation :", navStatus);
console.log("Title      :", JSON.stringify(title));
console.log("Body chars :", bodyLen);
console.log("\n--- WebSockets (" + sockets.length + ") ---");
for (const s of sockets)
	console.log(`  ${s.url.slice(0, 110)}\n     sent=${s.sent} recv=${s.recv} closed=${s.closed} err=${s.error || "-"}`);
console.log("\n--- Failed requests (" + failed.length + ") ---");
failed.slice(0, 20).forEach((f) => console.log("  " + f));
console.log("\n--- HTTP >=400 (" + httpErrors.length + ") ---");
httpErrors.slice(0, 20).forEach((f) => console.log("  " + f));
console.log("\n--- Page errors (" + pageErrors.length + ") ---");
pageErrors.slice(0, 12).forEach((f) => console.log("  " + f));
console.log("\n--- Console errors (" + consoleErrors.length + ") ---");
consoleErrors.slice(0, 12).forEach((f) => console.log("  " + f));
console.log("\n--- Body preview ---\n" + bodyText);
console.log("\n--- All console (" + allConsole.length + ") ---");
allConsole.slice(0, 40).forEach((c) => console.log("  " + c));
console.log("\n--- Requests (" + reqLog.length + ", showing api/non-static) ---");
reqLog
	.filter((r) => !/_next\/static|\.(js|css|png|svg|woff2?|ico|jpg|webp)(\?|$)/i.test(r))
	.slice(0, 40)
	.forEach((r) => console.log("  " + r));
console.log("\n--- Main-frame navigations (" + navs.length + ") ---");
navs.forEach((n) => console.log("  " + n));
console.log("\n--- PENDING requests (" + pending.size + ", never completed) ---");
[...pending.values()]
	.filter((r) => !/_next\/static|\.(js|css|png|svg|woff2?|ico|jpg|webp)(\?|$)/i.test(r))
	.slice(0, 30)
	.forEach((r) => console.log("  " + r));
console.log("===================================================\n");

await browser.close();
