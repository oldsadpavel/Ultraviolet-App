import { chromium } from "playwright";

// Tests the LOCAL rproxy (http://127.0.0.1:8081) but via a port-less hostname
// (prx.local) using Chrome host-resolver-rules, so location.hostname has no
// port and the host-swap canonical check behaves like production.
const meeting = process.argv[2];
const waitMs = parseInt(process.argv[3] || "16000");
const port = process.argv[4] || "8081";
if (!meeting) {
	console.error("usage: node test-local.mjs <real-meeting-url> [waitMs] [port]");
	process.exit(1);
}

const browser = await chromium.launch({
	headless: true,
	args: [
		`--host-resolver-rules=MAP prx.local 127.0.0.1:${port}`,
		"--ignore-certificate-errors",
		"--use-fake-ui-for-media-stream",
		"--use-fake-device-for-media-stream",
		"--autoplay-policy=no-user-gesture-required",
	],
});
const ctx = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ["microphone", "camera"] });
const page = await ctx.newPage();

const errors = [], sockets = [], navs = [], httpErr = [], allc = [];
page.on("console", (m) => { allc.push(`[${m.type()}] ${m.text().slice(0,140)}`); if (m.type()==="error") errors.push(m.text().slice(0,200)); });
page.on("pageerror", (e) => errors.push("PAGEERR " + (e.stack||String(e)).slice(0,200)));
page.on("response", (r) => { if (r.status()>=400) httpErr.push(`${r.status()} ${r.url().slice(0,110)}`); });
page.on("websocket", (ws) => { const rec={url:ws.url(),sent:0,recv:0,closed:false}; sockets.push(rec); ws.on("framesent",()=>rec.sent++); ws.on("framereceived",()=>rec.recv++); ws.on("close",()=>rec.closed=true); });
page.on("framenavigated", (f) => { if (f===page.mainFrame()) navs.push(f.url().slice(0,140)); });

let nav = "ok";
try { const r = await page.goto(`http://prx.local/go?url=${meeting}`, { waitUntil: "domcontentloaded", timeout: 30000 }); nav = "HTTP " + (r?r.status():"?"); }
catch (e) { nav = "NAV ERR: " + e.message; }
await page.waitForTimeout(waitMs);

const title = await page.title().catch(()=> "");
const bodyLen = await page.evaluate(()=>document.body?.innerText?.length||0).catch(()=>0);
const bodyText = (await page.evaluate(()=>document.body?.innerText||"").catch(()=> "")).slice(0,300);
const loc = await page.evaluate(()=>({href:location.href,host:location.hostname})).catch(()=>({}));
const bodyHTML = await page.evaluate(()=>document.body?.innerHTML.replace(/<script[\s\S]*?<\/script>/gi,"").slice(0,300)).catch(()=> "");
await page.screenshot({ path: "E:/sites/Ultraviolet-App/shot-local.png", fullPage: true }).catch(()=>{});

console.log("\n=========== LOCAL TEST REPORT ===========");
console.log("Navigation :", nav);
console.log("location   :", JSON.stringify(loc));
console.log("Title      :", JSON.stringify(title));
console.log("Body chars :", bodyLen);
console.log("bodyHTML   :", JSON.stringify(bodyHTML));
console.log("\n-- WebSockets ("+sockets.length+") --");
sockets.forEach(s=>console.log(`  ${s.url.slice(0,90)} sent=${s.sent} recv=${s.recv} closed=${s.closed}`));
console.log("\n-- Main-frame navigations ("+navs.length+") --");
navs.forEach(n=>console.log("  "+n));
console.log("\n-- HTTP>=400 ("+httpErr.length+") --"); httpErr.slice(0,12).forEach(h=>console.log("  "+h));
console.log("\n-- errors ("+errors.length+") --"); errors.slice(0,10).forEach(e=>console.log("  "+e));
console.log("\n-- console tail --"); allc.slice(-15).forEach(c=>console.log("  "+c));
console.log("\n-- body preview --\n"+bodyText);
console.log("=========================================\n");
await browser.close();
