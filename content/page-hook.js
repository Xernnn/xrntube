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
// startup with "Cannot destructure property 'MSG' of 'self.XrnTube'".
// Confirmed live in both entry orders, and with dynamic
// `scripting.registerContentScripts` too. The MAIN entry therefore lists this
// file and nothing else, and the only way to keep ONE copy of the decision is
// to keep the decision out of this world entirely.
//
// It is also NOT a replacement for the DOM scrub. It filters
// `/youtubei/v1/search`, `/youtubei/v1/browse`, `/youtubei/v1/next` and
// `/youtubei/v1/get_watch` — search results, channel tabs, the watch page's
// related column, and the continuations all of them page in with. Anything it misses (an endpoint it
// doesn't hook, a renderer with no rule, a shape that changed this morning)
// is still caught downstream. **A miss here is a latency regression, never a
// blocking failure** — with one exception, now that the related column
// renders its uploader as unlinked text: there the DOM has nothing to catch,
// so `/next` is the only layer that sees the channel at all.
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
    if (DEBUG) console.debug("%c[XrnTube/data]", "color:#07c;font-weight:bold", ...a);
  };

  // Set by content.js: false while the blocklist is empty and no filters are
  // set, in which case there is nothing this layer could remove and it must
  // not pay to clone, read and parse every response.
  let active = false;

  // Also set by content.js, once this page view has paged in several whole
  // responses without a single video surviving (see noteJudgedRound there).
  // While it is on, every response we touch loses its continuation.
  let exhausted = false;

  // The `hideAutoChapters` switch, passed down with the config. Independent of
  // `active`: it applies with an empty blocklist too.
  let hideAutoChapters = false;

  // ---------- YouTube's auto-generated ("AI") chapters ----------
  //
  // A video whose creator wrote no chapters gets machine-made ones. On the
  // page the two kinds are the same elements, so only the watch response can
  // tell them apart: the player bar's markers are keyed "AUTO_CHAPTERS" (the
  // creator's: "DESCRIPTION_CHAPTERS") in
  // `multiMarkersPlayerBarRenderer.markersMap`, and their side panel is
  // `engagement-panel-macro-markers-auto-chapters` (the creator's:
  // `…-description-chapters`). Every other surface of the auto ones — the
  // description's chapter cards, the "Chapters" chip in a panel header, the
  // chapter button on the player bar — is a command pointing at that panel.
  //
  // A switch, not a verdict, so there is nothing to ask content.js: this runs
  // synchronously, before YouTube reads the data. Returns how many it removed.
  const AUTO_CHAPTERS_KEY = "AUTO_CHAPTERS";
  const AUTO_CHAPTERS_PANEL = "engagement-panel-macro-markers-auto-chapters";
  const mentionsAutoPanel = (node) => JSON.stringify(node).includes(AUTO_CHAPTERS_PANEL);

  function isAutoChapterItem(el) {
    if (el.key === AUTO_CHAPTERS_KEY) return true; // a markersMap entry
    const panel = el.engagementPanelSectionListRenderer;
    if (panel) return panel.panelIdentifier === AUTO_CHAPTERS_PANEL || panel.targetId === AUTO_CHAPTERS_PANEL;
    // The description's chapter cards / a panel header's "Chapters" chip. Any
    // other card list or chip never mentions the auto panel.
    if (el.horizontalCardListRenderer || el.chipViewModel) return mentionsAutoPanel(el);
    return false;
  }

  function stripAutoChapters(node, depth) {
    if (!node || typeof node !== "object" || depth > 60) return 0;
    let n = 0;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) {
        const el = node[i];
        if (el && typeof el === "object" && !Array.isArray(el) && isAutoChapterItem(el)) {
          node.splice(i, 1);
          n += 1;
        } else {
          n += stripAutoChapters(el, depth + 1);
        }
      }
      return n;
    }
    if (node.visibleOnLoad && node.visibleOnLoad.key === AUTO_CHAPTERS_KEY) {
      delete node.visibleOnLoad;
      n += 1;
    }
    if (node.playerBarActionButton && mentionsAutoPanel(node.playerBarActionButton)) {
      delete node.playerBarActionButton;
      n += 1;
    }
    for (const k of Object.keys(node)) n += stripAutoChapters(node[k], depth + 1);
    return n;
  }

  // Only a watch response carries chapters; skip the walk for everything else.
  // ytInitialData and `/next` are that response itself; `/get_watch` (in-app
  // navigation) bundles it as `[{ playerResponse }, { watchNextResponse }]`.
  function stripAutoChaptersFrom(data, what) {
    if (!hideAutoChapters || !data || typeof data !== "object") return 0;
    const roots = Array.isArray(data) ? data.map((part) => part && part.watchNextResponse).filter(Boolean) : [data];
    let n = 0;
    for (const root of roots) {
      if (!root.playerOverlays && !root.engagementPanels) continue;
      try {
        n += stripAutoChapters(root, 0);
      } catch (e) {
        dbg("auto-chapter strip threw on", what, e);
      }
    }
    if (n) dbg(what, "->", n, "auto-chapter piece(s) removed");
    return n;
  }

  // ---------- the top-bar logo, pointed at Subscriptions ----------
  //
  // The `logoToSubscriptions` switch. YouTube routes a logo click through the
  // endpoint in the data, not the anchor's href (the mobile logo is a
  // <button> with no href at all), so rewriting the href only fixed
  // middle-click: a plain click still went to the home feed, and the nav
  // guard then reloaded the page into Subscriptions. Swapping the endpoint
  // makes YouTube's own router go there in one in-app hop — measured live on
  // www and m.youtube.com: no document load, no home-feed request.
  //
  // The top bar is built once per page load, from ytInitialData. A switch
  // that arrives after that is too late for the data, so on desktop the
  // rendered element's own `data` is patched instead (Polymer re-renders the
  // href from it). Mobile's logo has no such property; there the nav guard's
  // bounce remains the fallback.
  let logoToSubscriptions = false;
  const SUBSCRIPTIONS_ENDPOINT = {
    commandMetadata: {
      webCommandMetadata: {
        url: "/feed/subscriptions",
        webPageType: "WEB_PAGE_TYPE_BROWSE",
        rootVe: 96368,
        apiUrl: "/youtubei/v1/browse"
      }
    },
    browseEndpoint: { browseId: "FEsubscriptions" }
  };
  const toSubscriptions = (endpoint) => ({ clickTrackingParams: endpoint.clickTrackingParams, ...SUBSCRIPTIONS_ENDPOINT });

  function retargetLogoIn(data) {
    if (!logoToSubscriptions || !data || !data.topbar) return;
    const tb = data.topbar;
    for (const logo of [
      tb.desktopTopbarRenderer && tb.desktopTopbarRenderer.logo && tb.desktopTopbarRenderer.logo.topbarLogoRenderer,
      tb.mobileTopbarRenderer && tb.mobileTopbarRenderer.topbarLogo && tb.mobileTopbarRenderer.topbarLogo.topbarLogoRenderer
    ]) {
      if (logo && logo.endpoint) logo.endpoint = toSubscriptions(logo.endpoint);
    }
  }

  function retargetRenderedLogo() {
    for (const el of document.querySelectorAll("ytd-topbar-logo-renderer")) {
      const d = el.data;
      const browseId = d && d.endpoint && d.endpoint.browseEndpoint && d.endpoint.browseEndpoint.browseId;
      if (browseId && browseId !== "FEsubscriptions") el.data = { ...d, endpoint: toSubscriptions(d.endpoint) };
    }
  }

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
  //   isShort     the tile is a Short, which never carries a publish date
  //   kindFrom    field naming what this renderer actually is, when one tag
  //               serves several kinds (lockupViewModel's `contentType`)
  //   bylinePaths dotted paths to the byline, for a renderer that buries it
  //               deeper than the generic BYLINE_FIELDS scan will go
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
    // Shorts. `isShort` is not cosmetic: a Short carries no publish date in
    // any response (this renderer has a title, a view count and nothing
    // else), and shared/block-logic.js needs to know the difference between
    // "the date hasn't arrived yet" and "there is no date" — otherwise an
    // age rule exempts every short the channel has. Same flag the DOM scrub
    // sets from a `/shorts/` link, so both layers answer alike.
    reelItemRenderer: { videoIds: V, titles: ["headline"], isShort: true },
    shortsLockupViewModel: {
      videoIds: ["onTap.innertubeCommand.reelWatchEndpoint.videoId"],
      titles: ["overlayMetadata.primaryText"],
      isShort: true
    },
    // The modern "view model" tile — search results and a channel's Playlists
    // tab render only this now, with no ytd-* wrapper at all. One tag covers
    // several kinds of tile and `contentType` says which
    // (`LOCKUP_CONTENT_TYPE_VIDEO` / `…_PLAYLIST` / `…_SHORTS` / …), so
    // `kindFrom` reads it: a playlist lockup's `contentId` is a `PL…` id, not
    // a video id, and taking it for one meant the tile was judged as a video
    // that nothing could date — which an age rule then let through for good.
    // This is the signal the DOM does not have; see extractInfo().
    lockupViewModel: {
      kindFrom: "contentType",
      // A lockup buries its byline: measured live, the channel's browseId sits
      // at
      //   metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel
      //     .metadataRows[0].metadataParts[0].text.commandRuns[0]
      //     .onTap.innertubeCommand.browseEndpoint.browseId
      // — thirteen levels down, where the generic scan stops at ten. So a
      // `videoRenderer` (shallow `shortBylineText`) matched and these did not:
      // a blocked channel's playlist cards sailed through search, and with an
      // age rule on the entry nothing downstream could ever remove them. The
      // path starts the scan AT the metadata rows, which keeps the walk short
      // and keeps it inside the tile's own byline block — the same reason
      // BYLINE_FIELDS names fields instead of scanning the renderer.
      bylinePaths: ["metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel.metadataRows"],
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
            if (rule.bylinePaths) {
              for (const path of rule.bylinePaths) collectChannelRefs(pick(r, path), refs, 0);
            }
            // The generic scan still runs when the deep path found nothing —
            // a shape that moved must fall back to "missed", never to a
            // different renderer's idea of the byline.
            if (!refs.size) {
              for (const f of BYLINE_FIELDS) if (r[f] !== undefined) collectChannelRefs(r[f], refs, 0);
            }
          }
          const channelish = !!(rule.whole || rule.shelfOwner);
          let videoId = channelish || !rule.videoIds ? null : pickStr(r, rule.videoIds);
          let isPlaylist = !!rule.isPlaylist;
          let isShort = !!rule.isShort;
          if (rule.kindFrom) {
            const kind = typeof r[rule.kindFrom] === "string" ? r[rule.kindFrom] : "";
            // A collection — playlist, podcast, album, show. It has no single
            // publish date, so it is judged as a playlist, and its id is not
            // a video id.
            if (/PLAYLIST|PODCAST|ALBUM|SHOW/.test(kind)) {
              isPlaylist = true;
              videoId = null;
            } else if (/SHORTS|REEL/.test(kind)) {
              isShort = true;
            }
          }
          if (refs.size || videoId || isPlaylist) {
            items.push({
              channelRefs: [...refs],
              videoId,
              videoTitle: videoId && rule.titles ? pickText(r, rule.titles) : "",
              lengthText: videoId && rule.lengths ? pickText(r, rule.lengths) : "",
              publishedText: videoId && rule.published ? pickText(r, rule.published) : "",
              isPlaylist,
              isShort
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

  // Take the "there is more where that came from" out of a response.
  // Removing the sentinel from the DOM is not enough on its own: YouTube
  // re-creates it from the next response and asks again. `continuationItem-
  // Renderer` is the sentinel itself and `continuations` is the older array
  // form of the same thing; with neither present there is nothing left to
  // trigger on, and the feed simply ends where it is.
  function stripContinuations(node, depth) {
    let n = 0;
    if (!node || typeof node !== "object" || depth > 40) return 0;
    if (Array.isArray(node)) {
      for (let i = node.length - 1; i >= 0; i -= 1) {
        const v = node[i];
        if (v && typeof v === "object" && !Array.isArray(v) && v.continuationItemRenderer) {
          node.splice(i, 1);
          n += 1;
          continue;
        }
        n += stripContinuations(v, depth + 1);
      }
      return n;
    }
    for (const key of Object.keys(node)) {
      if (key === "continuationItemRenderer" || key === "continuations") {
        delete node[key];
        n += 1;
        continue;
      }
      n += stripContinuations(node[key], depth + 1);
    }
    return n;
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
      window.postMessage({ __xrntube: "judge", id, items }, location.origin);
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
    let blocked = [];
    if (items.length) {
      stats.candidates += items.length;
      blocked = await judge(items);
    }
    // The verdict may be what flipped it, so read `exhausted` after judging.
    if (!blocked.length && !exhausted) return 0;
    let cut = 0;
    try {
      for (const i of blocked) {
        const site = sites[i];
        if (site) delete site.parent[site.key];
      }
      if (exhausted) cut = stripContinuations(data, 0);
      if (!blocked.length && !cut) return 0;
      prune(data, 0);
    } catch (e) {
      dbg("apply threw on", what, e);
      return 0;
    }
    stats.removed += blocked.length;
    dbg(what, "->", blocked.length, "of", items.length, "removed", cut ? `+ ${cut} continuation(s) cut` : "");
    return blocked.length + cut;
  }

  // ---------- hook: the fetches behind search, channel tabs and the sidebar ----------
  //
  // `/search` is search results and their continuations; `/browse` is every
  // channel tab, the home/subscriptions feeds, and their infinite-scroll
  // continuations; `/next` is the watch page's related column and its queue.
  // In-app navigation to a video now fetches `/get_watch` instead, which
  // bundles the same watch-next response with the player's:
  // `[{ playerResponse }, { watchNextResponse }]`. Without it, measured live,
  // every blocked channel's tile in a related column reached by clicking
  // (rather than loading the page) was shown — 4 of 4. It is streamed through
  // part by part (streamWatchParts), so the player keeps its head start.
  //
  // `/next` is here because the DOM cannot cover it. A related tile is a
  // `yt-lockup-view-model` whose only anchors are `/watch?v=…` — measured
  // live, 26 of them and not one channel link on the page: the uploader is
  // plain TEXT. So `tileChannels()` finds no channel, every channel block
  // misses, and the hover menu can only offer "Block this video". Matching
  // that text against a name would be guessing a channel, which is the one
  // thing we never do. The JSON still carries the byline's `browseEndpoint`,
  // so this is the only layer that can see it at all.
  //
  // `/player` stays alone deliberately — it is the playback path, and a
  // blocked video is caught by DNR and the nav guard well before it matters.
  const HOOKED = ["/youtubei/v1/search", "/youtubei/v1/browse", "/youtubei/v1/next", "/youtubei/v1/get_watch"];
  const origFetch = window.fetch;

  // Copy the headers, minus the ones that described the ORIGINAL body: we
  // changed its length, and content-encoding referred to a transfer encoding
  // the browser already undid. Nothing observed has depended on either, but
  // handing a response a length that disagrees with its body is the kind of
  // thing that breaks later rather than now.
  function rewrittenHeaders(resp) {
    const headers = new Headers();
    resp.headers.forEach((v, k) => {
      const n = k.toLowerCase();
      if (n !== "content-length" && n !== "content-encoding") headers.append(k, v);
    });
    return headers;
  }

  // `/get_watch` streams its parts — `[{player part}, {watch-next part}]` —
  // and YouTube starts playback from the first while the second is still on
  // its way. Buffering the whole body, as `/next` is, measured +0.9s from
  // click to playing. So this re-emits each top-level part byte for byte the
  // moment it is complete, and holds (and filters) only a part carrying a
  // watch-next response. The scan tracks strings and bracket depth, nothing
  // more; a body that isn't a JSON array passes through untouched.
  function streamWatchParts(resp, what) {
    const reader = resp.body.getReader();
    const dec = new TextDecoder();
    const enc = new TextEncoder();
    const finish = async (text) => {
      if (!text.includes('"watchNextResponse"')) return text;
      try {
        const obj = JSON.parse(text);
        stats.responses += 1;
        const n = stripAutoChaptersFrom([obj], what) + (await filterData(obj, what));
        return n ? JSON.stringify(obj) : text;
      } catch (e) {
        dbg("could not filter a part of", what, e);
        return text;
      }
    };
    const body = new ReadableStream({
      async start(controller) {
        const out = (s) => {
          if (s) controller.enqueue(enc.encode(s));
        };
        let mode = "head"; // before the opening "[" → "list"; anything else → "raw"
        let part = ""; // the current, still-open top-level part
        let depth = 0;
        let inStr = false;
        let esc = false;
        try {
          for (;;) {
            const { done, value } = await reader.read();
            const chunk = done ? dec.decode() : dec.decode(value, { stream: true });
            let from = 0; // start of the text in `chunk` not yet emitted or kept
            for (let i = 0; i < chunk.length && mode !== "raw"; i += 1) {
              const ch = chunk[i];
              if (mode === "head") {
                if (ch === "[") mode = "list";
                else if (!/\s/.test(ch)) mode = "raw";
              } else if (depth === 0) {
                if (ch === "{" || ch === "[") {
                  out(chunk.slice(from, i));
                  from = i;
                  depth = 1;
                }
              } else if (inStr) {
                if (esc) esc = false;
                else if (ch === "\\") esc = true;
                else if (ch === '"') inStr = false;
              } else if (ch === '"') {
                inStr = true;
              } else if (ch === "{" || ch === "[") {
                depth += 1;
              } else if ((ch === "}" || ch === "]") && --depth === 0) {
                part += chunk.slice(from, i + 1);
                from = i + 1;
                out(await finish(part));
                part = "";
              }
            }
            if (depth > 0) part += chunk.slice(from);
            else out(chunk.slice(from));
            if (done) break;
          }
          out(part); // a truncated body: hand back what there is, unchanged
          controller.close();
        } catch (e) {
          controller.error(e);
        }
      }
    });
    return new Response(body, { status: resp.status, statusText: resp.statusText, headers: rewrittenHeaders(resp) });
  }

  window.fetch = function (resource, init) {
    let url = "";
    try {
      url = typeof resource === "string" ? resource : resource && resource.url ? resource.url : "";
    } catch {
      url = "";
    }
    if (!(active || hideAutoChapters) || !url || !HOOKED.some((u) => url.includes(u))) {
      return origFetch.call(this, resource, init);
    }

    return origFetch.call(this, resource, init).then(async (resp) => {
      // Anything unexpected here hands back the ORIGINAL response untouched —
      // a broken body breaks the page, and the DOM scrub is standing by to
      // catch whatever we failed to filter.
      if (!resp || !resp.ok) return resp;
      const what = url.replace(/\?.*$/, "");
      if (what.endsWith("/get_watch") && resp.body) return streamWatchParts(resp, what);
      try {
        const body = await resp.clone().text();
        const data = JSON.parse(body);
        stats.responses += 1;
        const chapters = body.includes(AUTO_CHAPTERS_KEY) ? stripAutoChaptersFrom(data, what) : 0;
        if (!((await filterData(data, what)) + chapters)) return resp;
        return new Response(JSON.stringify(data), {
          status: resp.status,
          statusText: resp.statusText,
          headers: rewrittenHeaders(resp)
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
        stripAutoChaptersFrom(v, "ytInitialData");
        try {
          retargetLogoIn(v);
        } catch (e) {
          dbg("logo retarget threw", e);
        }
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
      // content.js started after our "hello" went out and asks again; the
      // popup's health line reads "the early filter is running" off this.
      if (d.__xrntube === "ping") {
        window.postMessage({ __xrntube: "hello" }, location.origin);
        return;
      }
      if (d.__xrntube === "config") {
        const was = active;
        active = !!d.active;
        exhausted = !!d.exhausted;
        const chaptersWas = hideAutoChapters;
        hideAutoChapters = !!d.hideAutoChapters;
        dbg("active:", active, exhausted ? "(exhausted — continuations will be cut)" : "");
        // Same late chance as the blocklist below, for a switch that arrives
        // after ytInitialData was written.
        if (!chaptersWas && hideAutoChapters && rawInitialData) stripAutoChaptersFrom(rawInitialData, "ytInitialData (late)");
        const logoWas = logoToSubscriptions;
        logoToSubscriptions = !!d.logoToSubscriptions;
        if (!logoWas && logoToSubscriptions) {
          try {
            retargetLogoIn(rawInitialData);
            retargetRenderedLogo();
          } catch (e) {
            dbg("logo retarget threw", e);
          }
        }
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
      if (d.__xrntube === "verdict") {
        const resolve = pending.get(d.id);
        if (resolve) {
          pending.delete(d.id);
          resolve(Array.isArray(d.blocked) ? d.blocked : []);
        }
      }
    },
    false
  );

  // The one gap the two calls above leave: a switch that lands after YouTube
  // read ytInitialData but before it built the top bar. Patching again once
  // each page view has rendered closes it, at the cost of one querySelectorAll.
  window.addEventListener("yt-navigate-finish", () => {
    if (logoToSubscriptions) retargetRenderedLogo();
  });

  // content.js may come up before or after this file, so announce rather than
  // assume (and answer its "ping", for when it comes up after). It replies
  // with a "config", and posts one again whenever the blocklist or filters
  // change.
  window.postMessage({ __xrntube: "hello" }, location.origin);
})();
