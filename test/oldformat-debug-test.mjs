import { chromium } from "playwright";

// Two of the Phase-2 additions:
//  1. convertOldBlockTube() — the original BlockTube export shape
//     (filterData.channelId as a commented text list) auto-detected on import.
//  2. the ?bt-debug surface — window.__xrnTube.state()/why().

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
        "// Blocked by context menu (Kênh Thử Nghiệm) (7/13/2026, 11:56:13 PM)",
        "UCsynthTestChannel000001",
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
    named: out.channels["UCsynthTestChannel000001"],
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
  conv.named && conv.named.name === "Kênh Thử Nghiệm" && conv.named.mode === "full"
    ? ok(`name + ts + mode carried across ("${conv.named.name}", ts=${conv.named.ts})`)
    : fail("channel entry missing name/mode: " + JSON.stringify(conv.named));
  conv.bareOk ? ok("a bare id with no preceding comment still imports") : fail("bare id dropped");
  conv.videos.length === 1 && conv.vidTitle === "A Video Title"
    ? ok(`video parsed with title ("${conv.vidTitle}")`)
    : fail("video parse wrong: " + JSON.stringify(conv));
}

// ---- 1b. everything else an old export carries ----
// The import has to account for every line: what came across, and what
// couldn't and why. Fields as one newline-joined string (older BlockTube
// versions) as well as arrays.
const conv2 = await ext.evaluate(() => {
  const raw = {
    filterData: {
      channelId: [
        "// Blocked by context menu (Name (Official)) (7/13/2026, 11:56:13 PM)",
        "UCsynthTestChannel000001",
        "// Blocked by context menu (Two",
        "Lines) (1/2/2025, 10:00:00 AM)",
        "UCBJycsmduvYEL83R_U4JriQ",
        "https://www.youtube.com/@LinkedHandle/videos",
        "https://www.youtube.com/channel/UCX6OQ3DkcsbYNE6H8uQQuVA",
        "UCaaaaaaaaaaaaaaaaaaaaaa   // a note",
        "not a channel",
      ],
      videoId: "// Add your video ID filters below\nlofR2ZmpsiQ\nhttps://youtu.be/abcdefghijk\nnope",
      title: ["// comment", "reaction", "/\\btier list\\b/i", "/[unclosed/"],
      channelName: ["Some Display Name"],
      comment: ["spam words"],
      vidLength: [60, 7200],
      javascript: "(video, objectType) => {\n  // Add custom conditions below\n\n  return false;\n}",
    },
  };
  const out = convertOldBlockTube(raw);
  return {
    channels: out.channels,
    videos: Object.keys(out.videos),
    keywords: out.keywords,
    duration: out.duration,
    skipped: out.skipped.map((s) => s.field + ":" + s.value),
  };
});
const ch2 = conv2.channels;
ch2["UCsynthTestChannel000001"] && ch2["UCsynthTestChannel000001"].name === "Name (Official)"
  ? ok("a name with its own parentheses survives")
  : fail("parenthesised name: " + JSON.stringify(ch2["UCsynthTestChannel000001"]));
ch2["UCBJycsmduvYEL83R_U4JriQ"] && ch2["UCBJycsmduvYEL83R_U4JriQ"].name === "Two Lines"
  ? ok("a name broken across two lines is rejoined")
  : fail("two-line name: " + JSON.stringify(ch2["UCBJycsmduvYEL83R_U4JriQ"]));
ch2["@LinkedHandle"] && ch2["UCX6OQ3DkcsbYNE6H8uQQuVA"] && ch2["UCaaaaaaaaaaaaaaaaaaaaaa"]
  ? ok("channel links and an id with a trailing // note all import")
  : fail("links / noted id missing: " + Object.keys(ch2).join(", "));
conv2.videos.length === 2 && conv2.videos.includes("abcdefghijk")
  ? ok("a newline-joined videoId string parses, links included")
  : fail("videos: " + conv2.videos.join(", "));
JSON.stringify(conv2.keywords) === JSON.stringify([{ p: "reaction", re: false }, { p: "\\btier list\\b", re: true }])
  ? ok("title filters become keywords, /regex/ ones as regex")
  : fail("keywords: " + JSON.stringify(conv2.keywords));
conv2.duration && conv2.duration.minSec === 60 && conv2.duration.maxSec === 7200
  ? ok("vidLength becomes the length rule")
  : fail("duration: " + JSON.stringify(conv2.duration));
const want = ["channelId:not a channel", "videoId:nope", "title:/[unclosed/", "channelName:Some Display Name", "comment:spam words"];
want.every((w) => conv2.skipped.includes(w)) && conv2.skipped.length === want.length
  ? ok(`every unimportable line is reported, nothing else (${conv2.skipped.length}); the do-nothing JS template is not`)
  : fail("skipped: " + JSON.stringify(conv2.skipped));

// ---- 2. ?bt-debug surface ----
// content.js's console output shows in the page console (the content script's
// context). window.__xrnTube itself lives in the isolated world, so a
// main-world page.evaluate can't see it — assert on the console instead, plus
// reach the object through Playwright's dedicated content-script context.
const logs = [];
const dbg = await ctx.newPage();
dbg.on("console", (m) => logs.push(m.text()));
// Block something so there's a guaranteed removal to log.
await send({ type: "BLOCK_CHANNEL", id: "@MrBeast", name: "MrBeast", mode: "full" });
await dbg.goto("https://www.youtube.com/results?search_query=mrbeast&bt-debug=1", { waitUntil: "domcontentloaded" });
await dbg.waitForTimeout(8000);
logs.some((l) => /\[XrnTube\] debug mode on/.test(l))
  ? ok("?bt-debug logs the 'debug mode on' banner to the page console")
  : fail("no debug banner in console logs");
logs.some((l) => /\[XrnTube\].*removed .*—/.test(l))
  ? ok("removals are logged with a reason")
  : console.log("   (no removal logged — MrBeast may be absent from that search right now)");

// Reach window.__xrnTube via the content-script execution context.
let btProbe = null;
try {
  for (let i = 0; i < 20 && !btProbe; i++) {
    for (const f of dbg.frames()) {
      const r = await f
        .evaluate(() => (window.__xrnTube ? { hasState: "durMinSec" in window.__xrnTube.state() } : null))
        .catch(() => null);
      if (r) { btProbe = r; break; }
    }
    if (!btProbe) await dbg.waitForTimeout(250);
  }
} catch {}
btProbe && btProbe.hasState
  ? ok("__xrnTube.state() reachable in the content-script context")
  : console.log("   (couldn't reach __xrnTube from Playwright — expected: it's isolated-world; console path above is the real check)");
await send({ type: "UNBLOCK_CHANNEL", id: "@MrBeast" });
await dbg.close();

await ctx.close();
console.log("\nDONE");
