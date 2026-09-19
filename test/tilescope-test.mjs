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
// tileChannels() + collectChannelsIn() + normalizeChannelKey() are lifted
// straight out of content.js (the trick contextmenu-test and locale-age-test
// use) so this can't drift from the shipped code without failing.
//
// The trees are synthetic but use YouTube's real tag names — safe *only*
// because the page is about:blank. On a real YouTube page those tags get
// upgraded by YouTube's own components and the children are wiped, which is
// why the rest of the suite uses bt-test-* instead.

const src = readFileSync(new URL("../content/content.js", import.meta.url), "utf8");
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);

const grabConst = (name) => {
  const m = src.match(new RegExp(`\\n  const ${name} = [\\s\\S]*?;\\n`));
  if (!m) throw new Error(`could not find const ${name} in content.js`);
  return m[0];
};
const grabFn = (name) => {
  const m = src.match(new RegExp(`\\n  function ${name}\\([\\s\\S]*?\\n  \\}\\n`));
  if (!m) throw new Error(`could not find function ${name} in content.js`);
  return m[0];
};

const lifted = [
  grabConst("CHANNEL_HREF_RE"),
  grabConst("CHANNEL_CARD_TAGS"),
  grabConst("BYLINE_SEL"),
  grabFn("normalizeChannelKey"),
  grabFn("collectChannelsIn"),
  grabFn("collectChannels"),
  grabFn("tileChannels")
].join("\n");

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.setContent("<!doctype html><body></body>");
await page.evaluate((code) => {
  // eslint-disable-next-line no-new-func
  window.tileChannels = new Function(`${code}\nreturn tileChannels;`)();
}, lifted);

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

await browser.close();
console.log("\nDONE");
