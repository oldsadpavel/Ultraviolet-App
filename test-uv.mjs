import { chromium } from "playwright";

const meeting = process.argv[2];
const waitMs = parseInt(process.argv[3] || "20000");
if (!meeting) {
	console.error("usage: node test-uv.mjs <real-meeting-url> [waitMs]");
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
const ctx = await browser.newContext({
	ignoreHTTPSErrors: true,
	permissions: ["microphone", "camera"],
});
await ctx.grantPermissions(["microphone", "camera"], { origin: "http://localhost:8080" }).catch(() => {});
const page = await ctx.newPage();

const consoleMsgs = [];
const errors = [];
page.on("console", (m) => {
	const t = `[${m.type()}] ${m.text().slice(0, 160)}`;
	consoleMsgs.push(t);
	if (m.type() === "error") errors.push(m.text().slice(0, 200));
});
page.on("pageerror", (e) => errors.push("PAGEERR " + String(e).slice(0, 160)));

await page.goto("http://localhost:8080/", { waitUntil: "domcontentloaded" });
// Drive the UV form: fills the address and submits (registers SW + transport).
await page.fill("#uv-address", meeting).catch(() => {});
await page.evaluate(() => {
	document.getElementById("uv-form").requestSubmit?.() ||
		document.getElementById("uv-form").dispatchEvent(new Event("submit", { cancelable: true }));
});

await page.waitForTimeout(waitMs);

const topUrl = page.url();
// Find the UV iframe and inspect its content.
let frameInfo = { found: false };
for (const f of page.frames()) {
	if (f.url().includes("/uv/service/")) {
		frameInfo = {
			found: true,
			url: f.url().slice(0, 120),
			bodyChars: await f.evaluate(() => document.body?.innerText?.length || 0).catch(() => -1),
			bodyPreview: (await f.evaluate(() => document.body?.innerText || "").catch(() => "")).slice(0, 200),
			locHost: await f.evaluate(() => { try { return location.hostname; } catch (e) { return "err"; } }).catch(() => "?"),
		};
		break;
	}
}
await page.screenshot({ path: "E:/sites/Ultraviolet-App/shot-uv.png", fullPage: true }).catch(() => {});

console.log("\n=========== UV TEST REPORT ===========");
console.log("Top URL    :", topUrl);
console.log("Iframe     :", JSON.stringify(frameInfo, null, 0));
console.log("\n-- errors (" + errors.length + ") --");
errors.slice(0, 12).forEach((e) => console.log("  " + e));
console.log("\n-- console tail --");
consoleMsgs.slice(-25).forEach((c) => console.log("  " + c));
console.log("======================================\n");
await browser.close();
