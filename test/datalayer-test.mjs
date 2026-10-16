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

// The round counter that stops a search paging in nothing but blocked
// videos, lifted out of content.js the same way (constants included, so the
// thresholds under test are the shipped ones).
const roundsSrc = (() => {
  const consts = contentSrc.match(/\n  const EXHAUST_ROUNDS = [\s\S]*?\n  let feedExhausted = false;\n/);
  const fn = contentSrc.match(/\n  function noteJudgedRound\(items, blockedIdx\) \{[\s\S]*?\n  \}\n/);
  if (!consts || !fn) throw new Error("could not find noteJudgedRound() in content.js");
  return consts[0] + fn[0];
})();

const harness = `
  (() => {
    const BT = self.XrnTube;
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
      if (!d || d.__xrntube !== "judge" || !Array.isArray(d.items)) return;
      const blocked = [];
      d.items.forEach((it, i) => { if (judgeHookItem(it)) blocked.push(i); });
      window.postMessage({ __xrntube: "verdict", id: d.id, blocked }, location.origin);
    });
  })();
`;

// Stands in for the network under the hook's fetch wrapper (page-hook.js
// captures `window.fetch` when it loads, so this must load first). It serves
// `window.__stubBody` in 7-byte chunks — small enough that multi-byte
// characters and the brackets inside strings land across chunk boundaries,
// which is what streamWatchParts() has to survive.
const fetchStub = `
  window.__stubBody = "";
  window.fetch = async () => {
    const bytes = new TextEncoder().encode(window.__stubBody);
    let i = 0;
    const body = new ReadableStream({
      pull(c) {
        if (i >= bytes.length) return c.close();
        c.enqueue(bytes.slice(i, i + 7));
        i += 7;
      }
    });
    return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
  };`;
const scripts = [read("../shared/constants.js"), read("../shared/block-logic.js"), harness, fetchStub, read("../content/page-hook.js")];

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

// A Short, as a channel's Shorts tab and every Shorts shelf render it: a
// title, a view count, and no publish date of any kind.
const short = (videoId, title, name, ucid, handle) => ({
  shortsLockupViewModel: {
    entityId: `shorts-shelf-item-${videoId}`,
    accessibilityText: `${title}, 1.4 million views – play Short`,
    onTap: { innertubeCommand: { reelWatchEndpoint: { videoId } } },
    overlayMetadata: { primaryText: { content: title } },
    metadata: byline(name, ucid, handle)
  }
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
async function filter(blocklist, filters, data, { exhausted = false, hideAutoChapters = false } = {}) {
  return page.evaluate(
    async ([bl, f, d, ex, ac]) => {
      window.__btHarness.setState(bl, f);
      window.postMessage({ __xrntube: "config", active: true, exhausted: ex, hideAutoChapters: ac }, location.origin);
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
    [blocklist, filters, data, exhausted, hideAutoChapters]
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
    const BT = self.XrnTube;
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

// ---- 12. an exhausted surface loses its continuation ----
// When content.js has watched several whole responses arrive with no video
// surviving, it flips `exhausted` and the hook takes the continuation out of
// everything that follows. Removing the sentinel from the DOM is not enough
// on its own — YouTube re-creates it from the next response — so this is the
// part that actually ends an "it keeps loading until one gets through" loop.
{
  const withMore = () =>
    wrap([
      video("uuuuuuuuuuu", "x", "Good", GOOD, "@good"),
      { continuationItemRenderer: { trigger: "CONTINUATION_TRIGGER_ON_ITEM_SHOWN", continuationEndpoint: {} } }
    ]);

  const normal = await filter({ channels: { [BAD]: { mode: "full" } }, videos: {}, allowlist: {} }, null, withMore());
  has(normal, "continuationItemRenderer")
    ? ok("a normal response keeps its continuation — the feed still pages")
    : fail("continuation removed from a response that was not exhausted");

  const cut = await filter(
    { channels: { [BAD]: { mode: "full" } }, videos: {}, allowlist: {} },
    null,
    withMore(),
    { exhausted: true }
  );
  !has(cut, "continuationItemRenderer")
    ? ok("an exhausted surface's continuation is stripped, so nothing asks for more")
    : fail("continuation survived on an exhausted surface");
  same(videoIds(cut), ["uuuuuuuuuuu"])
    ? ok("…and stripping it leaves the results themselves alone")
    : fail(`stripping also took results: ${JSON.stringify(videoIds(cut))}`);
}

// ---- 13. the round counter: when does a surface count as exhausted? ----
// Lifted from content.js, so these are the shipped thresholds. The two
// directions matter equally: never stopping is the bug being fixed, and
// stopping early would cut a search off while it still had results to show.
{
  const run = (body) =>
    page.evaluate(
      ([src, b]) =>
        new Function(`
          const dbg = () => {};
          const postHookConfig = () => {};
          const scheduleExtrasScrub = () => {};
          let onSurface = true;
          const onLayer0Surface = () => onSurface;
          ${src}
          const round = (n, survivors) => {
            const items = [];
            const blocked = [];
            for (let i = 0; i < n; i += 1) {
              items.push({ videoId: "v" + i });
              if (i >= survivors) blocked.push(i);
            }
            noteJudgedRound(items, blocked);
          };
          ${b}
        `)(),
      [roundsSrc, body]
    );

  const afterEach = await run(`
    const seen = [];
    for (let r = 0; r < 3; r += 1) { round(6, 0); seen.push(feedExhausted); }
    return seen;
  `);
  JSON.stringify(afterEach) === JSON.stringify([false, false, true])
    ? ok("three responses with no surviving video, and only the third, ends the paging")
    : fail(`wrong round at which it fired: ${JSON.stringify(afterEach)}`);

  const oneSurvivor = await run(`
    round(6, 0); round(6, 0); round(6, 1); round(6, 0); round(6, 0);
    return feedExhausted;
  `);
  oneSurvivor === false
    ? ok("a single surviving video resets the count")
    : fail("one surviving video did not reset the count — a working search would be cut off");

  const tiny = await run(`
    for (let r = 0; r < 6; r += 1) round(2, 0);
    return feedExhausted;
  `);
  tiny === false
    ? ok("batches too small to prove anything neither count nor reset")
    : fail("a two-video batch counted as an empty round");

  const offSurface = await run(`
    onSurface = false;
    for (let r = 0; r < 6; r += 1) round(6, 0);
    return feedExhausted;
  `);
  offSurface === false
    ? ok("a watch page is never declared exhausted (its rail is not an infinite feed)")
    : fail("the round counter fired off a paging surface");
}

// ---- 14. an age rule has to reach Shorts, which carry no date ----
// A Short's renderer has a title and a view count and nothing else, so
// `ageDays` is null for every one of them. Reading that as "recent" (the rule
// that protects a date which simply hasn't hydrated) exempted every short an
// age-ruled channel has: its Videos tab emptied while its Shorts tab stayed
// complete. Both layers have to answer this the same way, so it lives in
// blockReasonFor() and is asserted here through the hook.
{
  const aged = { channels: { [SOFT]: { mode: "exceptWhitelist", blockOlderThanDays: 2 } }, videos: {}, allowlist: {} };
  const out = await filter(
    aged,
    null,
    wrap([
      short("s1111111111", "an old short", "Soft", SOFT, "@soft"),
      video("v2222222222", "old upload", "Soft", SOFT, "@soft", { publishedTimeText: { simpleText: "3 weeks ago" } }),
      video("v3333333333", "todays upload", "Soft", SOFT, "@soft", { publishedTimeText: { simpleText: "1 hour ago" } })
    ])
  );
  same(videoIds(out), ["v3333333333"])
    ? ok("age rule: the dateless Short and the 3-week-old video go, today's upload stays")
    : fail(`expected only v3333333333, got ${JSON.stringify(videoIds(out))}`);
}

// ...and the same Short with no age rule on the entry is blocked as a plain
// video-only block always did, i.e. the flag changes nothing on its own.
{
  const plain = { channels: { [SOFT]: { mode: "exceptWhitelist" } }, videos: {}, allowlist: {} };
  const out = await filter(plain, null, wrap([short("s4444444444", "a short", "Soft", SOFT, "@soft")]));
  videoIds(out).length === 0
    ? ok("video-only without an age rule still takes their Shorts")
    : fail(`short survived a plain video-only block: ${JSON.stringify(videoIds(out))}`);
}

// A whitelisted Short still wins, age rule or not — the exception list is
// checked before any of this.
{
  const aged = {
    channels: { [SOFT]: { mode: "exceptWhitelist", blockOlderThanDays: 2, whitelist: { s5555555555: "kept" } } },
    videos: {},
    allowlist: {}
  };
  const out = await filter(aged, null, wrap([short("s5555555555", "kept short", "Soft", SOFT, "@soft")]));
  same(videoIds(out), ["s5555555555"])
    ? ok("a whitelisted Short survives the age rule")
    : fail(`whitelisted short was removed: ${JSON.stringify(videoIds(out))}`);
}

// ---- 15. a playlist lockup is a playlist, not a video with a strange id ----
// `lockupViewModel` is one tag for several kinds of tile; `contentType` says
// which. A playlist lockup's `contentId` is a `PL…` id, and taking that for a
// video id made it a video nothing could date — so an age-ruled channel's
// playlist cards survived in search for good, which is precisely how they
// were reported. The DOM scrub reaches the same verdict from the `&list=`
// link (tilescope-test), since the page itself carries no type marker.
{
  // The byline is at the depth YouTube actually uses — thirteen levels in,
  // reached through `commandRuns`. The generic scan gives up at ten, so this
  // fixture fails without the rule's `bylinePaths`, which is the whole point
  // of it: a shallower stand-in would pass either way and prove nothing.
  const playlistLockup = {
    lockupViewModel: {
      contentId: "PLB7ZcpBcwdC7lbptiTx9d",
      contentType: "LOCKUP_CONTENT_TYPE_PLAYLIST",
      metadata: {
        lockupMetadataViewModel: {
          title: { content: "Season 1" },
          metadata: {
            contentMetadataViewModel: {
              metadataRows: [
                {
                  metadataParts: [
                    {
                      text: {
                        content: "Blocked Channel",
                        commandRuns: [{ onTap: { innertubeCommand: navEndpoint(SOFT, "@soft") } }]
                      }
                    }
                  ]
                }
              ]
            }
          }
        }
      }
    }
  };
  const aged = { channels: { [SOFT]: { mode: "exceptWhitelist", blockOlderThanDays: 2 } }, videos: {}, allowlist: {} };
  const out = await filter(aged, null, wrap([playlistLockup]));
  !has(out, "lockupViewModel")
    ? ok("an age-ruled channel's playlist card is removed (a playlist has no date to pass the rule with)")
    : fail("playlist lockup survived an age-ruled block");
}

// ---- YouTube's auto-generated chapters (the hideAutoChapters switch) ----
// A watch-next response in YouTube's shape: the player-bar markers, the
// chapter button, the chapter panel, a "Chapters" chip in another panel's
// header, and the description's chapter cards — all pointing at one panel,
// whose id says which kind of chapters these are.
const watchNext = (key, extra = {}) => {
  const panel =
    key === "AUTO_CHAPTERS" ? "engagement-panel-macro-markers-auto-chapters" : "engagement-panel-macro-markers-description-chapters";
  const open = {
    commandExecutorCommand: { commands: [{ updateEngagementPanelContentCommand: { contentSourcePanelIdentifier: { tag: panel } } }] }
  };
  return {
    ...extra,
    playerOverlays: {
      playerOverlayRenderer: {
        decoratedPlayerBarRenderer: {
          decoratedPlayerBarRenderer: {
            playerBar: {
              multiMarkersPlayerBarRenderer: {
                visibleOnLoad: { key },
                markersMap: [{ key, value: { chapters: [{ chapterRenderer: { title: { simpleText: "One" } } }] } }]
              }
            },
            playerBarActionButton: { buttonRenderer: { command: open } }
          }
        }
      }
    },
    engagementPanels: [
      { engagementPanelSectionListRenderer: { panelIdentifier: panel, targetId: panel, content: {} } },
      {
        engagementPanelSectionListRenderer: {
          panelIdentifier: "engagement-panel-searchable-transcript",
          header: {
            engagementPanelTitleHeaderRenderer: {
              subheader: {
                chipBarViewModel: {
                  chips: [
                    { chipViewModel: { text: "Chapters", tapCommand: { innertubeCommand: open } } },
                    { chipViewModel: { text: "Transcript", tapCommand: { innertubeCommand: {} } } }
                  ]
                }
              }
            }
          }
        }
      },
      {
        engagementPanelSectionListRenderer: {
          panelIdentifier: "engagement-panel-structured-description",
          content: {
            structuredDescriptionContentRenderer: {
              items: [
                { horizontalCardListRenderer: { header: { richListHeaderRenderer: { navigationButton: { buttonRenderer: { command: open } } } } } },
                { horizontalCardListRenderer: { header: { richListHeaderRenderer: { title: { simpleText: "Music" } } } } }
              ]
            }
          }
        }
      }
    ]
  };
};
const AUTO_PANEL = "engagement-panel-macro-markers-auto-chapters";
const noBlocks = { channels: {}, videos: {}, allowlist: {} };
{
  const out = await filter(noBlocks, null, watchNext("AUTO_CHAPTERS"), { hideAutoChapters: true });
  const s = JSON.stringify(out);
  !s.includes("AUTO_CHAPTERS") && !s.includes(AUTO_PANEL)
    ? ok("auto chapters: markers, chapter button, panel, chip and description cards all removed")
    : fail("auto chapters survived: " + s.slice(0, 300));
  s.includes('"Transcript"') && s.includes('"Music"') && s.includes("engagement-panel-structured-description")
    ? ok("…while the transcript chip, other description cards and other panels stay")
    : fail("the strip took more than the auto chapters: " + s.slice(0, 300));
  const creator = watchNext("DESCRIPTION_CHAPTERS");
  const kept = await filter(noBlocks, null, structuredClone(creator), { hideAutoChapters: true });
  JSON.stringify(kept) === JSON.stringify(creator)
    ? ok("creator-written chapters are left exactly as they were")
    : fail("creator chapters were touched: " + JSON.stringify(kept).slice(0, 300));
  const off = await filter(noBlocks, null, watchNext("AUTO_CHAPTERS"), { hideAutoChapters: false });
  JSON.stringify(off).includes("AUTO_CHAPTERS")
    ? ok("switch off: auto chapters stay")
    : fail("auto chapters removed with the switch off");
}

// ---- /get_watch, streamed part by part ----
// In-app navigation fetches `[{player part}, {watch-next part}]`. The player
// part must come back byte for byte (so playback isn't held up re-encoding
// it), the watch-next part filtered — related column and auto chapters.
{
  const playerPart = {
    responseContext: {},
    playerResponse: { videoDetails: { title: 'Kênh "Thử" ] } [ { \\ Nghiệm — 🎬', lengthSeconds: "60" } }
  };
  const related = [video("bbbbbbbbbbb", "from a blocked channel", "Bad", BAD, "@bad"), video("ggggggggggg", "fine", "Good", GOOD, "@good")];
  const nextPart = {
    responseContext: {},
    watchNextResponse: watchNext("AUTO_CHAPTERS", {
      contents: { twoColumnWatchNextResults: { secondaryResults: { secondaryResults: { results: related } } } }
    })
  };
  const body = JSON.stringify([playerPart, nextPart]);
  const res = await page.evaluate(
    async ([bl, b]) => {
      window.__btHarness.setState(bl, null);
      window.postMessage({ __xrntube: "config", active: true, exhausted: false, hideAutoChapters: true }, location.origin);
      await new Promise((r) => setTimeout(r, 0));
      window.__stubBody = b;
      const text = await (await fetch("https://bt.test/youtubei/v1/get_watch?prettyPrint=false")).text();
      return text;
    },
    [{ channels: { [BAD]: { mode: "full" } }, videos: {}, allowlist: {} }, body]
  );
  let parsed = null;
  try {
    parsed = JSON.parse(res);
  } catch (e) {
    fail("streamed /get_watch body is not valid JSON: " + e.message);
  }
  if (parsed) {
    res.startsWith("[" + JSON.stringify(playerPart) + ",")
      ? ok("/get_watch: the player part streams through byte for byte, multi-byte text and bracket-laden strings included")
      : fail("player part changed: " + res.slice(0, 200));
    const ids = videoIds(parsed[1]);
    !ids.includes("bbbbbbbbbbb") && ids.includes("ggggggggggg")
      ? ok("/get_watch: a blocked channel's related tile is removed, others stay")
      : fail("related column not filtered in /get_watch: " + ids.join(","));
    !JSON.stringify(parsed[1]).includes("AUTO_CHAPTERS")
      ? ok("/get_watch: auto chapters removed from the watch-next part")
      : fail("auto chapters survived /get_watch");
  }
}

await browser.close();
console.log("\nDONE");
