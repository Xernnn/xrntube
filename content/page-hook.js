// Layer 0: filter YouTube's own JSON before Polymer ever sees it.
//
// This runs in the page's MAIN world (see manifest), the only place
// `window.fetch` and `window.ytInitialData` can be intercepted — a content
// script in the isolated world sees a different `window`.
//
// WHY, given layers 1-3 already work: every other layer reacts to a tile
// YouTube has already decided to render. That is what forces the instant-hide
// `:has()` budget (400 channels), the rehydration retries (a tile paints
// before its byline/duration/date do), and the class of bug where a surface
// is invisible to us because we don't know its tag name. Here the uploader,
// title, duration and publish date arrive together, in one object, before
// anything renders.
//
// ---- This file decides NOTHING. -----------------------------------------
// It knows only WHERE the fields are in YouTube's JSON. It reads them raw —
// unparsed duration text, unnormalised channel URLs — posts them to
// content.js, and applies whatever verdict comes back. Every question of
// meaning (is this id blocked, does this mode block this video, is the
// channel allow-listed, does this title match a keyword) is answered once, by
// shared/block-logic.js, in the isolated world.
//
// That split is not tidiness, it is forced. Chrome injects a given script
// PATH only once per document, even across content_scripts entries in
// different worlds — so if this file loaded `shared/block-logic.js`, the
// isolated entry would silently not get it and content.js would die on
// startup with "Cannot destructure property 'MSG' of 'self.BlockTube'".
// Confirmed live in both entry orders, and with dynamic
// `scripting.registerContentScripts` too. The MAIN entry therefore lists this
// file and nothing else, and the only way to keep ONE copy of the decision is
// to keep the decision out of this world entirely.
//
// It is also NOT a replacement for the DOM scrub. It filters only
// `/youtubei/v1/search` and `/youtubei/v1/browse` — search results, channel
// tabs, and the continuations both page in with. Anything it misses (an
// endpoint it doesn't hook, a renderer with no rule, a shape that changed
// this morning) is still caught downstream. **A miss here is a latency
// regression, never a blocking failure.**
//
// PRIVACY: the MAIN world *is* the page, so `postMessage` here is readable by
// YouTube's own scripts. Keeping the blocklist in the isolated world means
// what crosses is only ever a description of what YouTube itself just sent
// us, plus a list of indices — never the blocklist.
(() => {
  "use strict";

  // Only the top document navigates to search or a channel. An embedded
  // player fetches `/youtubei/v1/player`, which we don't filter (content.js
  // handles embeds on its own path), so installing here would be pure cost.
  if (window.top !== window) return;

  const DEBUG = (() => {
    try {
      return /[?&]bt-debug\b/.test(location.search) || localStorage.getItem("bt_debug") === "1";
    } catch {
      return /[?&]bt-debug\b/.test(location.search);
    }
  })();
  const stats = { responses: 0, candidates: 0, removed: 0, initialData: "untouched" };
  if (DEBUG) window.__btDataLayer = stats;
  const dbg = (...a) => {
    if (DEBUG) console.debug("%c[BlockTube/data]", "color:#07c;font-weight:bold", ...a);
  };

  // Set by content.js: false while the blocklist is empty and no filters are
  // set, in which case there is nothing this layer could remove and it must
  // not pay to clone, read and parse every response.
  let active = false;

  // ---------- reading YouTube's JSON ----------

  // YouTube writes the same string a dozen ways depending on the renderer's
  // vintage: a bare string, {simpleText}, {runs:[{text}]}, or the newer
  // {content}. All of them mean "the text".
  function textOf(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    if (typeof v === "number") return String(v);
    if (Array.isArray(v)) return v.map(textOf).join(" ");
    if (typeof v !== "object") return "";
    if (typeof v.simpleText === "string") return v.simpleText;
    if (typeof v.content === "string") return v.content;
    if (Array.isArray(v.runs)) return v.runs.map((r) => (r && r.text) || "").join("");
    return "";
  }

  // Dotted path lookup that also steps through arrays, taking the first
  // element that has the next key. YouTube uses an array for things that are
  // conceptually one value all over the place (`thumbnailOverlays` especially).
  function pick(obj, path) {
    let cur = obj;
    for (const seg of path.split(".")) {
      if (cur == null) return undefined;
      if (Array.isArray(cur)) {
        cur = cur.find((o) => o && typeof o === "object" && seg in o);
        if (cur == null) return undefined;
      }
      cur = cur[seg];
    }
    return cur;
  }

  function pickText(obj, paths) {
    for (const p of paths) {
      const s = textOf(pick(obj, p));
      if (s) return s;
    }
    return "";
  }

  function pickStr(obj, paths) {
    for (const p of paths) {
      const v = pick(obj, p);
      if (typeof v === "string" && v) return v;
    }
    return null;
  }

  // Channel references a subtree names, as raw path strings for content.js to
  // normalise. Both identity formats are emitted where present: a
  // `browseEndpoint` usually carries `browseId` (`UC...`) AND
  // `canonicalBaseUrl` (`/@handle`) side by side, which is where the data
  // layer beats the DOM — a `UC...`-keyed blocklist matches a tile that
  // renders only the handle, without waiting for the enrich sweep.
  const MAX_SCAN_DEPTH = 10;
  function collectChannelRefs(node, out, depth) {
    if (!node || typeof node !== "object" || depth > MAX_SCAN_DEPTH) return out;
    if (Array.isArray(node)) {
      for (const v of node) collectChannelRefs(v, out, depth + 1);
      return out;
    }
    const be = node.browseEndpoint;
    if (be && typeof be === "object") {
      if (typeof be.browseId === "string") out.add(`/channel/${be.browseId}`);
      if (typeof be.canonicalBaseUrl === "string") out.add(be.canonicalBaseUrl);
    }
    for (const key of Object.keys(node)) {
      if (key === "browseEndpoint") continue;
      collectChannelRefs(node[key], out, depth + 1);
    }
    return out;
  }

  // The fields that name a renderer's UPLOADER. Scanning the whole renderer
  // instead would repeat the DOM layer's old mistake in JSON form: a search
  // result carries `detailedMetadataSnippets`, whose runs link every channel
  // the description @mentions, and blocking on those deletes a video for
  // talking about a blocked channel (docs/blocking-rules.md: read a tile's
  // channel from its byline). A renderer whose byline lives somewhere not listed here
  // simply isn't matched, and the DOM scrub picks it up instead.
  const BYLINE_FIELDS = [
    "shortBylineText",
    "longBylineText",
    "ownerText",
    "bylineText",
    "authorText",
    "authorEndpoint",
    "owner",
    "byline",
    "subtitles",
    "channelThumbnailSupportedRenderers",
    "channelThumbnail",
    "channelTitleText",
    "avatar",
    // "view model" tiles keep the byline inside their metadata block
    "metadata"
  ];

  // ---------- the rule table ----------
  //
  // One entry per renderer key we can describe. Fields:
  //   videoIds    paths to the video id  (absent = not a video)
  //   titles      paths to the title
  //   lengths     paths to the duration badge text (sent raw)
  //   published   paths to the "3 days ago" text (sent raw)
  //   isPlaylist  the tile is a playlist/mix
  //   whole       the renderer IS a channel, so scan all of it for the byline
  //               and never read a video id off it — search's watch card
  //               lists videos inside itself, and attributing the first row's
  //               id to the card would delete the card for one blocked video
  //   shelfOwner  paths to the shelf's OWN endpoint; the row is then judged
  //               as a channel with no video, which is the "is the channel
  //               itself blocked" question, so only a FULL block takes a row
  const V = ["videoId"];
  const VIDEO_BASE = {
    videoIds: V,
    titles: ["title", "headline"],
    lengths: ["thumbnailOverlays.thumbnailOverlayTimeStatusRenderer.text", "lengthText"],
    published: ["publishedTimeText"]
  };
  const PLAYLIST_BASE = { isPlaylist: true, titles: ["title"] };
  const CHANNEL_CARD = { whole: true };
  const SHELF = { shelfOwner: ["endpoint", "navigationEndpoint", "titleNavigationEndpoint"] };

  const RULES = {
    // --- search + feed video tiles ---
    videoRenderer: VIDEO_BASE,
    gridVideoRenderer: VIDEO_BASE,
    compactVideoRenderer: VIDEO_BASE,
    playlistVideoRenderer: VIDEO_BASE,
    playlistPanelVideoRenderer: VIDEO_BASE,
    endScreenVideoRenderer: VIDEO_BASE,
    movieRenderer: VIDEO_BASE,
    compactMovieRenderer: VIDEO_BASE,
    channelFeaturedVideoRenderer: { ...VIDEO_BASE, lengths: ["lengthText"] },
    videoWithContextRenderer: { ...VIDEO_BASE, titles: ["headline"] },
    watchCardCompactVideoRenderer: {
      videoIds: ["navigationEndpoint.watchEndpoint.videoId"],
      titles: ["title"],
      lengths: ["lengthText"]
    },
    videoCardRenderer: {
      videoIds: V,
      titles: ["title"],
      lengths: ["lengthText"],
      published: ["metadataText"]
    },
    reelItemRenderer: { videoIds: V, titles: ["headline"] },
    shortsLockupViewModel: {
      videoIds: ["onTap.innertubeCommand.reelWatchEndpoint.videoId"],
      titles: ["overlayMetadata.primaryText"]
    },
    // The modern "view model" tile — search results and a channel's Playlists
    // tab render only this now, with no ytd-* wrapper at all.
    lockupViewModel: {
      videoIds: ["contentId"],
      titles: ["metadata.lockupMetadataViewModel.title"],
      lengths: [
        "contentImage.thumbnailViewModel.overlays.thumbnailOverlayBadgeViewModel.thumbnailBadges.thumbnailBadgeViewModel.text"
      ],
      published: [
        "metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel.metadataRows.metadataParts.text"
      ]
    },

    // --- playlists / mixes ---
    playlistRenderer: PLAYLIST_BASE,
    gridPlaylistRenderer: PLAYLIST_BASE,
    compactPlaylistRenderer: PLAYLIST_BASE,
    radioRenderer: PLAYLIST_BASE,
    compactRadioRenderer: PLAYLIST_BASE,
    gridRadioRenderer: PLAYLIST_BASE,

    // --- channel cards ---
    channelRenderer: CHANNEL_CARD,
    gridChannelRenderer: CHANNEL_CARD,
    compactChannelRenderer: CHANNEL_CARD,
    miniChannelRenderer: CHANNEL_CARD,
    compactChannelRecommendationCardRenderer: CHANNEL_CARD,
    universalWatchCardRenderer: CHANNEL_CARD,

    // --- a "Latest from X" row, by its header's owner ---
    shelfRenderer: SHELF,
    richShelfRenderer: SHELF,

    // --- community posts ---
    backstagePostRenderer: CHANNEL_CARD,
    postRenderer: CHANNEL_CARD,
    sharedPostRenderer: CHANNEL_CARD
  };

  // A key whose value has gone empty can be dropped, so a tile's wrapper
  // doesn't survive as a blank slot and a shelf doesn't survive as a bare
  // header. Mirrors upstream BlockTube's `deleteAllowed`.
  const PRUNE_EMPTY = new Set([
    "richItemRenderer",
    "richSectionRenderer",
    "content",
    "horizontalListRenderer",
    "verticalListRenderer",
    "shelfRenderer",
    "richShelfRenderer",
    "reelShelfRenderer",
    "gridRenderer",
    "expandedShelfContentsRenderer"
  ]);

  // ---------- describe, ask, apply ----------

  // Walk the response and describe every renderer we have a rule for.
  // Returns the descriptors (for content.js) alongside where each one lives
  // (for us), index-aligned.
  function collect(root) {
    const sites = [];
    const items = [];
    const seen = new Set();
    const walk = (node, depth) => {
      if (!node || typeof node !== "object" || depth > 40) return;
      if (Array.isArray(node)) {
        for (const v of node) walk(v, depth + 1);
        return;
      }
      if (seen.has(node)) return;
      seen.add(node);
      for (const key of Object.keys(node)) {
        const r = node[key];
        if (!r || typeof r !== "object") continue;
        const rule = Array.isArray(r) ? null : RULES[key];
        if (rule) {
          const refs = new Set();
          if (rule.shelfOwner) {
            for (const f of rule.shelfOwner) collectChannelRefs(r[f], refs, 0);
          } else if (rule.whole) {
            collectChannelRefs(r, refs, 0);
          } else {
            for (const f of BYLINE_FIELDS) if (r[f] !== undefined) collectChannelRefs(r[f], refs, 0);
          }
          const channelish = !!(rule.whole || rule.shelfOwner);
          const videoId = channelish || !rule.videoIds ? null : pickStr(r, rule.videoIds);
          if (refs.size || videoId) {
            items.push({
              channelRefs: [...refs],
              videoId,
              videoTitle: videoId && rule.titles ? pickText(r, rule.titles) : "",
              lengthText: videoId && rule.lengths ? pickText(r, rule.lengths) : "",
              publishedText: videoId && rule.published ? pickText(r, rule.published) : "",
              isPlaylist: !!rule.isPlaylist
            });
            sites.push({ parent: node, key });
          }
        }
        walk(r, depth + 1);
      }
    };
    walk(root, 0);
    return { sites, items };
  }

  function isEmptyish(v) {
    if (Array.isArray(v)) return v.length === 0;
    return !!v && typeof v === "object" && Object.keys(v).length === 0;
  }

  // After the deletions, collapse what they left behind: an object emptied of
  // all its keys is spliced out of its array, and a PRUNE_EMPTY key whose
  // value went empty is dropped. That is what makes a `{videoRenderer: ...}`
  // wrapper disappear rather than leaving a hole in the grid.
  function prune(node, depth) {
    if (!node || typeof node !== "object" || depth > 40) return false;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) {
        if (prune(node[i], depth + 1)) node.splice(i, 1);
      }
      return false;
    }
    for (const key of Object.keys(node)) {
      const child = node[key];
      if (!child || typeof child !== "object") continue;
      prune(child, depth + 1);
      if (isEmptyish(child) && PRUNE_EMPTY.has(key)) delete node[key];
    }
    return Object.keys(node).length === 0;
  }

  // ---------- asking content.js ----------

  let nextJudgeId = 1;
  const pending = new Map();

  // Resolves to the list of blocked indices. content.js always answers, but a
  // page where the content script failed to load must not hang on us, so this
  // gives up and removes nothing — the same "a miss is only latency" bargain
  // the whole layer rests on.
  const JUDGE_TIMEOUT_MS = 2000;
  function judge(items) {
    return new Promise((resolve) => {
      const id = nextJudgeId++;
      const timer = setTimeout(() => {
        if (pending.delete(id)) {
          dbg("no verdict in", JUDGE_TIMEOUT_MS, "ms — leaving the response alone");
          resolve([]);
        }
      }, JUDGE_TIMEOUT_MS);
      pending.set(id, (blocked) => {
        clearTimeout(timer);
        resolve(blocked);
      });
      window.postMessage({ __blocktube: "judge", id, items }, location.origin);
    });
  }

  // Describe -> ask -> delete -> prune. Returns how many renderers went.
  async function filterData(data, what) {
    if (!active || !data || typeof data !== "object") return 0;
    let sites;
    let items;
    try {
      ({ sites, items } = collect(data));
    } catch (e) {
      dbg("collect threw on", what, e);
      return 0;
    }
    if (!items.length) return 0;
    stats.candidates += items.length;
    const blocked = await judge(items);
    if (!blocked.length) return 0;
    try {
      for (const i of blocked) {
        const site = sites[i];
        if (site) delete site.parent[site.key];
      }
      prune(data, 0);
    } catch (e) {
      dbg("apply threw on", what, e);
      return 0;
    }
    stats.removed += blocked.length;
    dbg(what, "->", blocked.length, "of", items.length, "removed");
    return blocked.length;
  }

  // ---------- hook: the fetches behind search and channel tabs ----------
  //
  // `/search` is search results and their continuations; `/browse` is every
  // channel tab, the home/subscriptions feeds, and their infinite-scroll
  // continuations. `/next` (watch-page sidebar) and `/player` are left alone
  // deliberately: the sidebar is already removed outright by `removeRelated`
  // for most users, and touching `/player` risks the playback path.
  const HOOKED = ["/youtubei/v1/search", "/youtubei/v1/browse"];
  const origFetch = window.fetch;

  window.fetch = function (resource, init) {
    let url = "";
    try {
      url = typeof resource === "string" ? resource : resource && resource.url ? resource.url : "";
    } catch {
      url = "";
    }
    if (!active || !url || !HOOKED.some((u) => url.includes(u))) {
      return origFetch.call(this, resource, init);
    }

    return origFetch.call(this, resource, init).then(async (resp) => {
      // Anything unexpected here hands back the ORIGINAL response untouched —
      // a broken body breaks the page, and the DOM scrub is standing by to
      // catch whatever we failed to filter.
      if (!resp || !resp.ok) return resp;
      try {
        const body = await resp.clone().text();
        const data = JSON.parse(body);
        stats.responses += 1;
        if (!(await filterData(data, url.replace(/\?.*$/, "")))) return resp;
        return new Response(JSON.stringify(data), {
          status: resp.status,
          statusText: resp.statusText,
          headers: resp.headers
        });
      } catch (e) {
        dbg("could not rewrite", url, e);
        return resp;
      }
    });
  };

  // ---------- hook: the first paint ----------
  //
  // YouTube's HTML sets `window.ytInitialData = {...}` in an inline script,
  // and its Polymer bundle reads it once that bundle has loaded — a separate
  // network round-trip later. We use that gap: on write, start asking about
  // it; when the verdict lands, edit the stored object in place. If Polymer
  // reads it first it gets the unfiltered object, and the pre-paint CSS plus
  // the DOM scrub do their usual job.
  //
  // Nothing is deferred and nothing waits on us, deliberately. Upstream
  // BlockTube queues YouTube's own bootstrap until its blocklist arrives,
  // which filters the first paint reliably but means a blocklist that never
  // arrives wedges the page. This is the opposite trade: never wedge, and win
  // the first paint only when we genuinely get there first.
  let rawInitialData;
  try {
    Object.defineProperty(window, "ytInitialData", {
      configurable: true,
      enumerable: true,
      get() {
        return rawInitialData;
      },
      set(v) {
        rawInitialData = v;
        if (!active || !v || typeof v !== "object") return;
        const target = v;
        filterData(target, "ytInitialData").then((n) => {
          if (target !== rawInitialData) return; // superseded by a later write
          stats.initialData = n ? `filtered (${n})` : "filtered (0)";
        });
      }
    });
  } catch (e) {
    dbg("could not hook ytInitialData", e);
  }

  // ---------- talking to content.js ----------

  window.addEventListener(
    "message",
    (e) => {
      if (e.source !== window) return;
      const d = e.data;
      if (!d) return;
      if (d.__blocktube === "config") {
        const was = active;
        active = !!d.active;
        dbg("active:", active);
        // A blocklist that arrives after ytInitialData was written still gets
        // a shot at it, as long as Polymer hasn't read it yet.
        if (!was && active && rawInitialData) {
          const target = rawInitialData;
          filterData(target, "ytInitialData (late)").then((n) => {
            if (n) stats.initialData = `filtered late (${n})`;
          });
        }
        return;
      }
      if (d.__blocktube === "verdict") {
        const resolve = pending.get(d.id);
        if (resolve) {
          pending.delete(d.id);
          resolve(Array.isArray(d.blocked) ? d.blocked : []);
        }
      }
    },
    false
  );

  // content.js may come up before or after this file, so announce rather than
  // assume. It replies with a "config", and posts one again whenever the
  // blocklist or filters change.
  window.postMessage({ __blocktube: "hello" }, location.origin);
})();
