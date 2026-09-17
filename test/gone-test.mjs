import { chromium } from "playwright";

// A channel that no longer exists.
//
// Deleted, terminated, or simply renamed (its old @handle now 404s) — the page
// is permanently unfetchable. Every non-OK response used to record *nothing*,
// which meant the auto-fetch asked again on every single options-page open,
// forever, and the row sat in "No sub count" looking like it just hadn't
// loaded yet. The attempt has to be recorded exactly once, and it must be
// visible in the row why there is no number.
//
// The other half is what must NOT happen: a 5xx or a network error is worth
// retrying, so those still record nothing. That half can't be provoked against
// live YouTube, so the assertion here is the shape of what a 404 writes.

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
// One 404s outright; the other is a UC id naming no channel, which YouTube
// serves as a 200 with an error alert and no channel header. Both are gone.
const GONE = ["@bt-gone-channel-test-99182734", "UCzzzzzzzzzzzzzzzzzzzzzz"];
const ALIVE = "@mkbhd";
const REVIVED = "@veritasium"; // alive, but seeded as if a past sweep had 404d it

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
const optionsUrl = `chrome-extension://${extId}/options/options.html`;

const p = await ctx.newPage();
await p.goto(optionsUrl);
const send = (m) => p.evaluate((mm) => new Promise((r) => chrome.runtime.sendMessage(mm, r)), m);
const blocklist = () => send({ type: "GET_BLOCKLIST" });

const channels = {};
for (const id of GONE) channels[id] = { name: id, ts: Date.now() };
channels[ALIVE] = { name: ALIVE, ts: Date.now() };
// Seeded already-gone: an import must carry the flag (so a restored backup
// doesn't queue every dead channel again), and a later scrape must clear it.
const SUBS_V = await p.evaluate(() => self.BlockTube.SUBS_SCRAPE_VERSION);
channels[REVIVED] = {
  name: REVIVED,
  ts: Date.now(),
  subs: "n/a",
  subsAt: Date.now(),
  subsV: SUBS_V, // already swept by the current scrape: the auto-fetch must skip it
  gone: true
};
await send({ type: "IMPORT_BLOCKLIST", channels, videos: {} });

// Reopen: the auto-fetch fires on open and is the thing under test.
await p.reload();
await p.waitForTimeout(15000);

const after = (await blocklist()).channels;
const bad = GONE.filter((id) => !(after[id] || {}).gone);
bad.length === 0
  ? ok(`a 404 channel is recorded as gone (${GONE.join(", ")})`)
  : fail(`not marked gone: ${bad.join(", ")}`);

const noAttempt = GONE.filter((id) => !(after[id] || {}).subsAt);
noAttempt.length === 0
  ? ok("the attempt is recorded (subsAt), so it isn't asked again")
  : fail(`no subsAt recorded for ${noAttempt.join(", ")} — it will be retried forever`);

GONE.every((id) => (after[id] || {}).subs === "n/a")
  ? ok('its count reads "n/a" rather than staying blank')
  : fail(`subs is ${GONE.map((id) => JSON.stringify((after[id] || {}).subs)).join(", ")}`);

(after[ALIVE] || {}).subs && !(after[ALIVE] || {}).gone
  ? ok(`a live channel in the same sweep is unaffected (${after[ALIVE].subs})`)
  : fail(`the live channel came back subs=${(after[ALIVE] || {}).subs} gone=${(after[ALIVE] || {}).gone}`);

// The row has to say so — a blank chip is indistinguishable from "not loaded".
await p.selectOption("#filter-by", "nosubs");
await p.waitForTimeout(800);
const tagged = await p.$$eval("#channel-list .gone-tag", (els) => els.length);
tagged >= GONE.length
  ? ok(`the row is tagged "gone" (${tagged} rows)`)
  : fail(`expected ${GONE.length} rows tagged gone, found ${tagged}`);

// Reopening must not start another sweep: every entry has now been attempted.
const p2 = await ctx.newPage();
await p2.goto(optionsUrl);
await p2.waitForTimeout(4000);
const quiet = (await p2.$eval("#bulk-progress", (e) => e.hidden)) && (await p2.$eval("#fetch-all-subs-btn", (e) => e.hidden));
quiet
  ? ok("reopening asks for nothing — the dead channels are not retried")
  : fail("a fetch started again on reopen; the gone entries are still being retried");

// It can come back: an entry flagged gone that resolves again drops the flag.
const seeded = (await blocklist()).channels[REVIVED] || {};
seeded.gone
  ? ok("an import carries the gone flag instead of re-queueing the channel")
  : fail("the imported gone flag was dropped — the channel goes back in the fetch queue");

await p.evaluate(
  (id) => new Promise((r) => chrome.runtime.sendMessage({ type: "BULK_FETCH_CHANNEL_INFO", ids: [id] }, r)),
  REVIVED
);
await p.waitForTimeout(2000);
const back = (await blocklist()).channels[REVIVED] || {};
!back.gone && back.subs && back.subs !== "n/a"
  ? ok(`a channel that resolves again is not left flagged (${back.subs})`)
  : fail(`re-fetch left gone=${back.gone} subs=${back.subs}`);

await ctx.close();
