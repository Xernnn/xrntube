import { chromium } from "playwright";

// The comment section's shape, as opposed to comments-test.mjs which is about
// *whose* comments get removed. Two things here:
//   - commentsTwoColumn lays the thread list out in two columns
//   - commentLimit stops the section scrolling forever
//
// The cap is the one with a trap in it: removing the excess threads alone
// does nothing lasting, because YouTube's continuation sentinel is still
// sitting there and simply fetches more to refill. The sentinel has to go
// too, which is what `continuationsLeft` checks.

const EXT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const VIDEO = "https://www.youtube.com/watch?v=aqz-KE-bpKQ";
const CAP = 8;

const ctx = await chromium.launchPersistentContext(
  `/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`,
  { headless: false, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new", "--no-sandbox"] }
);
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const ok = (m) => console.log("ok:", m);

const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }));
const extId = sw.url().split("/")[2];
const ext = await ctx.newPage();
await ext.goto(`chrome-extension://${extId}/options/options.html`);
await ext.waitForTimeout(600);

const setLimit = async (n) => {
  await ext.evaluate(
    (v) => chrome.storage.sync.set({ bt_keywords: { list: [], ts: Date.now(), durMinSec: 0, durMaxSec: 0, commentLimit: v } }),
    n
  );
  await ext.waitForTimeout(800);
};
const setToggle = async (key, on) => {
  await ext.locator(".page-tab[data-page='settings']").click();
  await ext.waitForTimeout(150);
  const cb = ext.locator(`#settings-list .switch[data-key="${key}"] input`);
  if ((await cb.isChecked()) !== on) await ext.locator(`#settings-list .switch[data-key="${key}"] .slider`).click();
  await ext.waitForFunction(
    ([k, v]) => chrome.storage.sync.get("bt_settings").then((r) => r.bt_settings && r.bt_settings[k] === v),
    [key, on],
    { timeout: 3000 }
  );
};

// Load a watch page and scroll far enough that comments would keep paging in.
const readComments = async () => {
  const p = await ctx.newPage();
  await p.goto(VIDEO, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(7000);
  for (let i = 0; i < 6; i += 1) {
    await p.evaluate(() => window.scrollBy(0, 1200));
    await p.waitForTimeout(2000);
  }
  const r = await p.evaluate(() => {
    const contents = document.querySelector("ytd-comments#comments ytd-item-section-renderer#sections > #contents");
    if (!contents) return { found: false };
    const threads = [...contents.querySelectorAll(":scope > ytd-comment-thread-renderer")];
    return {
      found: true,
      threads: threads.length,
      columnCount: getComputedStyle(contents).columnCount,
      // Two columns means two distinct left edges among the first few threads.
      distinctLeftEdges: [...new Set(threads.slice(0, 6).map((t) => Math.round(t.getBoundingClientRect().left)))].length,
      capNote: !!contents.querySelector("bt-comment-cap"),
      continuationsLeft: contents.querySelectorAll(":scope > ytd-continuation-item-renderer").length
    };
  });
  await p.close();
  return r;
};

await setLimit(CAP);
const on = await readComments();
if (!on.found) {
  fail("no comment section rendered — YouTube markup changed, or comments are off for this video");
} else {
  console.log("   with cap + columns:", JSON.stringify(on));
  on.columnCount === "2" ? ok("comment list is two columns") : fail(`columnCount ${on.columnCount}`);
  on.distinctLeftEdges === 2
    ? ok("threads actually lay out across both columns")
    : fail(`threads share ${on.distinctLeftEdges} left edge(s) — columnised in CSS but not in layout`);
  on.threads === CAP ? ok(`comment list capped at ${CAP}`) : fail(`${on.threads} threads, expected ${CAP}`);
  on.continuationsLeft === 0
    ? ok("continuation sentinel removed, so it stops paging in more")
    : fail(`${on.continuationsLeft} sentinel(s) left — the section will refill`);
  on.capNote ? ok("the page says why the list stops") : fail("no cap notice");
}

// ---- both switch off independently ----
await setLimit(0);
await setToggle("commentsTwoColumn", false);
const off = await readComments();
if (off.found) {
  console.log("   with both off:", JSON.stringify(off));
  off.columnCount !== "2" ? ok("toggle off -> single column again") : fail("still two columns");
  off.threads > CAP
    ? ok(`limit 0 -> uncapped again (${off.threads} threads)`)
    : fail(`still capped at ${off.threads}`);
  !off.capNote ? ok("no cap notice when uncapped") : fail("stale cap notice");
}
await setToggle("commentsTwoColumn", true);

await ctx.close();
console.log("\nDONE");
