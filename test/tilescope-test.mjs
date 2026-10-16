import { readFileSync } from "fs";
import { chromium } from "playwright";

// Which channels does a tile actually *belong* to?
//
// The answer used to be "every channel link anywhere inside it", which is
// wrong on exactly the two surfaces that matter: a search result carries a
// description snippet whose @mentions YouTube linkifies, so a video got
// deleted for *talking about* a blocked channel, and the hover block menu
// offered that channel as though it were the uploader. Upstream BlockTube
// can't hit this because its rules name one exact field per renderer
// (`shortBylineText.runs.navigationEndpoint.browseEndpoint.browseId`); we do
// it through the DOM by scoping to the byline, with a fall back to the whole
// tile so an unknown or unhydrated tile shape behaves exactly as before.
//
// tileChannels() and collectChannelsIn() are lifted straight out of
// content.js, and normalizeChannelKey() out of shared/block-logic.js where
// the MAIN-world page hook reads it from too (the trick contextmenu-test and
// locale-age-test use), so this can't drift from the shipped code without
// failing.
//
// The trees are synthetic but use YouTube's real tag names — safe *only*
// because the page is about:blank. On a real YouTube page those tags get
// upgraded by YouTube's own components and the children are wiped, which is
// why the rest of the suite uses bt-test-* instead.

const src = readFileSync(new URL("../content/content.js", import.meta.url), "utf8");
// normalizeChannelKey lives in shared/ now — both the DOM scrub and the
// MAIN-world page hook resolve a channel key through the same function.
const shared = readFileSync(new URL("../shared/block-logic.js", import.meta.url), "utf8");
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);

const grabFrom = (text, where, re, what) => {
  const m = text.match(re);
  if (!m) throw new Error(`could not find ${what} in ${where}`);
  return m[0];
};
const grabConst = (name, text = src, where = "content.js") =>
  grabFrom(text, where, new RegExp(`\\n  const ${name} = [\\s\\S]*?;\\n`), `const ${name}`);
const grabFn = (name, text = src, where = "content.js") =>
  grabFrom(text, where, new RegExp(`\\n  function ${name}\\([\\s\\S]*?\\n  \\}\\n`), `function ${name}`);

const lifted = [
  grabConst("CHANNEL_HREF_RE", shared, "shared/block-logic.js"),
  grabConst("CHANNEL_CARD_TAGS"),
  grabConst("BYLINE_SEL"),
  grabFn("normalizeChannelKey", shared, "shared/block-logic.js"),
  grabFn("collectChannelsIn"),
  grabFn("collectChannels"),
  grabFn("tileChannels")
].join("\n");

// ...and what KIND of thing a tile is, which rides on the same scoping
// question: extractInfo() decides "video / playlist / channel card", and
// getting that wrong takes a tile out under a rule that was never meant for
// it. The age and duration reads are stubbed — they only run when a rule
// needs them, and they are covered by age-test / duration-test.
const liftedInfo = [
  lifted,
  grabConst("PLAYLIST_TILE_TAGS"),
  // (its value starts on the next line, so grabConst's "= <value>" shape
  // doesn't fit it)
  grabFrom(src, "content.js", /\n  const PLAYLIST_LINK_SEL =[\s\S]*?;\n/, "const PLAYLIST_LINK_SEL"),
  grabConst("VIDEO_ID_FROM_QUERY_RE"),
  grabConst("VIDEO_ID_FROM_SHORTS_RE"),
  grabConst("SHORTS_ITEM_SELECTOR"),
  grabFrom(src, "content.js", /\n  const AGE_SCOPE_SEL = [\s\S]*?;\n/, "const AGE_SCOPE_SEL"),
  // the real date parser, so the age cases below test the shipped one
  grabConst("AGE_UNITS", shared, "shared/block-logic.js"),
  grabConst("MAX_PLAUSIBLE_AGE_DAYS", shared, "shared/block-logic.js"),
  grabFn("plausibleAgeDays", shared, "shared/block-logic.js"),
  grabFn("parseAgeDays", shared, "shared/block-logic.js"),
  `const blockIndex = { anyAgeRule: true };
   const filterRec = { durMinSec: 0, durMaxSec: 0 };
   const readDurationSec = () => null;`,
  grabFn("tileAgeText"),
  grabFn("extractInfo")
].join("\n");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent("<!doctype html><body></body>");
await page.evaluate((code) => {
  // eslint-disable-next-line no-new-func
  window.tileChannels = new Function(`${code}\nreturn tileChannels;`)();
}, lifted);
await page.evaluate((code) => {
  // eslint-disable-next-line no-new-func
  window.extractInfo = new Function(`${code}\nreturn extractInfo;`)();
}, liftedInfo);

// What extractInfo() makes of `html`'s root element.
const infoFor = (html) =>
  page.evaluate((h) => {
    document.body.innerHTML = h;
    const i = window.extractInfo(document.body.firstElementChild);
    return (
      i && {
        videoId: i.videoId,
        isPlaylist: i.isPlaylist,
        isShort: i.isShort,
        ageDays: i.ageDays,
        channels: [...i.channels.keys()]
      }
    );
  }, html);

// Returns the channel keys tileChannels() attributes to `html`'s root element.
const keysFor = (html) =>
  page.evaluate((h) => {
    document.body.innerHTML = h;
    return [...window.tileChannels(document.body.firstElementChild).keys()];
  }, html);

const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const cases = [
  [
    "search result: the uploader is blocked, a @mention in the description is not",
    `<ytd-video-renderer>
       <div id="channel-info"><ytd-channel-name><a href="/@realuploader">Real Uploader</a></ytd-channel-name></div>
       <div class="metadata-snippet-container">as <a href="/@blockedchan">@blockedchan</a> explained</div>
     </ytd-video-renderer>`,
    ["@realuploader"]
  ],
  [
    "collaborators in the byline are all kept; the snippet still isn't",
    `<ytd-video-renderer>
       <div id="channel-info"><a href="/@first">First</a><a href="/@second">Second</a></div>
       <div class="metadata-snippet-container"><a href="/@mentioned">@mentioned</a></div>
     </ytd-video-renderer>`,
    ["@first", "@second"]
  ],
  [
    "#avatar-link is itself the anchor, not a wrapper around one",
    `<ytd-rich-item-renderer>
       <a id="avatar-link" href="/@viaavatar">Via Avatar</a>
       <div class="metadata-snippet-container"><a href="/@mentioned">@mentioned</a></div>
     </ytd-rich-item-renderer>`,
    ["@viaavatar"]
  ],
  [
    "no byline container at all: falls back to the whole tile (no regression)",
    `<ytd-compact-video-renderer><a href="/@someone">Someone</a></ytd-compact-video-renderer>`,
    ["@someone"]
  ],
  [
    "byline present but not hydrated: falls back to the whole tile",
    `<ytd-video-renderer>
       <ytd-channel-name></ytd-channel-name>
       <a href="/@someone">Someone</a>
     </ytd-video-renderer>`,
    ["@someone"]
  ],
  [
    "/channel/UC… byline resolves to the UC key",
    `<ytd-video-renderer>
       <div id="channel-info"><a href="/channel/UCBJycsmduvYEL83R_U4JriQ">X</a></div>
     </ytd-video-renderer>`,
    ["UCBJycsmduvYEL83R_U4JriQ"]
  ],
  [
    "a channel card is all byline",
    `<ytd-channel-renderer><a href="/@thechannel">The Channel</a></ytd-channel-renderer>`,
    ["@thechannel"]
  ],
  [
    // The regression this case exists for: the watch card embeds video rows,
    // and those rows carry yt-content-metadata-view-model — a BYLINE_SEL
    // match. Without the channel-card branch the card would be attributed to
    // whatever channel its first row names, and the channel the card is
    // actually *about* would go unseen.
    "search watch card: attributed to its header channel, not to its video rows",
    `<ytd-universal-watch-card-renderer>
       <ytd-watch-card-rich-header-renderer><a href="/@cardowner">Card Owner</a></ytd-watch-card-rich-header-renderer>
       <ytd-watch-card-compact-video-renderer>
         <yt-content-metadata-view-model><a href="/@rowchannel">Row</a></yt-content-metadata-view-model>
       </ytd-watch-card-compact-video-renderer>
     </ytd-universal-watch-card-renderer>`,
    ["@cardowner", "@rowchannel"]
  ],
  [
    "a lockup's metadata row is a byline; anything outside it is not",
    `<yt-lockup-view-model>
       <div class="yt-lockup-metadata-view-model-wiz__metadata"><a href="/@lockupowner">Owner</a></div>
       <div class="description"><a href="/@mentioned">@mentioned</a></div>
     </yt-lockup-view-model>`,
    ["@lockupowner"]
  ]
];

for (const [name, html, want] of cases) {
  const got = await keysFor(html);
  same(got, want) ? ok(name) : fail(`${name} — expected [${want}], got [${got}]`);
}

// The watch card must name its header channel; the row is incidental but
// harmless (the row is also a tile in its own right and gets judged alone).
const cardKeys = await keysFor(
  `<ytd-universal-watch-card-renderer>
     <ytd-watch-card-rich-header-renderer><a href="/@cardowner">Card Owner</a></ytd-watch-card-rich-header-renderer>
   </ytd-universal-watch-card-renderer>`
);
cardKeys[0] === "@cardowner"
  ? ok("watch card alone resolves to its own channel")
  : fail(`watch card resolved to [${cardKeys}]`);

// ---- a channel card is neither a video nor a playlist ----
// Search's watch card lists the channel's videos AND links its uploads
// playlist ("play all"). Reading either off the card takes the whole card
// out — and a playlist by a blocked channel is blocked in every mode, so a
// video-only block, which exists to keep the channel itself on screen,
// deleted exactly the card that IS the channel.
const cardHtml = `<ytd-universal-watch-card-renderer>
     <ytd-watch-card-rich-header-renderer><a href="/@cardowner">Card Owner</a></ytd-watch-card-rich-header-renderer>
     <a href="/playlist?list=PLaaaaaaaaaaaaaaaaaaaa">Play all</a>
     <ytd-watch-card-compact-video-renderer><a href="/watch?v=abcdefghijk">A video</a></ytd-watch-card-compact-video-renderer>
   </ytd-universal-watch-card-renderer>`;
const cardInfo = await infoFor(cardHtml);
cardInfo && cardInfo.isPlaylist === false
  ? ok("a watch card carrying a “play all” link is not judged as a playlist")
  : fail(`watch card came back as ${JSON.stringify(cardInfo)}`);
cardInfo && cardInfo.videoId === null
  ? ok("…and no video id is read off it either")
  : fail(`watch card took a video id: ${JSON.stringify(cardInfo)}`);

// A playlist card names a video too — and is still a playlist. Measured live:
// a channel whose seasons are playlists renders each one as a lockup whose
// every anchor is `/watch?v=<first episode>&list=PL…`, with no
// `/playlist?list=` link and no type attribute anywhere in the DOM. Reading
// "it names a video, so it is a video" let those cards through, and an age
// rule then kept them permanently (a playlist has no date to compare).
const playlistCardInfo = await infoFor(
  `<yt-lockup-view-model>
     <a href="/watch?v=abcdefghijk&list=PLcccccccccccccccccccc">Season 1</a>
     <div class="yt-lockup-metadata-view-model-wiz__metadata"><a href="/@uploader">Uploader</a></div>
     <yt-thumbnail-overlay-badge-view-model>7 videos</yt-thumbnail-overlay-badge-view-model>
   </yt-lockup-view-model>`
);
playlistCardInfo && playlistCardInfo.isPlaylist === true
  ? ok("a playlist card whose only links are watch?v=…&list= is judged as a playlist")
  : fail(`playlist card came back as ${JSON.stringify(playlistCardInfo)}`);

// A Short is flagged as one, because a Short is the tile that never carries a
// publish date and the age rule has to tell that apart from a date that has
// not hydrated yet.
const shortInfo = await infoFor(
  `<ytd-rich-item-renderer>
     <ytm-shorts-lockup-view-model-v2>
       <a href="/shorts/abcdefghijk">A short</a>
     </ytm-shorts-lockup-view-model-v2>
   </ytd-rich-item-renderer>`
);
shortInfo && shortInfo.isShort === true && shortInfo.videoId === "abcdefghijk"
  ? ok("a Shorts tile is reported as a Short")
  : fail(`shorts tile came back as ${JSON.stringify(shortInfo)}`);
const normalInfo = await infoFor(
  `<ytd-video-renderer><a href="/watch?v=abcdefghijk">A video</a></ytd-video-renderer>`
);
normalInfo && normalInfo.isShort === false
  ? ok("…and an ordinary video tile is not")
  : fail(`ordinary tile came back as ${JSON.stringify(normalInfo)}`);

// ---- the age rule reads the metadata line, not the title ----
// "Apple Silicon Explained in 56 seconds" was, live, the one tile to survive a
// 2-day rule on a channel's Shorts tab: its own title dated it at 56 seconds
// old. Titles like "24 hours with the iPhone" do the same to ordinary videos.
const titledInfo = await infoFor(
  `<ytd-rich-item-renderer>
     <a id="video-title" href="/watch?v=abcdefghijk">Apple Silicon Explained in 56 seconds</a>
     <yt-content-metadata-view-model>2.8M views • 3 weeks ago</yt-content-metadata-view-model>
   </ytd-rich-item-renderer>`
);
titledInfo && Math.round(titledInfo.ageDays) === 21
  ? ok("a tile is dated by its metadata line, not by the numbers in its title")
  : fail(`expected ~21 days, got ${JSON.stringify(titledInfo)}`);

// No metadata line at all: the wide read still happens (unknown tile shapes
// must keep working) — but with the title taken out of it.
const noMetaInfo = await infoFor(
  `<ytd-video-renderer>
     <a id="video-title" href="/watch?v=abcdefghijk">Explained in 56 seconds</a>
     <span>2 years ago</span>
   </ytd-video-renderer>`
);
noMetaInfo && Math.round(noMetaInfo.ageDays) === 730
  ? ok("…and a tile with no metadata line is read wide, minus its title")
  : fail(`expected ~730 days, got ${JSON.stringify(noMetaInfo)}`);

// A Short's subhead is a view count and never a date, so it must come back
// unknown — that is what makes isShort the deciding fact.
const shortAge = await infoFor(
  `<ytd-rich-item-renderer>
     <ytm-shorts-lockup-view-model-v2>
       <a href="/shorts/abcdefghijk">Apple Silicon Explained in 56 seconds</a>
       <div class="shortsLockupViewModelHostMetadataSubhead">2.8M views</div>
     </ytm-shorts-lockup-view-model-v2>
   </ytd-rich-item-renderer>`
);
shortAge && shortAge.ageDays === null && shortAge.isShort === true
  ? ok("a Short reports no age at all, whatever its title says")
  : fail(`short reported ${JSON.stringify(shortAge)}`);

// The same link on something that really is a playlist tile must still count,
// or the playlist rule stops working everywhere.
const plInfo = await infoFor(
  `<ytd-playlist-renderer>
     <ytd-channel-name><a href="/@plowner">PL Owner</a></ytd-channel-name>
     <a href="/playlist?list=PLbbbbbbbbbbbbbbbbbbbb">A playlist</a>
   </ytd-playlist-renderer>`
);
plInfo && plInfo.isPlaylist === true
  ? ok("a real playlist tile is still judged as a playlist")
  : fail(`playlist tile came back as ${JSON.stringify(plInfo)}`);

await browser.close();
console.log("\nDONE");
