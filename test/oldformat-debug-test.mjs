import { chromium } from "playwright";

// Two of the Phase-2 additions:
//  1. convertOldBlockTube() — the original BlockTube export shape
//     (filterData.channelId as a commented text list) auto-detected on import.
//  2. the ?bt-debug surface — window.__blockTube.state()/why().

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ctx = await chromium.launchPersistentContext(`/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const ok = (m) => console.log("ok:", m);

const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }));
const extId = sw.url().split("/")[2];
const ext = await ctx.newPage();
await ext.goto(`chrome-extension://${extId}/options/options.html`);
await ext.waitForLoadState("domcontentloaded");
await ext.waitForTimeout(300);
const send = (m) => ext.evaluate((mm) => chrome.runtime.sendMessage(mm), m);

// ---- 1. convertOldBlockTube ----
const conv = await ext.evaluate(() => {
  const raw = {
    filterData: {
      channelId: [
        "// Add your channel ID filters below",
        "",
        "// Blocked by context menu (Hay Phết) (7/13/2026, 11:56:13 PM)",
        "UCPbq4cK8Mpka5Qvy_nFZTHw",
        "",
        "// Blocked by context menu (Some Handle Chan) (1/2/2025, 10:00:00 AM)",
        "@somehandle",
        "",
        "UCBJycsmduvYEL83R_U4JriQ",
      ],
      videoId: [
        "// Add your video ID filters below",
        "",
        "// Blocked by context menu (A Video Title) (7/13/2026, 9:55:41 PM)",
        "lofR2ZmpsiQ",
        "",
      ],
    },
  };
  const out = typeof convertOldBlockTube === "function" ? convertOldBlockTube(raw) : null;
  return out && {
    channels: Object.keys(out.channels),
    videos: Object.keys(out.videos),
    named: out.channels["UCPbq4cK8Mpka5Qvy_nFZTHw"],
    bareOk: !!out.channels["UCBJycsmduvYEL83R_U4JriQ"],
    vidTitle: out.videos["lofR2ZmpsiQ"] && out.videos["lofR2ZmpsiQ"].title,
  };
});
if (!conv) {
  fail("convertOldBlockTube is not defined on the options page");
} else {
  conv.channels.length === 3
    ? ok(`convertOldBlockTube: 3 channels (${conv.channels.join(", ")})`)
    : fail(`expected 3 channels, got ${conv.channels.length}: ${conv.channels.join(", ")}`);
  conv.named && conv.named.name === "Hay Phết" && conv.named.mode === "full"
    ? ok(`name + ts + mode carried across ("${conv.named.name}", ts=${conv.named.ts})`)
    : fail("channel entry missing name/mode: " + JSON.stringify(conv.named));
  conv.bareOk ? ok("a bare id with no preceding comment still imports") : fail("bare id dropped");
  conv.videos.length === 1 && conv.vidTitle === "A Video Title"
    ? ok(`video parsed with title ("${conv.vidTitle}")`)
    : fail("video parse wrong: " + JSON.stringify(conv));
}

// ---- 2. ?bt-debug surface ----
// content.js's console output shows in the page console (the content script's
// context). window.__blockTube itself lives in the isolated world, so a
// main-world page.evaluate can't see it — assert on the console instead, plus
// reach the object through Playwright's dedicated content-script context.
const logs = [];
const dbg = await ctx.newPage();
dbg.on("console", (m) => logs.push(m.text()));
// Block something so there's a guaranteed removal to log.
await send({ type: "BLOCK_CHANNEL", id: "@MrBeast", name: "MrBeast", mode: "full" });
await dbg.goto("https://www.youtube.com/results?search_query=mrbeast&bt-debug=1", { waitUntil: "domcontentloaded" });
await dbg.waitForTimeout(8000);
logs.some((l) => /\[BlockTube\] debug mode on/.test(l))
  ? ok("?bt-debug logs the 'debug mode on' banner to the page console")
  : fail("no debug banner in console logs");
logs.some((l) => /\[BlockTube\].*removed .*—/.test(l))
  ? ok("removals are logged with a reason")
  : console.log("   (no removal logged — MrBeast may be absent from that search right now)");

// Reach window.__blockTube via the content-script execution context.
let btProbe = null;
try {
  for (let i = 0; i < 20 && !btProbe; i++) {
    for (const f of dbg.frames()) {
      const r = await f
        .evaluate(() => (window.__blockTube ? { hasState: "durMinSec" in window.__blockTube.state() } : null))
        .catch(() => null);
      if (r) { btProbe = r; break; }
    }
    if (!btProbe) await dbg.waitForTimeout(250);
  }
} catch {}
btProbe && btProbe.hasState
  ? ok("__blockTube.state() reachable in the content-script context")
  : console.log("   (couldn't reach __blockTube from Playwright — expected: it's isolated-world; console path above is the real check)");
await send({ type: "UNBLOCK_CHANNEL", id: "@MrBeast" });
await dbg.close();

await ctx.close();
console.log("\nDONE");
