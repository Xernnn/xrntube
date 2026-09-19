import { readFileSync } from "fs";
import { chromium } from "playwright";

// Layer 0: content/page-hook.js filtering YouTube's JSON before Polymer sees
// it. This drives the REAL shipped files — shared/constants.js,
// shared/block-logic.js and content/page-hook.js are loaded into a page and
// exercised through the hook's own `ytInitialData` getter and its own
// postMessage protocol. Nothing is reimplemented here, so a rule that stops
// matching, a protocol change, or a broken walk all fail this file.
//
// The response fixtures are synthetic but shaped like the real thing. They
// have to be: a live search response is ~1MB of churning JSON, and the point
// of these cases is the *semantics* (which renderer, matched via which field,
// under which block mode), which a live page can't pin down.
//
// No network and no extension: the page is served by a Playwright route on a
// fake https origin, which is only needed so `location.origin` is a real
// origin that `postMessage` will accept.

const read = (p) => readFileSync(new URL(p, import.meta.url), "utf8");
const contentSrc = read("../content/content.js");

// page-hook.js deliberately contains no decision logic — it describes
// renderers and asks content.js. So the harness has to play content.js, and
// it does that with content.js's OWN judgeHookItem() lifted out of the file
// (the trick contextmenu-test and tilescope-test use), not a copy of it. Only
// the few lines of message glue are written here; datalayer-live-test covers
// the real glue against live YouTube.
const judgeSrc = (() => {
  const m = contentSrc.match(/\n  function judgeHookItem\(it\) \{[\s\S]*?\n  \}\n/);
  if (!m) throw new Error("could not find judgeHookItem() in content.js");
  return m[0];
})();

const harness = `
  (() => {
    const BT = self.BlockTube;
    const { buildBlockIndex, compileFilters, normalizeChannelKey, parseAgeDays,
            plausibleAgeDays, parseDurationSec, blockReasonFor } = BT;
    let blockIndex = BT.EMPTY_INDEX;
    let filterRec = BT.EMPTY_FILTERS;
    ${judgeSrc}
    window.__btHarness = {
      setState(bl, f) {
        blockIndex = buildBlockIndex(bl);
        filterRec = compileFilters(f);
      }
    };
    window.addEventListener("message", (e) => {
      if (e.source !== window) return;
      const d = e.data;
      if (!d || d.__blocktube !== "judge" || !Array.isArray(d.items)) return;
      const blocked = [];
      d.items.forEach((it, i) => { if (judgeHookItem(it)) blocked.push(i); });
      window.postMessage({ __blocktube: "verdict", id: d.id, blocked }, location.origin);
    });
  })();
`;

const scripts = [read("../shared/constants.js"), read("../shared/block-logic.js"), harness, read("../content/page-hook.js")];

const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);

// ---- fixture builders, in YouTube's shapes ----

const navEndpoint = (ucid, handle) => ({
  browseEndpoint: {
    browseId: ucid,
    ...(handle ? { canonicalBaseUrl: `/${handle}` } : {})
  }
});
const byline = (name, ucid, handle) => ({
  runs: [{ text: name, navigationEndpoint: navEndpoint(ucid, handle) }]
});
const video = (videoId, title, name, ucid, handle, extra = {}) => ({
  videoRenderer: {
    videoId,
    title: { runs: [{ text: title }] },
    shortBylineText: byline(name, ucid, handle),
    thumbnailOverlays: [{ thumbnailOverlayTimeStatusRenderer: { text: { simpleText: "12:34" } } }],
    publishedTimeText: { simpleText: "3 weeks ago" },
    ...extra
  }
});
// A search result's description snippet. YouTube linkifies @mentions in it,
// so this is the JSON twin of the DOM false positive tilescope-test guards.
const withMention = (ucid, handle) => ({
  detailedMetadataSnippets: [
    {
      snippetText: {
        runs: [{ text: "shoutout to " }, { text: "@them", navigationEndpoint: navEndpoint(ucid, handle) }]
      }
    }
  ]
});

// A UC id is exactly "UC" + 22 chars, and collectChannelKeys() enforces that
// before it will treat a browseId as a channel. Three of these were a char
// short on the first draft, which silently made their cases pass by matching
// nothing at all — hence the assertion below rather than a comment.
const BAD = "UCbadbadbadbadbadbadbadb";
const GOOD = "UCgoodgoodgoodgoodgoodgo";
const SOFT = "UCsoftsoftsoftsoftsoftso";
const ALLOWED = "UCokokokokokokokokokokok";
for (const [n, v] of Object.entries({ BAD, GOOD, SOFT, ALLOWED })) {
  if (!/^UC[\w-]{22}$/.test(v)) fail(`fixture ${n} is not a well-formed UC id (${v.length} chars)`);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
await page.route("https://bt.test/**", (route) =>
  route.fulfill({ contentType: "text/html", body: "<!doctype html><title>bt</title><body>" })
);
// ?bt-debug is what exposes window.__btDataLayer, which is how we wait for
// the (now asynchronous) filtering to finish.
await page.goto("https://bt.test/?bt-debug");
for (const content of scripts) await page.addScriptTag({ content });

// Feed the harness a blocklist, then hand the hook a response through its
// real `ytInitialData` interception and read back what survived. Filtering is
// asynchronous now (the hook has to ask), so this waits for the hook's own
// completion marker rather than guessing at a delay.
async function filter(blocklist, filters, data) {
  return page.evaluate(
    async ([bl, f, d]) => {
      window.__btHarness.setState(bl, f);
      window.postMessage({ __blocktube: "config", active: true }, location.origin);
      await new Promise((r) => setTimeout(r, 0)); // let the config land
      window.__btDataLayer.initialData = "pending";
      window.ytInitialData = d;
      const started = Date.now();
      while (window.__btDataLayer.initialData === "pending") {
        if (Date.now() - started > 5000) throw new Error("hook never finished filtering");
        await new Promise((r) => setTimeout(r, 5));
      }
      return window.ytInitialData;
    },
    [blocklist, filters, data]
  );
}

// Every videoId still present anywhere in the filtered response.
const videoIds = (o) => {
  const out = [];
  const walk = (n) => {
    if (!n || typeof n !== "object") return;
    if (Array.isArray(n)) return n.forEach(walk);
    if (typeof n.videoId === "string") out.push(n.videoId);
    Object.values(n).forEach(walk);
  };
  walk(o);
  return out;
};
const has = (o, key) => JSON.stringify(o).includes(`"${key}"`);
const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);

const wrap = (items) => ({
  contents: {
    twoColumnSearchResultsRenderer: {
      primaryContents: { sectionListRenderer: { contents: [{ itemSectionRenderer: { contents: items } }] } }
    }
  }
});
const results = (o) =>
  o.contents.twoColumnSearchResultsRenderer.primaryContents.sectionListRenderer.contents[0].itemSectionRenderer
    .contents;

// ---- 1. a blocked channel's video goes; everyone else's stays ----
{
  const out = await filter(
    { channels: { [BAD]: { mode: "full" } }, videos: {}, allowlist: {} },
    null,
    wrap([
      video("aaaaaaaaaaa", "blocked one", "Bad", BAD, "@bad"),
      video("bbbbbbbbbbb", "fine one", "Good", GOOD, "@good")
    ])
  );
  same(videoIds(out), ["bbbbbbbbbbb"])
    ? ok("blocked channel's video removed from the response, the other kept")
    : fail(`expected only bbbbbbbbbbb, got ${JSON.stringify(videoIds(out))}`);
  results(out).length === 1
    ? ok("its wrapper is spliced out, not left as an empty slot")
    : fail(`${results(out).length} entries left in contents`);
}

// ---- 2. a video that only @mentions the blocked channel survives ----
// The whole reason the rule table reads named byline fields instead of
// scanning the renderer.
{
  const out = await filter(
    { channels: { [BAD]: { mode: "full" } }, videos: {}, allowlist: {} },
    null,
    wrap([video("ccccccccccc", "talking about them", "Good", GOOD, "@good", withMention(BAD, "@bad"))])
  );
  same(videoIds(out), ["ccccccccccc"])
    ? ok("a description @mention of a blocked channel does not delete the video")
    : fail("video deleted for mentioning a blocked channel");
}

// ---- 3. a UC-keyed block matches without the handle ever being scraped ----
// The DOM layer can't do this: modern tiles render only /@handle, so a UC…
// entry blocks nothing there until the enrich sweep pairs it up. In the JSON
// both identities sit in the same browseEndpoint.
{
  const out = await filter(
    { channels: { [BAD]: { mode: "full" } }, videos: {}, allowlist: {} }, // no `handle` on the entry
    null,
    wrap([video("ddddddddddd", "x", "Bad", BAD, "@bad")])
  );
  videoIds(out).length === 0
    ? ok("UC-keyed entry blocks a tile before any handle has been scraped")
    : fail("UC-keyed entry did not match");
}
// …and the reverse: an @handle-keyed entry matching via canonicalBaseUrl.
{
  const out = await filter(
    { channels: { "@bad": { mode: "full" } }, videos: {}, allowlist: {} },
    null,
    wrap([video("eeeeeeeeeee", "x", "Bad", BAD, "@bad"), video("fffffffffff", "y", "Good", GOOD, "@good")])
  );
  same(videoIds(out), ["fffffffffff"])
    ? ok("@handle-keyed entry matches via canonicalBaseUrl")
    : fail(`got ${JSON.stringify(videoIds(out))}`);
}

// ---- 4. block modes ----
{
  const bl = {
    channels: { [SOFT]: { mode: "exceptWhitelist", whitelist: { ggggggggggg: { ts: 1 } } } },
    videos: {},
    allowlist: {}
  };
  const out = await filter(
    bl,
    null,
    wrap([
      video("ggggggggggg", "kept by whitelist", "Soft", SOFT, "@soft"),
      video("hhhhhhhhhhh", "blocked", "Soft", SOFT, "@soft"),
      { channelRenderer: { channelId: SOFT, title: { simpleText: "Soft" }, navigationEndpoint: navEndpoint(SOFT, "@soft") } }
    ])
  );
  same(videoIds(out), ["ggggggggggg"])
    ? ok("video-only mode: whitelisted video survives, the rest go")
    : fail(`got ${JSON.stringify(videoIds(out))}`);
  has(out, "channelRenderer")
    ? ok("video-only mode keeps the channel's own card")
    : fail("video-only mode removed the channel card");
}
{
  const out = await filter(
    { channels: { [BAD]: { mode: "full" } }, videos: {}, allowlist: {} },
    null,
    wrap([{ channelRenderer: { channelId: BAD, title: { simpleText: "Bad" }, navigationEndpoint: navEndpoint(BAD, "@bad") } }])
  );
  has(out, "channelRenderer") ? fail("full block left the channel card") : ok("full block removes the channel card");
}

// ---- 5. the allow-list beats a block ----
{
  const out = await filter(
    { channels: { [ALLOWED]: { mode: "full" } }, videos: {}, allowlist: { [ALLOWED]: { ts: 1 } } },
    null,
    wrap([video("iiiiiiiiiii", "x", "Ok", ALLOWED, "@ok")])
  );
  same(videoIds(out), ["iiiiiiiiiii"])
    ? ok("allow-listed channel survives its own block entry")
    : fail("allow-list did not win");
}

// ---- 6. an individually blocked video id ----
{
  const out = await filter(
    { channels: {}, videos: { jjjjjjjjjjj: { ts: 1 } }, allowlist: {} },
    null,
    wrap([video("jjjjjjjjjjj", "x", "Good", GOOD, "@good"), video("kkkkkkkkkkk", "y", "Good", GOOD, "@good")])
  );
  same(videoIds(out), ["kkkkkkkkkkk"]) ? ok("blocked video id removed by id alone") : fail("video id not matched");
}

// ---- 7. keyword + duration filters ----
{
  const out = await filter(
    { channels: {}, videos: {}, allowlist: {} },
    { list: [{ p: "clickbait", re: false }] },
    wrap([
      video("lllllllllll", "TOTAL CLICKBAIT title", "Good", GOOD, "@good"),
      video("mmmmmmmmmmm", "an honest title", "Good", GOOD, "@good")
    ])
  );
  same(videoIds(out), ["mmmmmmmmmmm"]) ? ok("title keyword filter applies at the data layer") : fail("keyword missed");
}
{
  // the fixture's duration badge is 12:34 = 754s
  const out = await filter(
    { channels: {}, videos: {}, allowlist: {} },
    { durMaxSec: 600 },
    wrap([video("nnnnnnnnnnn", "long one", "Good", GOOD, "@good")])
  );
  videoIds(out).length === 0 ? ok("duration bound applies at the data layer") : fail("duration bound missed");
}

// ---- 8. a shelf goes by its header's owner, and only for a FULL block ----
{
  const shelf = (ucid, handle, vids) => ({
    shelfRenderer: {
      title: { simpleText: "Latest from them" },
      endpoint: navEndpoint(ucid, handle),
      content: { verticalListRenderer: { items: vids } }
    }
  });
  const out = await filter(
    { channels: { [BAD]: { mode: "full" } }, videos: {}, allowlist: {} },
    null,
    wrap([shelf(BAD, "@bad", [video("ooooooooooo", "x", "Bad", BAD, "@bad")])])
  );
  !has(out, "shelfRenderer") && videoIds(out).length === 0
    ? ok("a FULL-blocked channel's shelf is removed whole, header and all")
    : fail("shelf survived");

  const out2 = await filter(
    { channels: { [SOFT]: { mode: "exceptWhitelist", whitelist: { ppppppppppp: { ts: 1 } } } }, videos: {}, allowlist: {} },
    null,
    wrap([
      shelf(SOFT, "@soft", [
        video("ppppppppppp", "whitelisted", "Soft", SOFT, "@soft"),
        video("qqqqqqqqqqq", "not", "Soft", SOFT, "@soft")
      ])
    ])
  );
  has(out2, "shelfRenderer") && same(videoIds(out2), ["ppppppppppp"])
    ? ok("a video-only channel's shelf stays, judged tile by tile")
    : fail(`soft shelf handled wrong: ${JSON.stringify(videoIds(out2))}`);
}

// ---- 9. the richItemRenderer wrapper is pruned, not left blank ----
{
  const out = await filter(
    { channels: { [BAD]: { mode: "full" } }, videos: {}, allowlist: {} },
    null,
    {
      contents: {
        twoColumnBrowseResultsRenderer: {
          tabs: [
            {
              tabRenderer: {
                content: {
                  richGridRenderer: {
                    contents: [
                      { richItemRenderer: { content: video("rrrrrrrrrrr", "x", "Bad", BAD, "@bad") } },
                      { richItemRenderer: { content: video("sssssssssss", "y", "Good", GOOD, "@good") } }
                    ]
                  }
                }
              }
            }
          ]
        }
      }
    }
  );
  const grid =
    out.contents.twoColumnBrowseResultsRenderer.tabs[0].tabRenderer.content.richGridRenderer.contents;
  grid.length === 1 && same(videoIds(out), ["sssssssssss"])
    ? ok("a channel tab's rich grid loses the tile AND its wrapper")
    : fail(`grid has ${grid.length} entries: ${JSON.stringify(videoIds(out))}`);
}

// ---- 10. nothing blocked means the response is untouched ----
{
  const before = wrap([video("ttttttttttt", "x", "Good", GOOD, "@good")]);
  const json = JSON.stringify(before);
  const out = await filter({ channels: {}, videos: {}, allowlist: {} }, null, JSON.parse(json));
  JSON.stringify(out) === json
    ? ok("an empty blocklist leaves the response byte-identical")
    : fail("empty blocklist still modified the response");
}

// ---- 11. blockReasonFor() must tolerate an iterator for channelKeys ----
// It walks the list twice (allow-list, then the block check). content.js
// naturally hands it `info.channels.keys()`, a Map iterator, which the first
// pass drains — so the second saw nothing and a FULL block silently stopped
// blocking anything, on every surface, with all four other layers behaving
// normally. Cheap to re-introduce, so it is pinned here.
{
  const verdicts = await page.evaluate((ucid) => {
    const BT = self.BlockTube;
    const idx = BT.buildBlockIndex({ channels: { [ucid]: { mode: "full" } }, videos: {}, allowlist: {} });
    const asMap = new Map([[ucid, "Bad"]]);
    return {
      fromArray: BT.blockReasonFor({ channelKeys: [ucid] }, idx, null),
      fromIterator: BT.blockReasonFor({ channelKeys: asMap.keys() }, idx, null),
      fromSet: BT.blockReasonFor({ channelKeys: new Set([ucid]) }, idx, null)
    };
  }, BAD);
  verdicts.fromArray && verdicts.fromIterator && verdicts.fromSet
    ? ok("blockReasonFor() blocks the same whether given an array, a Set or an iterator")
    : fail(`iterator/Set handling broken: ${JSON.stringify(verdicts)}`);
}

await browser.close();
console.log("\nDONE");
