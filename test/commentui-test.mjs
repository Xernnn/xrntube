import { chromium } from "playwright";

// The comment section's shape, as opposed to comments-test.mjs which is about
// *whose* comments get removed. Two things here:
//   - commentsTwoColumn lays the thread list out in two columns, and they
//     only ever grow: a batch that loads lands under both columns, and no
//     thread already placed moves (CSS columns rebalanced the whole list on
//     every batch, sliding the top of the right column into the left)
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
  {
    headless: false,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, "--headless=new", "--no-sandbox"],
    viewport: { width: 1500, height: 1000 }
  }
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

// The list as laid out: where each thread is (keyed by a tag the first
// snapshot puts on it, so later snapshots can say which ones moved), how
// many columns that makes, and whether any two in a column overlap.
const listState = (p) =>
  p.evaluate(() => {
    const contents = document.querySelector("ytd-comments#comments ytd-item-section-renderer#sections > #contents");
    if (!contents) return { found: false };
    const lr = contents.getBoundingClientRect();
    const threads = [...contents.querySelectorAll(":scope > ytd-comment-thread-renderer")].filter((t) => t.getClientRects().length);
    threads.forEach((t, i) => { if (!t.dataset.btTest) t.dataset.btTest = String(i); });
    const pos = threads.map((t) => {
      const r = t.getBoundingClientRect();
      return { id: t.dataset.btTest, x: Math.round(r.left - lr.left), y: Math.round(r.top - lr.top), h: Math.round(r.height) };
    });
    const cols = {};
    for (const q of pos) (cols[q.x] ||= []).push(q);
    let overlaps = 0;
    for (const c of Object.values(cols)) {
      c.sort((a, b) => a.y - b.y);
      for (let i = 1; i < c.length; i += 1) if (c[i].y < c[i - 1].y + c[i - 1].h - 1) overlaps += 1;
    }
    const sentinel = contents.querySelector(":scope > ytd-continuation-item-renderer");
    return {
      found: true,
      threads: threads.length,
      managed: contents.hasAttribute("bt-cols"),
      distinctLeftEdges: Object.keys(cols).length,
      overlaps,
      bottoms: Object.values(cols).map((c) => Math.max(...c.map((q) => q.y + q.h))),
      maxH: Math.max(0, ...pos.map((q) => q.h)),
      sentinelTop: sentinel ? Math.round(sentinel.getBoundingClientRect().top - lr.top) : null,
      leftoverVars: threads.filter((t) => t.style.getPropertyValue("--bt-y")).length,
      capNote: !!contents.querySelector("bt-comment-cap"),
      continuationsLeft: contents.querySelectorAll(":scope > ytd-continuation-item-renderer").length,
      pos: Object.fromEntries(pos.map((q) => [q.id, [q.x, q.y]]))
    };
  });
const scroll = async (p, times, by = 1200) => {
  for (let i = 0; i < times; i += 1) {
    await p.evaluate((d) => window.scrollBy(0, d), by);
    await p.waitForTimeout(2000);
  }
};

// Load a watch page and scroll far enough that comments would keep paging in.
const readComments = async () => {
  const p = await ctx.newPage();
  await p.goto(VIDEO, { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(7000);
  await scroll(p, 6);
  const r = await listState(p);
  await p.close();
  return r;
};

await setLimit(CAP);
const on = await readComments();
if (!on.found) {
  fail("no comment section rendered — YouTube markup changed, or comments are off for this video");
} else {
  console.log("   with cap + columns:", JSON.stringify({ ...on, pos: undefined }));
  on.managed ? ok("comment list is laid out in columns by the extension") : fail("list not managed (no [bt-cols])");
  on.distinctLeftEdges === 2
    ? ok("threads actually lay out across both columns")
    : fail(`threads share ${on.distinctLeftEdges} left edge(s) — two columns in name only`);
  on.threads === CAP ? ok(`comment list capped at ${CAP}`) : fail(`${on.threads} threads, expected ${CAP}`);
  on.continuationsLeft === 0
    ? ok("continuation sentinel removed, so it stops paging in more")
    : fail(`${on.continuationsLeft} sentinel(s) left — the section will refill`);
  on.capNote ? ok("the page says why the list stops") : fail("no cap notice");
}

// ---- the columns only grow ----
await setLimit(0);
const grow = await ctx.newPage();
await grow.goto(VIDEO, { waitUntil: "domcontentloaded" });
await grow.waitForTimeout(5000);
await scroll(grow, 3);
const first = await listState(grow);
await scroll(grow, 6, 1500);
const more = await listState(grow);
if (!first.found || first.threads < 10 || more.threads <= first.threads) {
  fail(`comments didn't page in enough to test growth: ${first.threads} then ${more.threads}`);
} else {
  console.log(`   ${first.threads} threads, then ${more.threads}; column bottoms ${JSON.stringify(more.bottoms)}`);
  const moved = Object.keys(first.pos).filter(
    (id) => more.pos[id] && (more.pos[id][0] !== first.pos[id][0] || Math.abs(more.pos[id][1] - first.pos[id][1]) > 1)
  );
  moved.length === 0
    ? ok(`loading ${more.threads - first.threads} more moved none of the first ${first.threads} threads`)
    : fail(`${moved.length} of the first ${first.threads} threads moved when more loaded (${moved.slice(0, 5).join(", ")}…)`);
  const added = Object.keys(more.pos).filter((id) => !(id in first.pos));
  const perCol = {};
  for (const id of added) perCol[more.pos[id][0]] = (perCol[more.pos[id][0]] || 0) + 1;
  const counts = Object.values(perCol);
  counts.length === 2 && Math.min(...counts) >= Math.max(...counts) * 0.3
    ? ok(`the new batch filled in under both columns (${counts.join(" / ")})`)
    : fail("new threads didn't land under both columns: " + JSON.stringify(perCol));
  more.overlaps === 0 ? ok("no two threads in a column overlap") : fail(`${more.overlaps} overlapping thread(s)`);
  more.bottoms.length === 2 && Math.abs(more.bottoms[0] - more.bottoms[1]) <= more.maxH + 8
    ? ok("the two columns end within one thread of each other")
    : fail(`columns unbalanced: bottoms ${JSON.stringify(more.bottoms)}, tallest thread ${more.maxH}`);
  more.sentinelTop === null || more.sentinelTop >= Math.max(...more.bottoms)
    ? ok("the continuation sentinel sits below both columns")
    : fail(`sentinel at ${more.sentinelTop}, above a column ending at ${Math.max(...more.bottoms)}`);

  // A thread that grows pushes down only its own column.
  const target = await grow.evaluate(() => {
    const t = [...document.querySelectorAll("ytd-comment-thread-renderer[data-bt-test]")].find((el) =>
      el.querySelector("#more-replies button")
    );
    return t ? t.dataset.btTest : null;
  });
  const heightOf = (id) =>
    grow.evaluate((i) => document.querySelector(`ytd-comment-thread-renderer[data-bt-test="${i}"]`).offsetHeight, id);
  const h0 = target ? await heightOf(target) : 0;
  const before = target ? await listState(grow) : null;
  if (target) {
    await grow.evaluate((id) => {
      const t = document.querySelector(`ytd-comment-thread-renderer[data-bt-test="${id}"]`);
      const buttons = [...t.querySelectorAll("#more-replies button")];
      (buttons.find((b) => b.getClientRects().length) || buttons[0]).click();
    }, target);
    await grow.waitForTimeout(3000);
  }
  if (!target || (await heightOf(target)) <= h0) {
    console.log("   (no thread's replies opened — skipping the expand check)");
  } else {
    const after = await listState(grow);
    const tx = before.pos[target][0];
    const otherMoved = Object.keys(before.pos).filter(
      (id) => before.pos[id][0] !== tx && after.pos[id] && after.pos[id].join() !== before.pos[id].join()
    );
    const switched = Object.keys(before.pos).filter((id) => after.pos[id] && after.pos[id][0] !== before.pos[id][0]);
    otherMoved.length === 0 && switched.length === 0 && after.overlaps === 0
      ? ok("opening a thread's replies moves nothing in the other column, and nothing changes column")
      : fail(`after opening replies: ${otherMoved.length} moved in the other column, ${switched.length} switched, ${after.overlaps} overlaps`);
  }

  // Live toggle: off gives the plain single list back, on lays it out again.
  await setToggle("commentsTwoColumn", false);
  await grow.waitForTimeout(2500);
  const liveOff = await listState(grow);
  !liveOff.managed && liveOff.distinctLeftEdges === 1 && liveOff.leftoverVars === 0
    ? ok("switched off live: one column again, nothing left on the threads")
    : fail("switched off live: " + JSON.stringify({ ...liveOff, pos: undefined }));
  await setToggle("commentsTwoColumn", true);
  await grow.waitForTimeout(2500);
  const liveOn = await listState(grow);
  liveOn.managed && liveOn.distinctLeftEdges === 2 && liveOn.overlaps === 0
    ? ok("switched back on live: two columns, no overlaps")
    : fail("switched on live: " + JSON.stringify({ ...liveOn, pos: undefined }));
}
await grow.close();

// ---- both switch off independently ----
await setLimit(0);
await setToggle("commentsTwoColumn", false);
const off = await readComments();
if (off.found) {
  console.log("   with both off:", JSON.stringify({ ...off, pos: undefined }));
  !off.managed && off.distinctLeftEdges === 1 ? ok("toggle off -> single column again") : fail("still two columns");
  off.threads > CAP
    ? ok(`limit 0 -> uncapped again (${off.threads} threads)`)
    : fail(`still capped at ${off.threads}`);
  !off.capNote ? ok("no cap notice when uncapped") : fail("stale cap notice");
}
await setToggle("commentsTwoColumn", true);

await ctx.close();
console.log("\nDONE");
