import { chromium } from "playwright";
const EXT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ctx = await chromium.launchPersistentContext(`/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new", "--no-sandbox"],
});
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const ok = (m) => console.log("ok:", m);
await (ctx.serviceWorkers()[0] || ctx.waitForEvent("serviceworker", { timeout: 10000 }));

for (const [w, h] of [[1920, 1080], [1440, 900], [1366, 768], [2560, 1440]]) {
  const p = await ctx.newPage();
  await p.setViewportSize({ width: w, height: h });
  await p.goto("https://www.youtube.com/watch?v=aqz-KE-bpKQ", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(7000);
  const r = await p.evaluate(() => {
    const de = document.documentElement;
    const q = (s) => document.querySelector(s);
    const player = q("ytd-watch-flexy #player-container, ytd-watch-flexy #player");
    const title = q("ytd-watch-metadata #title, ytd-watch-metadata h1.ytd-watch-metadata");
    const pb = player && player.getBoundingClientRect();
    const tb = title && title.getBoundingClientRect();
    return {
      vh: window.innerHeight,
      overflowX: de.scrollWidth - de.clientWidth,
      playerW: pb ? Math.round(pb.width) : null,
      playerH: pb ? Math.round(pb.height) : null,
      playerBottom: pb ? Math.round(pb.bottom) : null,
      titleTop: tb ? Math.round(tb.top) : null,
      titleBottom: tb ? Math.round(tb.bottom) : null,
      titleText: title ? (title.textContent || "").trim().slice(0, 40) : null,
    };
  });
  await p.close();
  console.log(`  ${w}x${h}:`, JSON.stringify(r));

  r.overflowX <= 1 ? ok(`${w}x${h}: no horizontal overflow`) : fail(`${w}x${h}: overflows ${r.overflowX}px`);

  // player fully on screen
  (r.playerBottom != null && r.playerBottom <= r.vh)
    ? ok(`${w}x${h}: player fits vertically (bottom ${r.playerBottom} <= ${r.vh})`)
    : fail(`${w}x${h}: player bottom ${r.playerBottom} past viewport ${r.vh}`);

  // title visible on screen too (its top is above the fold, ideally its bottom too)
  (r.titleTop != null && r.titleTop < r.vh - 10)
    ? ok(`${w}x${h}: video title is on screen (top ${r.titleTop} < ${r.vh})`)
    : fail(`${w}x${h}: title top ${r.titleTop} not visible in ${r.vh}px`);

  // we actually used the freed space: player wider than YouTube's ~854 default
  (r.playerW != null && r.playerW > 854)
    ? ok(`${w}x${h}: player uses the freed width (${r.playerW}px > 854 default)`)
    : console.log(`  note: player only ${r.playerW}px wide (viewport-height-limited, expected on short windows)`);
}

await ctx.close();
console.log("\nDONE");
