import { chromium } from "playwright";

// The bulk-select bar: Select → tick rows → Hide / Video-only / Never-block /
// Unblock. Four destructive-ish actions across a whole selection, none of them
// covered anywhere else.
//
// Synthetic channels only — nothing here needs a live page, so it is fast and
// deterministic.

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

const ctx = await chromium.launchPersistentContext(`/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
  viewport: { width: 1400, height: 1000 }
});
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);

const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
const extId = sw.url().split("/")[2];
const p = await ctx.newPage();
const errs = [];
p.on("pageerror", (e) => errs.push(String(e)));
await p.goto(`chrome-extension://${extId}/options/options.html`);
await p.waitForTimeout(1000);

const IDS = ["@bulkA", "@bulkB", "@bulkC", "@bulkD"];
const seed = { channels: {}, videos: {} };
IDS.forEach((id, i) => {
  seed.channels[id] = { name: "Bulk " + id.slice(5), ts: Date.now() - i, subs: `${10 - i}K`, subsAt: Date.now() };
});
const msg = (m) => p.evaluate((mm) => new Promise((r) => chrome.runtime.sendMessage(mm, r)), m);
const blocklist = () => msg({ type: "GET_BLOCKLIST" });

const reseed = async () => {
  for (const id of IDS) await msg({ type: "UNBLOCK_CHANNEL", id });
  for (const id of IDS) await msg({ type: "DISALLOW_CHANNEL", id });
  await msg({ type: "IMPORT_BLOCKLIST", channels: seed.channels, videos: {} });
  await p.reload();
  await p.waitForTimeout(1800);
};

// Every bulkApply action goes through a confirm(); Playwright dismisses
// dialogs unless told otherwise, which silently turns each one into a no-op.
p.on("dialog", (d) => d.accept());

// Enter select mode and tick the seeded rows.
const selectSeeded = async () => {
  await p.click("#select-mode-btn");
  await p.waitForTimeout(500);
  const n = await p.evaluate((ids) => {
    let hit = 0;
    for (const li of document.querySelectorAll("#channel-list .channel-row")) {
      if (!ids.includes(li.dataset.id)) continue;
      const cb = li.querySelector(".row-check");
      if (cb && !cb.checked) {
        cb.click();
        hit++;
      }
    }
    return hit;
  }, IDS);
  await p.waitForTimeout(400);
  return n;
};

await reseed();
const ticked = await selectSeeded();
ticked === IDS.length
  ? ok(`select mode exposes a checkbox per row (${ticked} ticked)`)
  : fail(`expected ${IDS.length} selectable rows, ticked ${ticked}`);
const barCount = await p.textContent("#bulk-count");
/4/.test(barCount || "")
  ? ok(`bulk bar counts the selection ("${barCount.trim()}")`)
  : fail(`bulk bar count wrong: "${barCount}"`);

// ---- Hide ----
await p.click("#bulk-hide");
await p.waitForTimeout(1200);
let bl = await blocklist();
IDS.every((id) => bl.channels[id] && bl.channels[id].hidden)
  ? ok("bulk Hide flags every selected channel hidden (still blocked)")
  : fail("bulk Hide did not set hidden on all: " + JSON.stringify(IDS.map((i) => [i, bl.channels[i] && bl.channels[i].hidden])));
IDS.every((id) => bl.channels[id])
  ? ok("hidden channels are still blocked, not removed")
  : fail("bulk Hide removed entries");

// ---- Video-only mode ----
await reseed();
await selectSeeded();
await p.click("#bulk-videoonly");
await p.waitForTimeout(1200);
bl = await blocklist();
IDS.every((id) => bl.channels[id] && bl.channels[id].mode === "exceptWhitelist")
  ? ok("bulk Video-only switches every selected channel's mode")
  : fail("bulk Video-only failed: " + JSON.stringify(IDS.map((i) => [i, bl.channels[i] && bl.channels[i].mode])));

// ---- Never-block ----
await reseed();
await selectSeeded();
await p.click("#bulk-allow");
await p.waitForTimeout(1500);
bl = await blocklist();
const allow = bl.allowlist || {};
IDS.every((id) => allow[id.toLowerCase()] || allow[id])
  ? ok("bulk Never-block adds every selection to the allow-list")
  : fail("bulk Never-block missed some: " + JSON.stringify(Object.keys(allow)));

// ---- Unblock ----
await reseed();
await selectSeeded();
await p.click("#bulk-unblock");
await p.waitForTimeout(1800);
bl = await blocklist();
IDS.every((id) => !bl.channels[id])
  ? ok("bulk Unblock removes every selected channel")
  : fail("bulk Unblock left some behind: " + JSON.stringify(IDS.filter((i) => bl.channels[i])));

// ...and the removals are undoable, like any other unblock.
const recent = await msg({ type: "GET_RECENT_UNBLOCKS" });
const log = Array.isArray(recent) ? recent : recent && recent.log;
Array.isArray(log) && log.length >= IDS.length
  ? ok(`bulk Unblock is undoable (${log.length} records in the undo log)`)
  : fail(`bulk unblock left no undo trail: ${JSON.stringify(recent).slice(0, 120)}`);

errs.length === 0 ? ok("no options-page errors during bulk actions") : fail(`page error: ${errs[0]}`);

for (const id of IDS) {
  await msg({ type: "UNBLOCK_CHANNEL", id });
  await msg({ type: "DISALLOW_CHANNEL", id });
}
await ctx.close();
