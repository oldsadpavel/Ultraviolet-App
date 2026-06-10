import { chromium } from "playwright";

const target = process.argv[2]; // a REAL url, e.g. https://www.deepl.com/ru/voice/meetings/<id>
const waitMs = parseInt(process.argv[3] || "16000");
const proxyPort = process.argv[4] || "8443";
if (!target) {
	console.error("usage: node test-mitm.mjs <real-url> [waitMs] [proxyPort]");
	process.exit(1);
}

const browser = await chromium.launch({
	headless: true,
	ignoreHTTPSErrors: true,
	args: [
		`--host-resolver-rules=MAP *.deepl.com 127.0.0.1:${proxyPort}, MAP deepl.com 127.0.0.1:${proxyPort}`,
		"--ignore-certificate-errors",
		"--use-fake-ui-for-media-stream",
		"--use-fake-device-for-media-stream",
		"--autoplay-policy=no-user-gesture-required",
	],
});
const ctx = await browser.newContext({
	ignoreHTTPSErrors: true,
	permissions: ["microphone", "camera"],
});
const page = await ctx.newPage();

const consoleErrors = [];
const pageErrors = [];
const sockets = [];
const navs = [];
const httpErrors = [];
page.on("console", (m) => {
	if (m.type() === "error") consoleErrors.push(m.text().slice(0, 200));
});
page.on("pageerror", (e) => pageErrors.push((e.stack || String(e)).slice(0, 300)));
page.on("response", (r) => {
	if (r.status() >= 400) httpErrors.push(`${r.status()} ${r.url().slice(0, 120)}`);
});
page.on("websocket", (ws) => {
	const rec = { url: ws.url(), sent: 0, recv: 0, closed: false };
	sockets.push(rec);
	ws.on("framesent", () => rec.sent++);
	ws.on("framereceived", () => rec.recv++);
	ws.on("close", () => (rec.closed = true));
});
page.on("framenavigated", (f) => {
	if (f === page.mainFrame()) navs.push(f.url().slice(0, 150));
});

let nav = "ok";
try {
	const r = await page.goto(target, { waitUntil: "domcontentloaded", timeout: 30000 });
	nav = "HTTP " + (r ? r.status() : "?");
} catch (e) {
	nav = "NAV ERR: " + e.message;
}
await page.waitForTimeout(waitMs);

const title = await page.title().catch(() => "");
const bodyLen = await page.evaluate(() => document.body?.innerText?.length || 0).catch(() => 0);
const bodyText = (await page.evaluate(() => document.body?.innerText || "").catch(() => "")).slice(0, 300);
const loc = await page.evaluate(() => ({ href: location.href, host: location.hostname, origin: location.origin })).catch(() => ({}));
await page.screenshot({ path: "E:/sites/Ultraviolet-App/shot-mitm.png", fullPage: true }).catch(() => {});

console.log("\n=========== MITM TEST REPORT ===========");
console.log("Target     :", target);
console.log("Navigation :", nav);
console.log("location   :", JSON.stringify(loc));
console.log("Title      :", JSON.stringify(title));
console.log("Body chars :", bodyLen);
console.log("\n-- WebSockets (" + sockets.length + ") --");
sockets.forEach((s) => console.log(`  ${s.url.slice(0, 90)} sent=${s.sent} recv=${s.recv} closed=${s.closed}`));
console.log("\n-- Main-frame navigations (" + navs.length + ") --");
navs.forEach((n) => console.log("  " + n));
console.log("\n-- HTTP >=400 (" + httpErrors.length + ") --");
httpErrors.slice(0, 15).forEach((h) => console.log("  " + h));
console.log("\n-- Page errors (" + pageErrors.length + ") --");
pageErrors.slice(0, 8).forEach((p) => console.log("  " + p));
console.log("\n-- Console errors (" + consoleErrors.length + ") --");
consoleErrors.slice(0, 8).forEach((c) => console.log("  " + c));
console.log("\n-- Body preview --\n" + bodyText);
console.log("========================================\n");
await browser.close();
