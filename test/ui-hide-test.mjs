import { chromium } from "playwright";

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ctx = await chromium.launchPersistentContext(`/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const ok = (m) => console.log("ok:", m);

let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }));
const extId = sw.url().split("/")[2];

const opt = await ctx.newPage();
await opt.goto(`chrome-extension://${extId}/options/options.html`);
await opt.waitForLoadState("domcontentloaded");
await opt.waitForTimeout(300);
await opt.locator(".page-tab[data-page='settings']").click();
await opt.waitForTimeout(150);

// Every leaf except blockInEmbeds ships on (it is opt-in).
const n = await opt.locator("#settings-list .switch input:checked").count();
n === 38 ? ok("38 of 39 toggles on by default (blockInEmbeds is opt-in)") : fail(`checked toggles: ${n}`);

const setToggle = async (key, on) => {
  // A key may name one switch or several — the coarse toggles this suite used
  // to flip are now groups of per-element switches (see SETTING_GROUPS).
  for (const k of [].concat(key)) {
    const cb = opt.locator(`#settings-list .switch[data-key="${k}"] input`);
    if ((await cb.isChecked()) !== on) await opt.locator(`#settings-list .switch[data-key="${k}"] .slider`).click();
    await opt.waitForFunction(
      ([kk, v]) => chrome.storage.sync.get("bt_settings").then((r) => r.bt_settings && r.bt_settings[kk] === v),
      [k, on],
      { timeout: 3000 }
    );
  }
};

// ---- 1. voice search button (masthead, works signed out) ----
const yt = await ctx.newPage();
await yt.goto("https://www.youtube.com/feed/subscriptions", { waitUntil: "domcontentloaded" });
await yt.waitForTimeout(6000);
const voiceOn = await yt.evaluate(() => {
  const el = document.querySelector("#voice-search-button");
  return { exists: !!el, display: el ? getComputedStyle(el).display : null };
});
(voiceOn.exists && voiceOn.display === "none")
  ? ok("voice-search button hidden by default")
  : fail("voice-search not hidden: " + JSON.stringify(voiceOn));

await setToggle("hideVoiceSearch", false);
await yt.reload({ waitUntil: "domcontentloaded" });
await yt.waitForTimeout(6000);
const voiceOff = await yt.evaluate(() => {
  const el = document.querySelector("#voice-search-button");
  return el ? getComputedStyle(el).display : "(gone)";
});
voiceOff !== "none" ? ok(`toggle off -> voice-search visible again (${voiceOff})`) : fail("still hidden after toggle off");
await setToggle("hideVoiceSearch", true);
await yt.close();

// ---- 2. account-button CSS rule present/absent (visual needs a signed-in acct) ----
const styleHas = async (needle) => {
  const p = await ctx.newPage();
  await p.goto("https://www.youtube.com/feed/subscriptions", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(4000);
  const r = await p.evaluate((nd) => {
    const s = document.getElementById("bt-instant-hide");
    return !!s && s.textContent.includes(nd);
  }, needle);
  await p.close();
  return r;
};
(await styleHas("#avatar-btn")) ? ok("account-button hover CSS present by default") : fail("avatar-btn rule missing");
await setToggle("accountButtonOnHover", false);
!(await styleHas("#avatar-btn")) ? ok("toggle off -> avatar-btn rule dropped") : fail("avatar rule still there");
await setToggle("accountButtonOnHover", true);

// ---- 3. video action buttons on a watch page ----
const w = await ctx.newPage();
await w.goto("https://www.youtube.com/watch?v=aqz-KE-bpKQ", { waitUntil: "domcontentloaded" });
await w.waitForTimeout(8000);
const actOn = await w.evaluate(() => {
  const scope = document.querySelector("ytd-watch-metadata #actions");
  if (!scope) return { noScope: true };
  const q = (label) => {
    const els = [...scope.querySelectorAll("[aria-label]")].filter((e) => (e.getAttribute("aria-label") || "").toLowerCase() === label);
    return els.filter((e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2; }).length;
  };
  return {
    share: q("share"),
    save: q("save to playlist"),
    download: q("download"),
    more: q("more actions"),
    likeStillThere: [...scope.querySelectorAll("[aria-label]")].some((e) => /like this video/i.test(e.getAttribute("aria-label") || "")),
  };
});
console.log("   watch actions (ON):", JSON.stringify(actOn));
(actOn.share === 0 && actOn.save === 0 && actOn.download === 0 && actOn.more === 0 && actOn.likeStillThere)
  ? ok("Share/Save/Download/More gone from the watch action row; Like kept")
  : fail("video actions not fully hidden: " + JSON.stringify(actOn));

await setToggle(["actionShare", "actionSave", "actionDownload", "actionClip", "actionThanks", "actionMore"], false);
await w.reload({ waitUntil: "domcontentloaded" });
await w.waitForTimeout(8000);
const actOff = await w.evaluate(() => {
  const scope = document.querySelector("ytd-watch-metadata #actions");
  const q = (label) => [...scope.querySelectorAll("[aria-label]")].filter((e) => (e.getAttribute("aria-label") || "").toLowerCase() === label).filter((e) => { const r = e.getBoundingClientRect(); return r.width > 2 && r.height > 2; }).length;
  return { share: q("share"), more: q("more actions") };
});
console.log("   watch actions (OFF):", JSON.stringify(actOff));
(actOff.share > 0 && actOff.more > 0) ? ok("toggle off -> Share + More back") : fail("actions not restored: " + JSON.stringify(actOff));
await w.close();

// ---- 4. the "Ask YouTube" AI button beside the search box ----
// Only served to signed-in sessions, so like the account button above this
// checks the rule is present/absent — and then, because "present" is not
// "matches", applies it to the markup YouTube actually ships for that button.
// Its own classes are the generic ytSpecButtonShapeNext* set every button on
// the site carries; `you-chat-entrypoint-button` on the wrapper is the only
// hook specific to it.
(await styleHas("you-chat-entrypoint-button"))
  ? ok("Ask-YouTube rule present by default")
  : fail("you-chat-entrypoint-button rule missing");

const askPage = await ctx.newPage();
await askPage.goto("https://www.youtube.com/feed/subscriptions", { waitUntil: "domcontentloaded" });
await askPage.waitForTimeout(5000);
// Built with DOM calls, not innerHTML: youtube.com enforces Trusted Types.
// Nothing here relies on a custom element keeping its children, so the
// "don't build fixtures from real tag names" hazard doesn't apply — each
// assertion is on the element's own computed display.
const mkProbe = () =>
  askPage.evaluate(() => {
    document.getElementById("bt-ask-probe")?.remove();
    const mk = (tag, cls, label) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (label) e.setAttribute("aria-label", label);
      return e;
    };
    const host = mk("div");
    host.id = "bt-ask-probe";
    const bare = mk("button", "ytSpecButtonShapeNextHost ytSpecButtonShapeNextTonal", "Ask YouTube");
    const wrap = mk("button-view-model", "ytSpecButtonViewModelHost style-scope ytd-menu-renderer you-chat-entrypoint-button");
    const other = mk("button", "ytSpecButtonShapeNextHost", "Settings");
    host.append(bare, wrap, other);
    (document.querySelector("ytd-masthead") || document.body).appendChild(host);
    const d = (e) => getComputedStyle(e).display;
    return { bare: d(bare), wrap: d(wrap), other: d(other) };
  });

const askOn = await mkProbe();
askOn.bare === "none" && askOn.wrap === "none"
  ? ok("both Ask button shapes hidden (label fallback + you-chat wrapper)")
  : fail(`Ask button not hidden: ${JSON.stringify(askOn)}`);
askOn.other !== "none"
  ? ok("an ordinary masthead button is untouched")
  : fail("the rule is hiding unrelated masthead buttons");

await setToggle("hideAskYouTube", false);
await askPage.reload({ waitUntil: "domcontentloaded" });
await askPage.waitForTimeout(5000);
const askOff = await mkProbe();
askOff.bare !== "none" && askOff.wrap !== "none"
  ? ok("toggle off -> Ask button visible again")
  : fail(`still hidden after toggle off: ${JSON.stringify(askOff)}`);
await setToggle("hideAskYouTube", true);

// The same feature's other surface: an "Ask" section inside a video's
// description. Hiding only the button would leave its heading and blurb.
// Checked alongside the channel-card section that sits right next to it,
// which is NOT part of this and must not be caught by the AI rule.
const secOn = await askPage.evaluate(() => {
  document.getElementById("bt-sec-probe")?.remove();
  const mk = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  const host = mk("div"); host.id = "bt-sec-probe";
  const sec = mk("yt-video-description-youchat-section-view-model", "ytVideoDescriptionYouchatSectionViewModelHost");
  const cards = mk("ytd-video-description-infocards-section-renderer", "style-scope ytd-structured-description-content-renderer");
  host.append(sec, cards);
  document.body.appendChild(host);
  return { ai: getComputedStyle(sec).display, cards: getComputedStyle(cards).display };
});
secOn.ai === "none" ? ok("description \u201cAsk\u201d section hidden") : fail(`Ask section: ${secOn.ai}`);
secOn.cards === "none"
  ? ok("description channel card hidden (its own toggle)")
  : fail(`channel card not hidden: ${secOn.cards}`);

// …and that the channel card answers to its OWN switch, not the AI one.
await setToggle("descriptionInfocards", false);
await askPage.reload({ waitUntil: "domcontentloaded" });
await askPage.waitForTimeout(5000);
const secOff = await askPage.evaluate(() => {
  const mk = (tag, cls) => { const e = document.createElement(tag); if (cls) e.className = cls; return e; };
  const host = mk("div"); host.id = "bt-sec-probe2";
  const sec = mk("yt-video-description-youchat-section-view-model", "ytVideoDescriptionYouchatSectionViewModelHost");
  const cards = mk("ytd-video-description-infocards-section-renderer");
  host.append(sec, cards);
  document.body.appendChild(host);
  return { ai: getComputedStyle(sec).display, cards: getComputedStyle(cards).display };
});
secOff.cards !== "none" && secOff.ai === "none"
  ? ok("channel-card toggle off -> card back, Ask section still hidden")
  : fail(`toggles are not independent: ${JSON.stringify(secOff)}`);
await setToggle("descriptionInfocards", true);

// The AI video summary folded into a search result. The host element is the
// same one a watch page uses for chapters, so what marks a summary — the
// `has-video-summary` attribute, or the summary view model inside — is what
// the rule has to key off. That part is checked as a *selector*, in an inert
// document, because `ytd-expandable-metadata-renderer` is a real registered
// element: appending one to youtube.com upgrades it, and the upgrade drops
// the attribute and wipes the children before any computed style can be read
// (confirmed: both probes came back `flex` with the rule live and matching).
// The selector is read back out of the injected sheet, so this tests the rule
// that actually ships rather than a copy of it.
const sumSel = await askPage.evaluate(() => {
  const sheet = [...document.styleSheets].find((s) => s.ownerNode && s.ownerNode.id === "bt-instant-hide");
  const rule = sheet && [...sheet.cssRules].find((r) => r.selectorText && r.selectorText.includes("has-video-summary"));
  if (!rule) return null;
  const doc = document.implementation.createHTMLDocument("");
  const mk = (tag, attrs) => {
    const e = doc.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) e.setAttribute(k, v);
    doc.body.appendChild(e);
    return e;
  };
  const byAttr = mk("ytd-expandable-metadata-renderer", { "has-video-summary": "" });
  const byChild = mk("ytd-expandable-metadata-renderer");
  byChild.appendChild(doc.createElement("video-summary-content-view-model"));
  const chapters = mk("ytd-expandable-metadata-renderer");
  const m = (e) => e.matches(rule.selectorText);
  return { byAttr: m(byAttr), byChild: m(byChild), chapters: m(chapters) };
});
sumSel && sumSel.byAttr && sumSel.byChild
  ? ok("AI summary rule matches both shapes (attribute + inner view model)")
  : fail(`summary rule does not match: ${JSON.stringify(sumSel)}`);
sumSel && !sumSel.chapters
  ? ok("...and not a chapters card in the same element")
  : fail("the summary rule also matches chapters");

// The view model itself is not a registered element, so it survives being
// appended and can be checked the ordinary way, on and off.
const sumDisplay = () =>
  askPage.evaluate(() => {
    document.getElementById("bt-sum-probe")?.remove();
    const host = document.createElement("div");
    host.id = "bt-sum-probe";
    host.appendChild(document.createElement("video-summary-content-view-model"));
    document.body.appendChild(host);
    return getComputedStyle(host.firstChild).display;
  });
(await sumDisplay()) === "none"
  ? ok("summary view model hidden")
  : fail("summary view model still showing");

await setToggle("hideVideoSummaries", false);
await askPage.reload({ waitUntil: "domcontentloaded" });
await askPage.waitForTimeout(5000);
(await sumDisplay()) !== "none"
  ? ok("toggle off -> AI summary visible again")
  : fail("summary still hidden after toggle off");
await setToggle("hideVideoSummaries", true);

await askPage.close();

// ---- auto-generated chapters ----
// Creator and AI chapters render as the same elements, so this reads what the
// page was given: the AUTO_CHAPTERS markers and the auto panel must be gone,
// a creator's DESCRIPTION_CHAPTERS must stay. The lecture has carried
// machine-made chapters (and no creator ones) for years; if the control
// below fails, YouTube changed that video — pick another whose Chapters panel
// says "These chapters are auto-generated".
const AUTO_VID = "kBdfcR-8hEY";
const CREATOR_VID = "adQyLViK_ZU";
const chapPage = await ctx.newPage();
const chapterState = async (id) => {
  await chapPage.goto(`https://www.youtube.com/watch?v=${id}`, { waitUntil: "domcontentloaded" });
  await chapPage.waitForTimeout(7000);
  return chapPage.evaluate(() => {
    const s = JSON.stringify(window.ytInitialData || {});
    return {
      auto: s.includes("AUTO_CHAPTERS") || s.includes("engagement-panel-macro-markers-auto-chapters"),
      creator: s.includes("DESCRIPTION_CHAPTERS"),
      panel: !!document.querySelector('ytd-engagement-panel-section-list-renderer[target-id="engagement-panel-macro-markers-auto-chapters"]')
    };
  });
};
await setToggle("hideAutoChapters", false);
let chap = await chapterState(AUTO_VID);
chap.auto
  ? ok("control: with the switch off, the lecture carries auto chapters")
  : fail(`${AUTO_VID} no longer has auto chapters — pick another fixture video`);
await setToggle("hideAutoChapters", true);
chap = await chapterState(AUTO_VID);
!chap.auto && !chap.panel
  ? ok("switch on: auto chapters gone from the page data and the DOM")
  : fail("auto chapters survived: " + JSON.stringify(chap));
chap = await chapterState(CREATOR_VID);
chap.creator
  ? ok("switch on: a creator's own chapters are kept")
  : fail("creator chapters were removed: " + JSON.stringify(chap));

// ---- picture-in-picture button ----
// YouTube's own button, shipped hidden in every player. The switch shows it;
// clicking it must actually pop the video out, and again must bring it back.
const pipShown = () =>
  chapPage.evaluate(() => {
    const b = document.querySelector("ytd-watch-flexy #movie_player .ytp-pip-button");
    return !!b && getComputedStyle(b).display !== "none";
  });
await chapPage.goto(`https://www.youtube.com/watch?v=${CREATOR_VID}`, { waitUntil: "domcontentloaded" });
await chapPage.waitForTimeout(7000);
(await pipShown()) ? ok("picture-in-picture button shown in the player") : fail("no visible .ytp-pip-button");
await chapPage.click("ytd-watch-flexy #movie_player .ytp-pip-button", { force: true });
await chapPage.waitForTimeout(1200);
const inPip = await chapPage.evaluate(() => document.pictureInPictureElement && document.pictureInPictureElement.tagName);
await chapPage.click("ytd-watch-flexy #movie_player .ytp-pip-button", { force: true });
await chapPage.waitForTimeout(800);
const outPip = await chapPage.evaluate(() => !document.pictureInPictureElement);
inPip === "VIDEO" && outPip
  ? ok("clicking it pops the video out, and clicking again brings it back")
  : fail(`picture-in-picture didn't toggle: in=${inPip} out=${outPip}`);
await setToggle("pipButton", false);
await chapPage.waitForTimeout(500);
!(await pipShown()) ? ok("switch off: the button is hidden again, as YouTube ships it") : fail("button still shown with the switch off");
await setToggle("pipButton", true);
await chapPage.close();

await ctx.close();
console.log("\nDONE");
