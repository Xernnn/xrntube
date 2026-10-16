import { chromium } from "playwright";

// The sweep: channel lookups queued to the background (START_SWEEP), where
// they keep going after the options page closes, and where throttling pauses
// the queue instead of dropping channels from it.
//
// Live: the lookups fetch real channel pages. Throttling is faked by routing
// youtube.com to 429 for the background worker.

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ctx = await chromium.launchPersistentContext(`/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"]
});
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);

const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
const optionsUrl = `chrome-extension://${sw.url().split("/")[2]}/options/options.html`;
const page = async () => {
  const p = await ctx.newPage();
  await p.goto(optionsUrl);
  return p;
};
const send = (p, m) => p.evaluate((mm) => chrome.runtime.sendMessage(mm), m);
const waitIdle = async (p, ms) => {
  const t0 = Date.now();
  for (;;) {
    const { sweep } = await send(p, { type: "GET_SWEEP" });
    if (!sweep.queued) return sweep;
    if (Date.now() - t0 > ms) return sweep;
    await p.waitForTimeout(1000);
  }
};

const IDS = ["UCBJycsmduvYEL83R_U4JriQ", "@veritasium", "UCsXVk37bltHxD1rDPwtNM8Q"];

// ---- 1. it outlives the page that started it ----
let p = await page();
await send(p, { type: "IMPORT_BLOCKLIST", channels: Object.fromEntries(IDS.map((id) => [id, { name: "", mode: "full" }])), videos: {} });
await send(p, { type: "START_SWEEP", ids: IDS, label: "Test" });
await p.close(); // the old in-page loop died right here
await new Promise((r) => setTimeout(r, 1500));
p = await page();
const done = await waitIdle(p, 60000);
const bl = await send(p, { type: "GET_BLOCKLIST" });
const looked = IDS.filter((id) => bl.channels[id] && bl.channels[id].subsAt);
!done.queued && done.finishedAt && looked.length === IDS.length
  ? ok(`a sweep finishes after its page closes (${looked.length}/${IDS.length} looked up, ${done.got} with data)`)
  : fail(`sweep after close: ${JSON.stringify(done)} looked=${looked.length}`);
bl.channels["UCBJycsmduvYEL83R_U4JriQ"] && bl.channels["UCBJycsmduvYEL83R_U4JriQ"].handle
  ? ok(`…with real results (${bl.channels["UCBJycsmduvYEL83R_U4JriQ"].handle})`)
  : fail("no handle came back for MKBHD");

// ---- 2. throttling pauses the queue; it never drops or records a channel ----
const THROTTLED = "UC-lHJZR3Gqxm24_Vd_AJ5Yw";
await send(p, { type: "IMPORT_BLOCKLIST", channels: { [THROTTLED]: { name: "", mode: "full" } }, videos: {} });
await ctx.route("https://www.youtube.com/**", (route) => route.fulfill({ status: 429, body: "slow down" }));
await send(p, { type: "START_SWEEP", ids: [THROTTLED], label: "Throttled" });
await p.waitForTimeout(4000);
let { sweep } = await send(p, { type: "GET_SWEEP" });
const entry = (await send(p, { type: "GET_BLOCKLIST" })).channels[THROTTLED];
const routed = sweep.pauseUntil > Date.now();
if (!routed && sweep.queued === 0 && entry && entry.subsAt) {
  console.log("   (the route didn't reach the service worker's fetches — throttle case not exercised)");
} else {
  routed && sweep.queued === 1 && sweep.backoffMs >= 30000
    ? ok(`a 429 pauses the sweep (${Math.round(sweep.backoffMs / 1000)}s) and keeps the channel queued`)
    : fail("throttle handling: " + JSON.stringify(sweep));
  !(entry && entry.subsAt)
    ? ok("…and the throttled channel is not recorded as looked up")
    : fail("a throttled lookup was recorded: " + JSON.stringify(entry));
}
await ctx.unroute("https://www.youtube.com/**");

// ---- 3. Stop empties the queue ----
({ sweep } = await send(p, { type: "STOP_SWEEP" }));
sweep.queued === 0 && sweep.stopped ? ok("Stop empties the queue") : fail("stop: " + JSON.stringify(sweep));

await ctx.close();
console.log("\nDONE");
