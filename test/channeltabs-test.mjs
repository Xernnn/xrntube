import { chromium } from "playwright";

// The channel-page switches: one per tab (Shorts / Shows / Store / Posts
// (Community) / Podcasts), plus the "Join" button and the membership *price
// offer* beside it. Each is its own leaf in SETTING_GROUPS, so this also
// checks they apply independently rather than as one coarse group.
//
// Tabs are `yt-tab-shape` elements with nothing to identify them but their
// visible label, and the modern header's Join button is a bare
// `button-view-model` with no membership-specific tag or id — both are text
// matching (see LABELS_BY_LANG), so both need a live page to be worth
// anything. Both render signed-out, so both are directly asserted here.
//
// The price offer's real markup is the one part that isn't: it needs an
// account with the channel's membership on offer. So the matcher is exercised
// against synthetic strings injected into the real action row — split across
// spans the way YouTube renders it — alongside the real video titles
// containing prices ("… $5,000 Ultimate Tech Upgrade") that it must NOT
// touch. That pairing is the point: a loose currency match would pass the
// first half and silently eat the second.

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CHANNEL = "https://www.youtube.com/@LinusTechTips";

const ctx = await chromium.launchPersistentContext(`/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
  viewport: { width: 1500, height: 1000 }
});
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);

const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
const extId = sw.url().split("/")[2];
const ext = await ctx.newPage();
await ext.goto(`chrome-extension://${extId}/options/options.html`);
const setSettings = (patch) =>
  ext.evaluate(
    (p) =>
      new Promise((r) =>
        chrome.storage.sync.get(["bt_settings"], (d) =>
          chrome.storage.sync.set({ bt_settings: { ...(d.bt_settings || {}), ...p } }, r)
        )
      ),
    patch
  );

const page = await ctx.newPage();
const tabs = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("yt-tab-shape, tp-yt-paper-tab, [role='tab']")]
      .map((t) => (t.textContent || "").trim())
      .filter(Boolean)
  );
const load = async (url, ms = 9000) => {
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.waitForTimeout(ms);
};

const TAB_KEYS = ["tabPosts", "tabShows", "tabPodcasts", "tabStore", "shortsChannelTab"];
const MEMBER_KEYS = ["joinButton", "membershipPrices", "membersOnlyTiles", "membershipTab"];
const all = (keys, v) => Object.fromEntries(keys.map((k) => [k, v]));

const HIDDEN = ["Shorts", "Shows", "Store", "Posts", "Community", "Podcasts"];
const KEPT = ["Home", "Videos", "Playlists"];

await load(CHANNEL);
const on = await tabs();
if (!on.length) {
  fail("no channel tabs found at all — YouTube's tab markup changed (yt-tab-shape)");
  await ctx.close();
  process.exit();
}
HIDDEN.every((t) => !on.includes(t))
  ? ok(`Shorts / Shows / Store / Posts / Podcasts gone from the channel page (left: ${on.join(", ")})`)
  : fail(`tabs still present: ${on.filter((t) => HIDDEN.includes(t)).join(", ")}`);
KEPT.every((t) => on.includes(t))
  ? ok("Home / Videos / Playlists survive")
  : fail(`a tab that must stay was removed — left: ${on.join(", ")}`);

// Off = back to YouTube's own tab strip.
await setSettings(all(TAB_KEYS, false));
await page.waitForTimeout(1200);
await load(CHANNEL);
const off = await tabs();
["Shows", "Store", "Posts", "Shorts", "Podcasts"].every((t) => off.includes(t))
  ? ok("turning the tab switches off restores every tab")
  : fail(`toggle off did not restore the tabs: ${off.join(", ")}`);

// Every tab is independent now: turning the Shorts tab back on must not drag
// the others with it, and must not depend on the Shorts player/feed switches.
await setSettings({ ...all(TAB_KEYS, false), shortsChannelTab: true, shortsPlayer: false, shortsFeedTiles: false });
await page.waitForTimeout(1200);
await load(CHANNEL);
const rs = await tabs();
!rs.includes("Shorts") && rs.includes("Shows") && rs.includes("Store")
  ? ok("each tab is its own switch: Shorts gone, Shows/Store left visible")
  : fail(`per-tab switches did not apply independently: ${rs.join(", ")}`);

// ---- the "Join" button ----
// The modern channel header renders Join as a plain `button-view-model` in
// `yt-flexible-actions-view-model` — no membership-specific tag or id — so the
// CSS layer's #sponsor-button / ytd-sponsor-button-renderer selectors miss it
// entirely and it stayed on the page (with its price offer) until it was
// matched by label. It renders signed-out, so this is directly testable.
const headerJoins = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("yt-page-header-renderer button, yt-flexible-actions-view-model button")]
      .map((b) => ({ t: (b.textContent || "").trim().slice(0, 20), aria: b.getAttribute("aria-label") }))
      .filter((b) => /^join/i.test(b.t) || /^join/i.test(b.aria || ""))
  );
const subscribePresent = () =>
  page.evaluate(() =>
    [...document.querySelectorAll("yt-page-header-renderer button")].some((b) => /^subscribe/i.test((b.textContent || "").trim()))
  );

await setSettings({ ...all(TAB_KEYS, true), ...all(MEMBER_KEYS, true) });
await page.waitForTimeout(1200);
await load(CHANNEL);
(await headerJoins()).length === 0
  ? ok("Join button removed from the modern channel header")
  : fail(`Join button survived: ${JSON.stringify(await headerJoins())}`);
(await subscribePresent())
  ? ok("Subscribe button is left alone")
  : fail("the Join scrub also removed Subscribe — the label match is too loose");

await setSettings(all(MEMBER_KEYS, false));
await page.waitForTimeout(1200);
await load(CHANNEL);
(await headerJoins()).length > 0
  ? ok("turning the Join switch off restores the button")
  : fail("Join button did not come back when its switch was turned off");
await setSettings(all(MEMBER_KEYS, true));
await page.waitForTimeout(1200);

// ---- membership price offers ----
await setSettings({ ...all(TAB_KEYS, true), ...all(MEMBER_KEYS, true) });
await page.waitForTimeout(1200);
await load(`${CHANNEL}/videos`, 10000);

const pricyTitles = await page.evaluate(() =>
  [...document.querySelectorAll("#video-title, a.ytLockupMetadataViewModelTitle")]
    .map((e) => (e.textContent || "").trim())
    .filter((t) => /[$€£]\s?\d/.test(t))
);
pricyTitles.length > 0
  ? ok(`${pricyTitles.length} video titles containing prices left alone`)
  : console.log("ok: (skipped) no price-containing video titles on the page to check against");

const verdict = await page.evaluate(() => {
  const host = document.querySelector("yt-flexible-actions-view-model") || document.body;
  // Split across spans, as YouTube renders it — a leaf-only matcher sees
  // "A$7.49" and "/mo" separately and matches neither.
  const add = (t) => {
    const el = document.createElement("div");
    el.className = "ytFlexibleActionsViewModelAction";
    for (const part of String(t).split("|")) {
      const s = document.createElement("span");
      s.textContent = part;
      el.appendChild(s);
    }
    host.appendChild(el);
    return el;
  };
  const kill = ["A$0| for 1st month", "A$7.49|/mo", "Join |A$7.49|/mo", "$4.99 / month", "€3,99/Monat"];
  const keep = ["Why are people spending $1,000 for old iPods", "AMD $5,000 Ultimate Tech Upgrade", "$5 Wireless Earbuds", "1st month free"];
  const nodes = [...kill, ...keep].map(add);
  // the extras scrub is throttled (~400ms) with a 2s heartbeat behind it
  return new Promise((r) =>
    setTimeout(
      () =>
        r({
          missed: kill.map((k) => k.replace(/\|/g, "")).filter((_, i) => nodes[i].isConnected),
          wronglyRemoved: keep.filter((_, i) => !nodes[kill.length + i].isConnected)
        }),
      3000
    )
  );
});
verdict.missed.length === 0
  ? ok("membership price offers removed")
  : fail(`price offers left on the page: ${verdict.missed.join(" | ")}`);
verdict.wronglyRemoved.length === 0
  ? ok("price-shaped text that is NOT an offer is left alone")
  : fail(`the price scrub removed innocent text: ${verdict.wronglyRemoved.join(" | ")}`);

await ctx.close();
