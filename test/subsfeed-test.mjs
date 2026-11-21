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
// Also, while the routes are here: a settled page isn't rescanned every 2 s,
// and an /embed/ player on another site is blanked when its video is blocked.
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
  chrome.storage.local.set({
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
// A removed tile takes its grid slot with it: an outer wrapper left with
// nothing inside is a blank gap in the feed.
const emptySlots = (p, sel) => p.evaluate((sel) => [...document.querySelectorAll(sel)].filter((w) => !w.querySelector('a[href^="/watch"]')).length, sel);
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
const phoneGaps = await emptySlots(phone, "ytm-rich-item-renderer");
phoneGaps === 0 ? ok("…each with its whole grid slot — no empty ytm-rich-item-renderer left") : fail(`${phoneGaps} empty phone grid slot(s) left behind`);

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
const deskGaps = await emptySlots(desk, "ytd-rich-item-renderer");
deskGaps === 0 ? ok("…each with its whole grid slot — no empty ytd-rich-item-renderer left") : fail(`${deskGaps} empty desktop grid slot(s) left behind`);

// ---- the heartbeat, in the real extension ----
// The scrubs ran every 2s for as long as a YouTube tab stayed open. A page
// that has settled now gets none: an href set on a link already there (which
// the observer doesn't see) makes a shelf a Shorts shelf, and it stays until
// the page grows again, which brings the scrubs back.
pages["www.youtube.com/results"] = `<!doctype html><html><body><ytd-app>
  <ytd-rich-shelf-renderer id="probe-shelf"><a href="/watch?v=probevideo1">A shelf</a></ytd-rich-shelf-renderer>
</ytd-app></body></html>`;
const quiet = await ctx.newPage();
await quiet.goto("https://www.youtube.com/results?search_query=probe");
await quiet.waitForTimeout(15000); // past the beats after the page last grew
await quiet.evaluate(() => document.querySelector("#probe-shelf a").setAttribute("href", "/shorts/probeshort1"));
await quiet.waitForTimeout(5000);
const shelfStayed = await quiet.evaluate(() => !!document.getElementById("probe-shelf"));
await quiet.evaluate(() => document.body.append(document.createElement("div")));
await quiet.waitForTimeout(1500);
const shelfGone = await quiet.evaluate(() => !document.getElementById("probe-shelf"));
shelfStayed && shelfGone
  ? ok("a page that has settled isn't rescanned every 2 s (a shelf made a Shorts shelf by an href alone stays), and the next element added brings the scrubs back")
  : fail("heartbeat on a settled page: " + JSON.stringify({ shelfStayed, shelfGone }));

// ---- an embedded player on another site ----
// With "Block embedded videos" on, each /embed/ frame asks the background one
// question (EMBED_BLOCKED) instead of fetching the whole list: the player of
// a blocked channel's video (found through oEmbed, faked here) is blanked,
// another one plays. (A blocked video's own id is stopped earlier, by a
// network rule.)
await sw.evaluate(async () => {
  const { bt_blocklist } = await chrome.storage.local.get("bt_blocklist");
  const bl = bt_blocklist || { channels: {}, videos: {} };
  bl.channels["@embedchan"] = { name: "Embed Chan", ts: Date.now(), updated_at: Date.now(), mode: "full", whitelist: {} };
  await chrome.storage.local.set({ bt_blocklist: bl });
  const { bt_settings } = await chrome.storage.sync.get("bt_settings");
  await chrome.storage.sync.set({ bt_settings: { ...(bt_settings || {}), blockInEmbeds: true } });
});
await ctx.route("https://www.youtube.com/oembed**", (route) => {
  const v = new URL(new URL(route.request().url()).searchParams.get("url")).searchParams.get("v");
  return route.fulfill({
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({ author_url: v === "embedvideo1" ? "https://www.youtube.com/@EmbedChan" : "https://www.youtube.com/@someoneelse" })
  });
});
await ctx.route("https://embedhost.example/**", (route) =>
  route.fulfill({
    status: 200,
    contentType: "text/html",
    body: '<!doctype html><iframe id="a" src="https://www.youtube.com/embed/embedvideo1"></iframe><iframe id="b" src="https://www.youtube.com/embed/embedvideo2"></iframe>'
  })
);
for (const id of ["embedvideo1", "embedvideo2"]) pages[`www.youtube.com/embed/${id}`] = `<!doctype html><html><body><p>player ${id}</p></body></html>`;
const host = await ctx.newPage();
await host.goto("https://embedhost.example/");
await host.waitForTimeout(3000);
const frameText = (id) => host.frameLocator("#" + id).locator("body").textContent();
const [embedA, embedB] = [await frameText("a"), await frameText("b")];
/Blocked by xrntube/.test(embedA) && /player embedvideo2/.test(embedB)
  ? ok("on another site, the embedded player of a blocked channel's video is blanked, and another channel's plays")
  : fail("embeds: " + JSON.stringify({ embedA: embedA.slice(0, 120), embedB: embedB.slice(0, 120) }));

await ctx.close();
console.log("\nDONE");
