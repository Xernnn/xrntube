import { chromium } from "playwright";

// The Subscriptions feed's rules — the age limit, hide watched, hide upcoming —
// through the real extension's DOM scrub, offline: every youtube.com request
// this profile makes is answered with a synthetic page, so content.js runs on
// it exactly as it would on YouTube, with no YouTube code there to upgrade the
// tags (which is what makes real tag names unsafe ON YouTube, and safe here).
//
//   - the phone (m.youtube.com/feed/subscriptions): an old tile, a watched one
//     and an upcoming one go, a recent one stays — and a tile whose date
//     arrives after it was first judged goes too. That last one is the phone's
//     late-hydration re-check: its tags were missing from the re-check list,
//     so a phone tile was judged once, on first render, and kept for good.
//   - the desktop (www.youtube.com/feed/subscriptions): the same rules on
//     lockups, judged by the ytd-browse a tile sits in — the Home page kept
//     hidden in the same document keeps its old tile.
//
// The JSON layer's half of these rules is datalayer-test's; this file is the
// DOM scrub's, which is what catches what that layer can't see.

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ctx = await chromium.launchPersistentContext(`/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`, {
  headless: false,
  viewport: { width: 1200, height: 900 },
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"]
});
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);

const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
await sw.evaluate(() =>
  chrome.storage.sync.set({
    bt_keywords: { list: [], ts: Date.now(), durMinSec: 0, durMaxSec: 0, subsMaxAgeDays: 7, subsHideWatched: true, subsHideUpcoming: true }
  })
);

const pages = {};
await ctx.route(/^https:\/\/(www|m)\.youtube\.com\//, (route) => {
  const u = new URL(route.request().url());
  const body = route.request().resourceType() === "document" ? pages[u.host + u.pathname] : null;
  return body
    ? route.fulfill({ status: 200, contentType: "text/html; charset=utf-8", body })
    : route.fulfill({ status: 404, body: "" });
});

// ---- the phone ----
const phoneTile = (id, { meta, thumb = "" }) => `
  <ytm-rich-item-renderer>
    <ytm-video-with-context-renderer>
      <a href="/watch?v=${id}">${thumb}</a>
      <h3><a href="/watch?v=${id}">Upload ${id}</a></h3>
      <ytm-badge-and-byline-renderer id="meta-${id}"><a href="/@phonechan">Phone Chan</a> · ${meta}</ytm-badge-and-byline-renderer>
    </ytm-video-with-context-renderer>
  </ytm-rich-item-renderer>`;
pages["m.youtube.com/feed/subscriptions"] = `<!doctype html><html><body><div class="rich-grid-renderer-contents">
  ${phoneTile("phoneold001", { meta: "1K views · 3 weeks ago" })}
  ${phoneTile("phonenew001", { meta: "1K views · 1 hour ago" })}
  ${phoneTile("phonewatch1", {
    meta: "1K views · 2 days ago",
    thumb:
      '<ytm-thumbnail-overlay-resume-playback-renderer><div class="thumbnail-overlay-resume-playback-progress" style="width:100%"></div></ytm-thumbnail-overlay-resume-playback-renderer>'
  })}
  ${phoneTile("phoneupcom1", {
    meta: "12 waiting · Scheduled for 11/7/26, 2:00 PM",
    thumb: '<ytm-thumbnail-overlay-time-status-renderer data-style="UPCOMING"><badge-shape>Upcoming</badge-shape></ytm-thumbnail-overlay-time-status-renderer>'
  })}
  ${phoneTile("phonelate01", { meta: "1K views" })}
</div></body></html>`;

const present = (p, ids) => p.evaluate((list) => list.filter((id) => document.querySelector(`a[href="/watch?v=${id}"]`)), ids);
const PHONE = ["phoneold001", "phonenew001", "phonewatch1", "phoneupcom1", "phonelate01"];
const phone = await ctx.newPage();
await phone.goto("https://m.youtube.com/feed/subscriptions");
await phone.waitForTimeout(2500);
const phoneFirst = await present(phone, PHONE);
JSON.stringify(phoneFirst) === JSON.stringify(["phonenew001", "phonelate01"])
  ? ok("phone Subscriptions: the 3-week-old, the watched and the upcoming tile go; the hour-old one stays, and the undated one waits")
  : fail("phone Subscriptions after load: " + JSON.stringify(phoneFirst));
// The date arrives late, as YouTube's lazily-rendered metadata does.
await phone.evaluate(() => document.getElementById("meta-phonelate01").append(" · 2 weeks ago"));
await phone.waitForTimeout(3500);
const phoneLater = await present(phone, PHONE);
JSON.stringify(phoneLater) === JSON.stringify(["phonenew001"])
  ? ok("…and a phone tile whose date arrives after it was first judged is judged again, and goes")
  : fail("phone late-dated tile: " + JSON.stringify(phoneLater));

// ---- the desktop ----
const lockupTile = (id, { meta, thumb = "" }) => `
  <ytd-rich-item-renderer>
    <yt-lockup-view-model>
      <a href="/watch?v=${id}"><yt-thumbnail-view-model>${thumb}</yt-thumbnail-view-model></a>
      <h3><a href="/watch?v=${id}">Upload ${id}</a></h3>
      <yt-content-metadata-view-model>
        <div><span><a href="/@deskchan">Desk Chan</a></span></div>
        <div><span>${meta}</span></div>
      </yt-content-metadata-view-model>
    </yt-lockup-view-model>
  </ytd-rich-item-renderer>`;
const badge = (text) => `<yt-thumbnail-bottom-overlay-view-model><badge-shape><div>${text}</div></badge-shape></yt-thumbnail-bottom-overlay-view-model>`;
pages["www.youtube.com/feed/subscriptions"] = `<!doctype html><html><body><ytd-app><ytd-page-manager>
  <ytd-browse page-subtype="home" hidden>
    ${lockupTile("homeold0001", { meta: "1K views • 3 weeks ago", thumb: badge("12:04") })}
  </ytd-browse>
  <ytd-browse page-subtype="subscriptions">
    ${lockupTile("deskold0001", { meta: "1K views • 3 weeks ago", thumb: badge("12:04") })}
    ${lockupTile("desknew0001", { meta: "1K views • 3 hours ago", thumb: badge("12:04") })}
    ${lockupTile("deskwatch01", {
      meta: "1K views • 1 day ago",
      thumb:
        badge("12:04") +
        '<yt-thumbnail-overlay-progress-bar-view-model><div class="ytThumbnailOverlayProgressBarHostWatchedProgressBar">' +
        '<div class="ytThumbnailOverlayProgressBarHostWatchedProgressBarSegment" style="width: 100%;"></div></div></yt-thumbnail-overlay-progress-bar-view-model>'
    })}
    ${lockupTile("deskupcom01", { meta: "12 waiting • Scheduled for 11/7/26, 2:00 PM", thumb: badge("Upcoming") })}
    ${lockupTile("desklive001", { meta: "312 watching", thumb: badge("LIVE") })}
  </ytd-browse>
</ytd-page-manager></ytd-app></body></html>`;
const DESK = ["homeold0001", "deskold0001", "desknew0001", "deskwatch01", "deskupcom01", "desklive001"];
const desk = await ctx.newPage();
await desk.goto("https://www.youtube.com/feed/subscriptions");
await desk.waitForTimeout(3000);
const deskLeft = await present(desk, DESK);
JSON.stringify(deskLeft) === JSON.stringify(["homeold0001", "desknew0001", "desklive001"])
  ? ok("desktop Subscriptions lockups: old, watched and upcoming go; recent and live stay — and the hidden Home page's old tile stays")
  : fail("desktop Subscriptions: " + JSON.stringify(deskLeft));

await ctx.close();
console.log("\nDONE");
