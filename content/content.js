(() => {
  const { MSG, CHANNEL_MODE, DEFAULT_SETTINGS, SETTINGS_KEY, KEYWORDS_KEY, ALLOWLIST_KEY } = self.BlockTube;

  // Where blocked content — and now Home and Shorts entirely — get sent instead.
  const SAFE_LANDING_URL = "https://www.youtube.com/feed/subscriptions";

  // User-configurable feature toggles (options page). Every non-blocklist
  // behaviour — Shorts removal, homepage redirect, sidebar/masthead cleanup,
  // related-videos & end-screen removal — is gated on one of these. Blocklist
  // enforcement itself is NOT toggleable (it's the point of the extension).
  // Defaults are all-on, so an install with no saved settings behaves exactly
  // as before; the real values arrive async from chrome.storage.sync just after
  // document_start (see the loader near the bottom).
  let settings = { ...DEFAULT_SETTINGS };

  // ---------- debug mode ----------
  // Enable with ?bt-debug in the URL or localStorage.setItem("bt_debug","1").
  // Logs every removal with a reason, and exposes window.__blockTube for
  // "why isn't this blocking?" — the recurring failure mode being a channel
  // whose key format on the tile doesn't match how it's stored.
  const DEBUG = (() => {
    try {
      return /[?&]bt-debug\b/.test(location.search) || localStorage.getItem("bt_debug") === "1";
    } catch {
      return /[?&]bt-debug\b/.test(location.search);
    }
  })();
  function dbg(...a) {
    if (DEBUG) console.debug("%c[BlockTube]", "color:#c00;font-weight:bold", ...a);
  }

  // ---------- UI-language labels ----------
  // Almost all of YouTube's chrome is matched here by tag name, href, or a
  // stable id/class — all locale-proof. A few things have no such handle and
  // can only be matched by their visible text: the watch-page action buttons
  // (Share / Save / Clip / Thanks / Download / More), the masthead Create and
  // voice-search buttons, the "Join" membership button + "Members only" badge,
  // and the guide's Explore / "More from YouTube" / "Report history" entries.
  // Those read from LABELS[lang] below, with the English terms always merged in
  // (YouTube frequently leaves some controls in English on a partly-localised
  // UI). A language that isn't listed just gets the English set. To add one,
  // copy the `en` block and translate the strings — all lowercase, and include
  // every wording variant you see (comma-separated is fine as separate array
  // items). The relative-date parser (parseAgeDays) is separate and already
  // language-independent (see AGE_UNITS).
  const UI_LANG = (() => {
    const primary = (s) => (s || "").toLowerCase().split(/[-_]/)[0];
    try {
      return (
        primary(document.documentElement.getAttribute("lang")) ||
        primary(navigator.language) ||
        "en"
      );
    } catch {
      return "en";
    }
  })();
  const LABELS_BY_LANG = {
    en: {
      share: ["share"],
      save: ["save", "save to playlist"],
      clip: ["clip"],
      thanks: ["thanks"],
      download: ["download"],
      more: ["more actions"],
      report: ["report"],
      create: ["create"],
      voice: ["search with your voice", "voice search"],
      join: ["join"],
      membersOnly: ["members only", "member only"],
      membership: ["membership", "memberships", "members-only content", "members only content"],
      explore: ["explore"],
      moreFromYouTube: ["more from youtube"],
      reportHistory: ["report history"],
      shorts: ["shorts"]
    },
    vi: {
      share: ["chia sẻ"],
      save: ["lưu", "lưu vào danh sách phát"],
      clip: ["đoạn video", "clip"],
      thanks: ["cảm ơn"],
      download: ["tải xuống"],
      more: ["thao tác khác"],
      report: ["báo cáo"],
      create: ["tạo"],
      voice: ["tìm kiếm bằng giọng nói"],
      join: ["tham gia"],
      membersOnly: ["chỉ dành cho thành viên"],
      membership: ["tư cách thành viên", "nội dung chỉ dành cho thành viên"],
      explore: ["khám phá"],
      moreFromYouTube: ["thêm từ youtube"],
      reportHistory: ["nhật ký báo cáo", "lịch sử báo cáo"],
      shorts: ["shorts"]
    },
    es: {
      share: ["compartir"],
      save: ["guardar", "guardar en lista de reproducción"],
      clip: ["recortar", "clip"],
      thanks: ["gracias"],
      download: ["descargar"],
      more: ["más acciones"],
      report: ["denunciar"],
      create: ["crear"],
      voice: ["buscar con la voz", "búsqueda por voz"],
      join: ["unirse"],
      membersOnly: ["solo para miembros", "sólo para miembros"],
      membership: ["membresía", "membresías", "contenido solo para miembros"],
      explore: ["explorar"],
      moreFromYouTube: ["más de youtube"],
      reportHistory: ["historial de denuncias"],
      shorts: ["shorts"]
    },
    pt: {
      share: ["compartilhar", "partilhar"],
      save: ["salvar", "guardar", "salvar na playlist"],
      clip: ["clipe", "clip"],
      thanks: ["agradecer", "obrigado"],
      download: ["fazer o download", "transferir", "baixar"],
      more: ["mais ações"],
      report: ["denunciar"],
      create: ["criar"],
      voice: ["pesquisar com a voz", "pesquisa por voz"],
      join: ["participar", "tornar-se membro"],
      membersOnly: ["apenas para membros", "só para membros"],
      membership: ["assinatura do canal", "associação", "conteúdo exclusivo para membros"],
      explore: ["explorar"],
      moreFromYouTube: ["mais do youtube"],
      reportHistory: ["histórico de denúncias"],
      shorts: ["shorts"]
    },
    fr: {
      share: ["partager"],
      save: ["enregistrer", "enregistrer dans une playlist"],
      clip: ["extrait", "clip"],
      thanks: ["merci"],
      download: ["télécharger"],
      more: ["plus d'actions"],
      report: ["signaler"],
      create: ["créer"],
      voice: ["recherche vocale", "effectuer une recherche vocale"],
      join: ["adhérer", "rejoindre"],
      membersOnly: ["réservé aux membres"],
      membership: ["abonnement à la chaîne", "adhésion", "contenu réservé aux membres"],
      explore: ["explorer"],
      moreFromYouTube: ["plus de youtube"],
      reportHistory: ["historique des signalements"],
      shorts: ["shorts"]
    },
    de: {
      share: ["teilen"],
      save: ["speichern", "in playlist speichern"],
      clip: ["clip"],
      thanks: ["danke", "danken"],
      download: ["herunterladen", "download"],
      more: ["weitere aktionen"],
      report: ["melden"],
      create: ["erstellen"],
      voice: ["sprachsuche", "mit der stimme suchen"],
      join: ["beitreten"],
      membersOnly: ["nur für mitglieder"],
      membership: ["mitgliedschaft", "mitgliedschaften", "nur für mitglieder verfügbare inhalte"],
      explore: ["entdecken"],
      moreFromYouTube: ["mehr von youtube"],
      reportHistory: ["meldeverlauf"],
      shorts: ["shorts"]
    }
  };
  const L = (() => {
    const en = LABELS_BY_LANG.en;
    const loc = LABELS_BY_LANG[UI_LANG];
    if (!loc || loc === en) return en;
    const out = {};
    for (const k of Object.keys(en)) {
      out[k] = Array.from(new Set([...(loc[k] || []), ...en[k]]));
    }
    return out;
  })();
  if (DEBUG) dbg("UI language:", UI_LANG, LABELS_BY_LANG[UI_LANG] ? "(table found)" : "(English fallback)");

  // CSS attribute-selector list matching aria-label against any of `labels`.
  // exact: [aria-label="x" i]  ·  substring: [aria-label*="x" i]
  const cssEsc = (s) => s.replace(/["\\]/g, "\\$&");
  function ariaSel(prefix, labels, { substring = false } = {}) {
    const op = substring ? "*=" : "=";
    return labels.map((l) => `${prefix}[aria-label${op}"${cssEsc(l)}" i]`).join(",\n      ");
  }

  // ---------- instant, pre-paint hiding via CSS (not just MutationObserver + remove()) ----------
  // A MutationObserver callback always runs at least one animation frame
  // after YouTube inserts a node — usually imperceptible, but during a big
  // burst of search-result insertions a blocked tile can still flash for a
  // frame before JS catches up to it. `:has()` is matched continuously by
  // the browser's own style engine as part of the same layout pass that
  // inserts the node, so a rule built from it hides the tile before it's
  // ever painted — no JS turn required at all. Injected as the very first
  // thing this script does. The JS-based scrub elsewhere still runs after —
  // it's what actually deletes the node (this only hides it), and it's the
  // only thing that works at all in a browser without :has() support.
  const instantHideStyle = document.createElement("style");
  instantHideStyle.id = "bt-instant-hide";
  (document.documentElement || document).appendChild(instantHideStyle);

  // Static instant-hide rules — don't depend on the blocklist, but DO depend on
  // the feature toggles, so this is rebuilt whenever settings change. Each
  // block is emitted only if its toggle is on.
  const STATIC_CSS_PARTS = {
    cleanSidebar: `
      ytd-mini-guide-entry-renderer:has(> a[href="/"]),
      ytd-mini-guide-entry-renderer:has(> a[href="/shorts/"]),
      ytd-guide-entry-renderer:has(> a[href="/"]),
      ytd-guide-entry-renderer:has(> a[title="Shorts" i]),
      ytd-guide-entry-renderer:has(> a[title="Report history" i]),
      ytm-pivot-bar-item-renderer:has(a[href="/"]),
      ytm-pivot-bar-item-renderer:has(a[href="/shorts/"]),
      ytm-guide-entry-renderer:has(a[href="/"]),
      ytm-guide-entry-renderer:has(a[href="/shorts/"])
        { display: none !important; }`,
    cleanMasthead: `
      ${ariaSel("ytd-masthead ", L.create)},
      ytd-masthead [aria-label*="notification" i],
      ytd-notification-topbar-button-renderer
        { display: none !important; }`,
    hideVoiceSearch: `
      #voice-search-button,
      ${ariaSel("ytd-masthead ", L.voice)},
      .mobile-topbar-header [aria-label*="voice" i]
        { display: none !important; }`,
    accountButtonOnHover: `
      ytd-masthead ytd-topbar-menu-button-renderer:has(#avatar-btn),
      ytd-masthead #avatar-btn {
        opacity: 0 !important;
        transition: opacity 0.12s ease;
      }
      ytd-masthead #end:hover ytd-topbar-menu-button-renderer:has(#avatar-btn),
      ytd-masthead #end:hover #avatar-btn,
      ytd-masthead ytd-topbar-menu-button-renderer:has(#avatar-btn):hover,
      ytd-masthead #avatar-btn:hover {
        opacity: 1 !important;
      }`,
    hideVideoActions: `
      ytd-watch-metadata #actions yt-button-view-model:has(:is(${ariaSel("", [].concat(L.share, L.save, L.clip, L.thanks))})),
      ytd-watch-metadata #actions ytd-download-button-renderer,
      ytd-watch-metadata #actions yt-icon-button:has(:is(${ariaSel("", L.more)}))
        { display: none !important; }`,
    hideMemberships: `
      /* the "Join" (channel membership) button, watch page + channel page */
      #sponsor-button,
      ytd-sponsor-button-renderer,
      yt-sponsor-button-view-model
        { display: none !important; }
      /* legacy members-only tile badge (the new badge-shape one is matched by
         text in scrubMembersOnly since its class is shared with other badges) */
      :is(${["ytd-rich-item-renderer", "ytd-video-renderer", "ytd-grid-video-renderer", "ytd-compact-video-renderer", "yt-lockup-view-model"].join(",")}):has(.badge-style-type-members-only)
        { display: none !important; }`,
    removeRelated: `
      #secondary, #secondary-inner,
      ytd-watch-next-secondary-results-renderer { display: none !important; }
      /* Reclaim the space the related column left (was content.css). Rather
         than going full-width — which on a wide screen makes a 16:9 player
         taller than the viewport, pushing the title below the fold — cap the
         column so the player's height is at most (viewport - masthead - room
         for the title). Width follows from that. Also: YouTube's JS had sized
         the player from the OLD 2-column layout (leaving a right gap and, at
         some widths, a horizontal scrollbar that made arrow keys pan the
         page), so force the inner chain to fill the (capped) column and clip
         sideways scroll on the app. Theater mode is already handled by
         YouTube — leave it alone. */
      ytd-watch-flexy:not([theater]) #columns.ytd-watch-flexy {
        max-width: 100% !important;
        padding-right: 0 !important;
      }
      ytd-watch-flexy:not([theater]) #primary.ytd-watch-flexy {
        max-width: min(100%, max(426px, calc((100vh - 144px) * 16 / 9))) !important;
        width: 100% !important;
        min-width: 0 !important;
        margin-right: 0 !important;
        padding-right: 0 !important;
      }
      ytd-watch-flexy:not([theater]) #primary-inner,
      ytd-watch-flexy:not([theater]) #player-container-outer,
      ytd-watch-flexy:not([theater]) #player-container,
      ytd-watch-flexy:not([theater]) #player.ytd-watch-flexy,
      ytd-watch-flexy:not([theater]) #player-wide-container {
        max-width: 100% !important;
        width: 100% !important;
      }
      ytd-app { overflow-x: clip !important; }`,
    hideSearchSuggestions: `
      /* the autocomplete dropdown under the search box */
      .ytSearchboxComponentSuggestionsContainer,
      ytd-search-suggestions-section,
      tp-yt-paper-listbox#suggestions,
      #suggestions.ytd-searchbox,
      ytmusic-search-suggestions-section,
      .mobile-topbar-searchbox-suggestions
        { display: none !important; }`,
    removeEndScreen: `
      /* modern end screen (ytp-delhi / "fullscreen grid" player revision) */
      .ytp-fullscreen-grid,
      .ytp-modern-videowall-still,
      /* legacy end screen + in-player cards / teaser */
      .html5-endscreen,
      .ytp-endscreen-content,
      .ytp-videowall-still,
      .ytp-ce-element,
      .ytp-ce-covering-overlay,
      .ytp-ce-covering-image,
      .ytp-ce-expanding-image,
      .ytp-cards-teaser
        { display: none !important; }`,
    removeShorts: `
      ytd-reel-shelf-renderer,
      ytm-reel-shelf-renderer,
      ytd-reel-item-renderer,
      ytd-reel-video-renderer,
      ytm-shorts-lockup-view-model,
      ytm-shorts-lockup-view-model-v2,
      ytm-reel-item-renderer,
      grid-shelf-view-model:has(ytm-shorts-lockup-view-model-v2, ytm-shorts-lockup-view-model, a[href*="/shorts/"]),
      ytd-rich-shelf-renderer:has(ytd-reel-item-renderer, a[href*="/shorts/"]),
      ytm-rich-shelf-renderer:has(ytd-reel-item-renderer, a[href*="/shorts/"])
        { display: none !important; }`
  };
  function buildStaticCSS() {
    return Object.keys(STATIC_CSS_PARTS)
      .filter((k) => settings[k])
      .map((k) => STATIC_CSS_PARTS[k])
      .join("\n");
  }
  let staticInstantHideCSS = buildStaticCSS();
  instantHideStyle.textContent = staticInstantHideCSS;

  // Renderer tags that represent "one video/short/playlist tile" across every
  // surface: home grid, search results, watch-page sidebar, channel pages,
  // playlists (both the playlist tile itself and videos inside an open
  // playlist/queue), shorts shelves. m.youtube.com (Firefox for Android) uses
  // ytm- prefixed equivalents with a similar shape.
  const RENDERER_SELECTOR = [
    "ytd-rich-item-renderer",
    "ytd-video-renderer",
    "ytd-compact-video-renderer",
    "ytd-grid-video-renderer",
    "ytd-playlist-video-renderer",
    "ytd-playlist-panel-video-renderer",
    "ytd-reel-item-renderer",
    "ytd-playlist-renderer",
    "ytd-grid-playlist-renderer",
    "ytd-compact-playlist-renderer",
    "ytd-radio-renderer",
    "ytd-compact-radio-renderer",
    // Channel tiles themselves (search results' "channel" card, sidebar
    // "people also watch" cards, a channel's own "Channels" tab) — without
    // these, a searched-for blocked channel's card just sat there until you
    // clicked into it and got bounced.
    "ytd-channel-renderer",
    "ytd-compact-channel-renderer",
    "ytd-grid-channel-renderer",
    "ytm-rich-item-renderer",
    "ytm-compact-video-renderer",
    "ytm-video-with-context-renderer",
    "ytm-shorts-lockup-view-model",
    "ytm-playlist-video-renderer",
    "ytm-compact-playlist-renderer",
    "ytm-channel-renderer",
    "ytm-compact-channel-renderer"
  ].join(",");

  // YouTube is migrating tiles to a new component family ("view models")
  // that shares nothing with the ytd-*/ytm-* custom elements above — spot
  // checked live: a channel's own "Playlists" tab and playlist results in
  // search now render *only* `yt-lockup-view-model`, no ytd-playlist-renderer
  // at all, which is exactly why a blocked channel's playlists were still
  // getting through. Other surfaces (e.g. a channel's "Videos" tab) still
  // wrap it *inside* one of the old tags above as a transitional shim — in
  // that case the outer tag already gets swept correctly, so a bare
  // `yt-lockup-view-model` is only ever processed on its own when nothing
  // above already claims one of its ancestors (see queryTiles() below).
  const LOCKUP_SELECTOR = "yt-lockup-view-model";

  // Every tile-like element in `root`, whether it's one of the legacy
  // ytd-*/ytm-* tags or a standalone `yt-lockup-view-model` — but not a
  // `yt-lockup-view-model` nested inside a legacy tag, since that tag
  // already covers it (avoids double block-buttons / double removal).
  function queryTiles(root) {
    if (!root.querySelectorAll) return [];
    const tiles = Array.from(root.querySelectorAll(RENDERER_SELECTOR));
    root.querySelectorAll(LOCKUP_SELECTOR).forEach((el) => {
      if (!el.closest(RENDERER_SELECTOR)) tiles.push(el);
    });
    return tiles;
  }

  function cssStringEscape(s) {
    return String(s).replace(/["\\]/g, "\\$&");
  }

  // Last blocklist maps handed to updateInstantHideBlocklistCSS — stashed so
  // applySettings() can rebuild the stylesheet (static + blocklist halves)
  // when a toggle changes, without waiting for the next BLOCKLIST_UPDATED.
  let lastAppliedChannels = {};
  let lastAppliedVideos = {};

  // Rebuilds the blocklist-driven half of the instant-hide stylesheet (see
  // top of file) so a blocked channel/video is hidden the instant a matching
  // tile appears anywhere, via :has(), rather than waiting for the next
  // MutationObserver-driven pass. Large blocklists mean a large selector —
  // :has() isn't free, so this is worth keeping an eye on if it's ever
  // measurably slow with a few hundred entries blocked.
  // The instant-hide CSS is a pre-paint optimisation; the JS MutationObserver
  // scrub is the actual enforcement. A blocklist of a few thousand entries
  // would put thousands of `a[href=…]` selectors into one `:has()` that the
  // style engine re-checks on every recalc — measurable jank. So the CSS only
  // covers the most-recently-blocked N (newest = most likely to be scrolling
  // past right now); the rest are caught by the JS scrub one frame later.
  const INSTANT_HIDE_MAX_CHANNELS = 1500;
  const INSTANT_HIDE_MAX_VIDEOS = 500;
  function newestFirst(obj, cap) {
    return Object.entries(obj || {})
      .sort((a, b) => (b[1] && b[1].ts ? b[1].ts : 0) - (a[1] && a[1].ts ? a[1].ts : 0))
      .slice(0, cap);
  }

  function updateInstantHideBlocklistCSS(channels, videos) {
    // FULL-blocked channels + individually-blocked videos: hide the tile
    // outright, same rule for all of them.
    const inner = [];
    // EXCEPT_WHITELIST channels each need their own rule, since each has a
    // different whitelist — "hide any tile that (a) links to this channel,
    // (b) looks like an actual video/short (not a bare channel card, which
    // must stay visible per CHANNEL_MODE), and (c) isn't one of the
    // whitelisted video IDs".
    const exceptRules = [];

    for (const [key, entry] of newestFirst(channels, INSTANT_HIDE_MAX_CHANNELS)) {
      // Allow-listed channels are never hidden — skip their pre-paint rule too
      // (also covers the entry's scraped handle/ucid, which isAllowlisted sees
      // only via the storage key; check those explicitly).
      if (
        isAllowlisted(key) ||
        (entry && entry.handle && isAllowlisted(entry.handle)) ||
        (entry && entry.ucid && isAllowlisted(entry.ucid))
      ) {
        continue;
      }
      // Modern YouTube tiles link the channel byline via /@handle, not
      // /channel/UC…. An imported list is keyed by UC… ids, so prefer the
      // entry's scraped `handle` for matching; fall back to /channel/UC…
      // (still used on channel cards and by direct navigation) when there's
      // no handle yet. `i` so /@MKBHD matches a stored @mkbhd.
      const links = [];
      if (entry && entry.handle) {
        links.push(`a[href="${cssStringEscape("/" + entry.handle)}" i]`);
      }
      if (entry && entry.ucid) {
        links.push(`a[href="${cssStringEscape("/channel/" + entry.ucid)}"]`);
      }
      links.push(`a[href="${cssStringEscape(key.startsWith("@") ? "/" + key : "/channel/" + key)}"${key.startsWith("@") ? " i" : ""}]`);
      const channelLink = links.join(",");
      if (entry && entry.mode === CHANNEL_MODE.EXCEPT_WHITELIST) {
        // An age-ruled channel keeps its recent uploads visible, and CSS
        // can't tell a tile's publish date — so don't emit a blanket
        // "hide all this channel's videos" rule for it. The JS scrub
        // (processRenderer -> channelBlocks with the parsed age) handles it.
        if (entry.blockOlderThanDays > 0) continue;
        const whitelistIds = Object.keys(entry.whitelist || {});
        const notClause = whitelistIds.length
          ? `:not(${whitelistIds
              .map((id) => `:has(a[href*="v=${cssStringEscape(id)}"], a[href*="/shorts/${cssStringEscape(id)}"])`)
              .join(",")})`
          : "";
        exceptRules.push(
          `:is(${RENDERER_SELECTOR},${LOCKUP_SELECTOR}):has(${channelLink}):has(a[href*="v="],a[href*="/shorts/"])${notClause}`
        );
      } else {
        inner.push(channelLink);
      }
    }
    for (const [id] of newestFirst(videos, INSTANT_HIDE_MAX_VIDEOS)) {
      const esc = cssStringEscape(id);
      inner.push(`a[href*="v=${esc}"]`, `a[href*="/shorts/${esc}"]`);
    }

    const rules = [];
    if (inner.length) {
      rules.push(`:is(${RENDERER_SELECTOR},${LOCKUP_SELECTOR}):has(${inner.join(",")}) { display: none !important; }`);
    }
    exceptRules.forEach((sel) => rules.push(`${sel} { display: none !important; }`));

    lastAppliedChannels = channels;
    lastAppliedVideos = videos;
    instantHideStyle.textContent = staticInstantHideCSS + "\n" + rules.join("\n");
  }

  // Shelf/shelf-like containers that wrap a horizontal row of the tiles
  // above with their own header ("Latest from [channel]", a Shorts shelf,
  // "Latest posts", etc.). Scrubbing every tile inside one of these can
  // leave an empty header behind with nothing under it — these get pruned
  // once they run dry, see scheduleShelfPrune() below.
  const SHELF_SELECTOR = [
    "ytd-shelf-renderer",
    "ytd-reel-shelf-renderer",
    "ytd-rich-shelf-renderer",
    "ytd-horizontal-card-list-renderer",
    "ytm-shelf-renderer",
    "ytm-reel-shelf-renderer",
    "grid-shelf-view-model"
  ].join(",");

  function findShelfAncestor(el) {
    return el.closest ? el.closest(SHELF_SELECTOR) : null;
  }

  // Delayed so a shelf that's still lazily loading more (unblocked) tiles
  // isn't yanked out from under YouTube mid-render — only removed if it's
  // still empty a moment later.
  const shelvesPendingPrune = new Set();
  function scheduleShelfPrune(shelf) {
    if (!shelf || shelvesPendingPrune.has(shelf)) return;
    shelvesPendingPrune.add(shelf);
    setTimeout(() => {
      shelvesPendingPrune.delete(shelf);
      if (shelf.isConnected && !shelf.querySelector(RENDERER_SELECTOR) && !shelf.querySelector(LOCKUP_SELECTOR)) {
        shelf.remove();
      }
    }, 1000);
  }

  // ---------- Shorts: removed unconditionally, not just from blocked channels ----------
  const SHORTS_SHELF_SELECTOR = ["ytd-reel-shelf-renderer", "ytm-reel-shelf-renderer"].join(",");
  const SHORTS_ITEM_SELECTOR = [
    "ytd-reel-item-renderer",
    "ytd-reel-video-renderer",
    "ytm-shorts-lockup-view-model",
    // Confirmed live: search results' Shorts shelf renders each tile as this
    // "-v2" tag specifically, not the plain ytm-shorts-lockup-view-model above
    // (that name is still used elsewhere) — easy to miss since it looks like
    // a typo of the tag right next to it.
    "ytm-shorts-lockup-view-model-v2",
    "ytm-reel-item-renderer"
  ].join(",");
  // "Rich shelf" and "grid shelf" are both reused for lots of non-Shorts
  // shelf types (uploads, mixes, "for you"…), so they're only removed when
  // they actually contain Shorts. grid-shelf-view-model is the new
  // "view model" component confirmed live wrapping search's Shorts shelf.
  const AMBIGUOUS_SHELF_SELECTOR = "ytd-rich-shelf-renderer, ytm-rich-shelf-renderer, grid-shelf-view-model";

  function scrubShorts(root) {
    if (!settings.removeShorts) return;
    if (!root.querySelectorAll) return;
    // Checked first, before the more specific removals below, so it can
    // still see nested Shorts content as evidence before that evidence is
    // itself removed.
    root.querySelectorAll(AMBIGUOUS_SHELF_SELECTOR).forEach((shelf) => {
      if (
        shelf.isConnected &&
        shelf.querySelector(
          'ytd-reel-item-renderer, ytm-shorts-lockup-view-model, ytm-shorts-lockup-view-model-v2, a[href*="/shorts/"]'
        )
      ) {
        shelf.remove();
      }
    });
    root.querySelectorAll(SHORTS_SHELF_SELECTOR).forEach((el) => {
      if (el.isConnected) el.remove();
    });
    root.querySelectorAll(SHORTS_ITEM_SELECTOR).forEach((el) => {
      if (!el.isConnected) return;
      const shelf = findShelfAncestor(el);
      el.remove();
      if (shelf) scheduleShelfPrune(shelf);
    });
    // Shorts occasionally surface as a plain-looking video tile (e.g. mixed
    // into search results) instead of one of the tags above — catch those
    // by their link.
    root.querySelectorAll(RENDERER_SELECTOR).forEach((el) => {
      if (el.isConnected && el.querySelector('a[href*="/shorts/"]')) {
        const shelf = findShelfAncestor(el);
        el.remove();
        if (shelf) scheduleShelfPrune(shelf);
      }
    });
  }

  // ---------- guide sidebar: strip Home/Shorts/Explore/etc. and its footer ----------
  // "Explore"/"More from YouTube"/"Report history" don't have one single
  // stable link to key off, so those are matched by their visible label
  // (localised via LABELS_BY_LANG, English merged in). "Shorts" is also
  // matched here as a backup — confirmed live that the full guide drawer's
  // Shorts entry (unlike the always-visible mini guide) has no href on its
  // anchor at all. Compared case-insensitively.
  const HIDDEN_NAV_LABELS = new Set(
    [].concat(L.shorts, L.explore, L.moreFromYouTube, L.reportHistory, L.report).map((s) => s.toLowerCase())
  );
  const GUIDE_FOOTER_SIGNAL_RE = /Test new features|How YouTube works|Policy\s*&\s*Safety/i;
  const GUIDE_CONTAINER_SELECTOR = [
    "ytd-mini-guide-renderer",
    "ytd-guide-renderer",
    "tp-yt-app-drawer#guide",
    "ytm-pivot-bar-renderer"
  ].join(",");
  const NAV_ITEM_WRAPPER_SELECTOR = [
    "ytd-guide-entry-renderer",
    "ytd-mini-guide-entry-renderer",
    "ytm-pivot-bar-item-renderer",
    "ytm-guide-entry-renderer",
    "tp-yt-paper-item",
    "li"
  ].join(",");

  function navLabelOf(el) {
    // YouTube puts the accessible label on the entry's inner <a> (as
    // title/aria-label), not the outer custom element — checked first.
    // Falling back to a generic span/yt-formatted-string search here used to
    // grab an icon's empty wrapper <span> (which always comes first in an
    // entry's markup) instead of the actual label, so entries never matched;
    // that generic fallback now only runs for section headers, which have
    // no inner <a> and a real #guide-section-title.
    // ":scope > a" (direct child only) matters here: a *section* has no
    // anchor of its own, but a plain "a" search would still find the first
    // nested entry's anchor several levels down and wrongly use that.
    const a = el.querySelector(":scope > a");
    const fromAnchor = a && (a.getAttribute("title") || a.getAttribute("aria-label"));
    return (fromAnchor || el.getAttribute("title") || el.getAttribute("aria-label") || el.querySelector("#guide-section-title")?.textContent || "").trim();
  }

  function scrubGuide(root) {
    if (!settings.cleanSidebar) return;
    if (!root.querySelectorAll) return;
    root.querySelectorAll(GUIDE_CONTAINER_SELECTOR).forEach((guide) => {
      // Home and Shorts: matched by their link, not their tag/label — far
      // less likely to break if YouTube renames the wrapper element again
      // or the UI is in another language. YouTube's actual Shorts link is
      // "/shorts/" (trailing slash) — confirmed against the live site.
      guide.querySelectorAll('a[href="/"], a[href="/shorts/"]').forEach((a) => {
        const item = a.closest(NAV_ITEM_WRAPPER_SELECTOR) || a;
        item.remove();
      });
    });
    root
      .querySelectorAll(
        "ytd-guide-entry-renderer, ytd-mini-guide-entry-renderer, ytd-guide-section-renderer, ytm-pivot-bar-item-renderer, ytm-guide-entry-renderer"
      )
      .forEach((el) => {
        if (HIDDEN_NAV_LABELS.has(navLabelOf(el).toLowerCase())) el.remove();
      });
    // The little-print link list + copyright line at the bottom of the guide.
    // Scoped to ytd-guide-renderer and gated on its distinctive text so this
    // never touches an unrelated #footer elsewhere on the page.
    root.querySelectorAll("#footer").forEach((el) => {
      if (el.isConnected && el.closest("ytd-guide-renderer") && GUIDE_FOOTER_SIGNAL_RE.test(el.textContent || "")) {
        el.remove();
      }
    });
  }

  // ---------- masthead: strip Create and Notifications ----------
  // "Create" is localised (LABELS_BY_LANG, English merged); the notification
  // button is also removed by tag name above, so its text match staying
  // English-only is only a fallback.
  const MASTHEAD_CREATE_LABELS = new Set(L.create.map((s) => s.toLowerCase()));
  const MASTHEAD_HIDE_NOTIF_RE = /notification/i;
  function scrubMasthead(root) {
    if (!settings.cleanMasthead) return;
    const masthead = root.querySelector ? root.querySelector("ytd-masthead, ytm-app-bar-renderer") : null;
    if (!masthead) return;
    masthead.querySelectorAll("ytd-notification-topbar-button-renderer").forEach((el) => el.remove());
    masthead
      .querySelectorAll("button, a, yt-icon-button, ytd-button-renderer, tp-yt-paper-icon-button, ytd-topbar-menu-button-renderer")
      .forEach((el) => {
        const label = (el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
        if (MASTHEAD_CREATE_LABELS.has(label.toLowerCase()) || MASTHEAD_HIDE_NOTIF_RE.test(label)) {
          const wrapper =
            el.closest(
              "ytd-button-renderer, ytd-notification-topbar-button-renderer, ytd-topbar-menu-button-renderer, yt-icon-button, tp-yt-paper-icon-button"
            ) || el;
          wrapper.remove();
        }
      });
  }

  // ---------- point the masthead YouTube logo at Subscriptions ----------
  // The logo normally routes to the home feed, which we redirect anyway — but
  // that's a bounce (and a flash). Rewrite the anchor's href so a middle-click
  // / open-in-new-tab lands right, and let the yt-navigate-start handler below
  // catch the SPA click. Scoped to the masthead so it never touches the guide's
  // own Home link (already removed by scrubGuide).
  function retargetLogo(root) {
    if (!settings.logoToSubscriptions) return;
    const bar = root.querySelector
      ? root.querySelector("ytd-masthead, #masthead, ytm-masthead, .mobile-topbar-header, ytm-app-bar-renderer")
      : null;
    if (!bar) return;
    bar.querySelectorAll('a#logo, ytd-topbar-logo-renderer a, ytd-logo a, a[href="/"]').forEach((a) => {
      if (a.getAttribute("href") !== SAFE_LANDING_URL) a.setAttribute("href", SAFE_LANDING_URL);
    });
  }

  // ---------- the "up next" / related list beside the video ----------
  // Removes the whole column, not just the list inside it, so content.css's
  // layout rule can safely give the freed width back to the player column.
  function scrubSideRecommendations(root) {
    if (!settings.removeRelated) return;
    if (!root.querySelectorAll) return;
    root
      .querySelectorAll("ytd-watch-next-secondary-results-renderer, ytm-watch-next-secondary-results-renderer")
      .forEach((el) => el.remove());
    const secondary = root.querySelector ? root.querySelector("#secondary") : null;
    if (secondary) secondary.remove();
  }

  // ---------- end-screen "up next" grid + in-player suggestion cards ----------
  // Rendered directly by the player as plain divs (not custom elements), so
  // matched by class, not tag name. YouTube's current player ("ytp-delhi" /
  // fullscreen-grid revision) shows the end-of-video suggestions as
  // `.ytp-fullscreen-grid` full of `.ytp-modern-videowall-still` tiles — the
  // old `.html5-endscreen` / `.ytp-videowall-still` names are gone (confirmed
  // live, Sept 2026). The CSS instant-hide block above `display:none`s both
  // the modern and legacy names (safe/reversible on player-owned nodes); this
  // pass also deletes the pieces that are just content — the legacy overlay,
  // in-player cards, the teaser, and the individual `<a>` still-tiles — but
  // deliberately leaves the `.ytp-fullscreen-grid` container itself to CSS,
  // since the player manages it.
  function scrubEndScreen(root) {
    if (!settings.removeEndScreen) return;
    if (!root.querySelectorAll) return;
    root
      .querySelectorAll(
        ".html5-endscreen, .ytp-endscreen-content, .ytp-ce-element, .ytp-cards-teaser, " +
          ".ytp-videowall-still, .ytp-modern-videowall-still"
      )
      .forEach((el) => el.remove());
  }

  // ---------- watch-page action row: Share / Save / Download / Clip / "..." ----------
  // Matched by aria-label (localised via LABELS_BY_LANG, English always merged
  // in) inside ytd-watch-metadata's #actions container. Removing "More actions"
  // also takes Report out of reach (it only lives in that popup). Like/Dislike
  // are left alone — their labels aren't in the list, and we never remove the
  // row's shared ytd-menu-renderer wrapper.
  const VIDEO_ACTION_LABELS = new Set(
    [].concat(L.share, L.save, L.clip, L.thanks, L.download, L.more, L.report).map((s) => s.toLowerCase())
  );
  function scrubVideoActions(root) {
    if (!settings.hideVideoActions) return;
    if (!root.querySelectorAll) return;
    root.querySelectorAll("ytd-watch-metadata #actions").forEach((actions) => {
      actions.querySelectorAll("[aria-label]").forEach((el) => {
        const label = (el.getAttribute("aria-label") || "").trim().toLowerCase();
        if (!VIDEO_ACTION_LABELS.has(label) || label.includes("like")) return;
        const wrap =
          el.closest(
            "yt-button-view-model, ytd-button-renderer, ytd-download-button-renderer, ytd-toggle-button-renderer"
          ) ||
          el.closest("yt-icon-button") ||
          el;
        if (wrap && wrap.isConnected && !wrap.matches("ytd-menu-renderer")) wrap.remove();
      });
    });
  }

  // Runs the "always on" scrubs above (plus the playlist re-check further
  // down) at most a few times a second instead of on every single mutation —
  // YouTube's initial page hydration fires a very large burst of DOM writes,
  // and re-running several full-document querySelectorAll passes on every
  // one of them was making that first load noticeably slower.
  let extrasScheduled = false;
  function scheduleExtrasScrub() {
    if (extrasScheduled) return;
    extrasScheduled = true;
    setTimeout(() => {
      extrasScheduled = false;
      scrubShorts(document.documentElement);
      scrubGuide(document.documentElement);
      scrubMasthead(document.documentElement);
      retargetLogo(document.documentElement);
      scrubSideRecommendations(document.documentElement);
      scrubEndScreen(document.documentElement);
      scrubVideoActions(document.documentElement);
      scrubMembersOnly(document.documentElement);
      scrubOwnChannelPage(document.documentElement);
      recheckHydratingTiles(document.documentElement);
    }, 400);
  }
  // Heartbeat: guarantees these eventually run even on the rare page that
  // doesn't trigger a childList mutation our observer catches.
  setInterval(scheduleExtrasScrub, 2000);

  const CHANNEL_HREF_RE = /^\/(channel\/UC[\w-]{22}|@[\w.-]+)/;
  const VIDEO_ID_FROM_QUERY_RE = /[?&]v=([\w-]{11})/;
  const VIDEO_ID_FROM_SHORTS_RE = /\/shorts\/([\w-]{11})/;

  let blockedVideoIds = new Set();
  // key -> channel entry ({ name, ts, mode, whitelist, localOnly, handle }),
  // not just a Set of keys, since a FULL vs. EXCEPT_WHITELIST channel behaves
  // differently per-video (see channelBlocks() below).
  let blockedChannels = new Map();
  // lowercased "@handle" -> entry. An imported list is keyed by UC… ids but
  // modern YouTube tiles link the channel via /@handle, so we also index by
  // each entry's scraped `handle` (and by its own key when that's a @handle).
  let blockedByHandle = new Map();
  // "UC…" -> entry. The reverse: an @handle-keyed entry still needs to match
  // surfaces / navigation that use /channel/UC… (its `ucid` is scraped by the
  // enrich sweep).
  let blockedByUcid = new Map();
  let blocklistLoaded = false;

  // Resolve a channel key seen in the DOM ("UC…" or "@handle") to a blocked
  // entry, matching the storage key, a scraped @handle, or a scraped UC id.
  function blockedEntryFor(key) {
    if (!key) return undefined;
    if (isAllowlisted(key)) return undefined; // allow-list wins over any block
    if (blockedChannels.has(key)) return blockedChannels.get(key);
    if (key.charAt(0) === "@") return blockedByHandle.get(key.toLowerCase());
    if (key.startsWith("UC")) return blockedByUcid.get(key);
    return undefined;
  }
  // True when at least one blocked channel carries `blockOlderThanDays` — gates
  // the per-tile publish-date parsing in extractInfo() so the common case pays
  // nothing for it.
  let anyAgeRule = false;

  // Parses YouTube's relative "published" text ("3 days ago", "2 weeks ago",
  // "Streamed 5 months ago", "1 year ago") into an approximate age in days.
  // Language-independent: each entry matches "<number> <unit>" (in that order,
  // which holds for every locale YouTube ships — "vor 3 Wochen", "hace 3
  // semanas", "il y a 3 semaines", "3週間前", "3주 전", …) for one unit,
  // across ~15 languages' spellings. Ordered largest-unit-first so "month"
  // never loses to a partial "min" match. Returns null if nothing matches.
  // [unit spellings across ~15 languages, days-per-unit]. Anchored by the
  // preceding "<number><optional space>", which is enough on its own to stop
  // a short token (Turkish "ay" = month) matching inside a longer word
  // ("day"): after the digits the cursor sits on the first unit letter, so
  // "1 day" can only match the "day…" alternative, never "ay". Ordered
  // largest-unit-first. No \b — word boundaries don't work after the
  // diacritics / Cyrillic / CJK many of these end in.
  const AGE_UNITS = [
    [["years?", "yrs?", "années?", "ans?", "años?", "anos?", "jahren?", "anni", "anno", "jaar", "jaren", "tahun", "năm", "yıl", "годо?в?", "года?", "лет", "년", "年"], 365],
    [["months?", "mos?", "mois", "mes(?:es)?", "monaten?", "mesi", "mese", "maand(?:en)?", "bulan", "tháng", "ay", "месяц(?:ев|а)?", "개월", "ヶ月", "か月", "カ月", "ヵ月"], 30],
    [["weeks?", "wks?", "semaines?", "semanas?", "wochen?", "settiman[ae]", "weken?", "minggu", "tuần", "hafta", "недел(?:ь|и|ю)?", "주", "週間", "週"], 7],
    [["days?", "jours?", "d[ií]as?", "tag(?:en?)?", "giorni?", "dagen?", "hari", "ngày", "gün", "дн(?:ей|я)?", "день", "일", "日"], 1],
    [["hours?", "hrs?", "heures?", "horas?", "stunden?", "ore", "ora", "uur", "uren", "jam", "giờ", "saat", "час(?:ов|а)?", "시간", "時間"], 1 / 24],
    [["minutes?", "mins?", "minutos?", "minuten?", "minuti", "minuto", "menit", "phút", "dakika", "минут(?:ы|у)?", "분", "分"], 1 / 1440],
    [["seconds?", "secs?", "secondes?", "segundos?", "sekunden?", "secondi", "secondo", "seconden?", "detik", "giây", "saniye", "секунд(?:ы|у)?", "초", "秒"], 1 / 86400]
  ].map(([alts, days]) => [new RegExp(`(\\d+)\\s*(?:${alts.join("|")})`, "i"), days]);
  function parseAgeDays(text) {
    const t = text || "";
    for (const [re, days] of AGE_UNITS) {
      const m = t.match(re);
      if (m) return parseInt(m[1], 10) * days;
    }
    return null;
  }

  // Whether a given blocked channel entry blocks a specific video. Pass
  // `null` for videoId for "the channel page itself / a non-video tile".
  // `ageDays` is the video's approximate age (parseAgeDays), or null/undefined
  // if unknown.
  //  - FULL: blocks everything unconditionally.
  //  - EXCEPT_WHITELIST: the channel's own page and non-video tiles stay;
  //    whitelisted video IDs stay; then either every other video is blocked
  //    (no age rule) or only videos older than `blockOlderThanDays` are
  //    (recent uploads pass; unknown age is treated as "recent" so a
  //    parse failure never over-blocks a channel the user wants to keep
  //    partly visible).
  function channelBlocks(entry, videoId, ageDays) {
    if (!entry) return false;
    if (entry.mode === CHANNEL_MODE.EXCEPT_WHITELIST) {
      if (!videoId) return false;
      if (entry.whitelist && entry.whitelist[videoId]) return false;
      if (entry.blockOlderThanDays > 0) {
        return ageDays != null && ageDays >= entry.blockOlderThanDays;
      }
      return true;
    }
    return true;
  }

  function normalizeChannelKey(href) {
    const m = href.match(CHANNEL_HREF_RE);
    if (!m) return null;
    const path = m[1];
    return path.startsWith("channel/") ? path.slice("channel/".length) : path; // "UC..." or "@handle"
  }

  // A tile can list more than one channel — YouTube's "channel collaborations"
  // feature shows co-authors alongside the primary uploader. Collect every
  // distinct channel link found in scope so blocking a collaborator works
  // exactly like blocking the primary channel.
  function collectChannels(root) {
    const found = new Map(); // key -> display name
    for (const a of root.querySelectorAll("a[href]")) {
      const key = normalizeChannelKey(a.getAttribute("href") || "");
      if (key && !found.has(key)) {
        found.set(key, (a.textContent || "").trim());
      }
    }
    return found;
  }

  function extractInfo(el) {
    let videoId = null;
    let videoTitle = "";

    for (const a of el.querySelectorAll("a[href]")) {
      const href = a.getAttribute("href") || "";
      if (videoId) break;
      const qm = href.match(VIDEO_ID_FROM_QUERY_RE);
      const sm = href.match(VIDEO_ID_FROM_SHORTS_RE);
      if (qm) videoId = qm[1];
      else if (sm) videoId = sm[1];
      if (videoId) {
        videoTitle = (a.getAttribute("title") || a.textContent || "").trim();
      }
    }

    // The videoId link is usually the title-less thumbnail anchor whose text
    // is just a duration + "Now playing" — for keyword matching we need the
    // real title from the dedicated element. If that hasn't hydrated yet,
    // clear the junk so `videoTitle` stays falsy and processRenderer knows to
    // re-check the tile later.
    if (videoId) {
      const t = el.querySelector(
        "#video-title, #video-title-link, h3 a[href*='watch'], a.yt-lockup-metadata-view-model-wiz__title, .yt-lockup-metadata-view-model-wiz__title"
      );
      const real = t && (t.getAttribute("title") || t.textContent || "").trim();
      if (real) videoTitle = real;
      else if (/^[\d:]+(\s|$)|now playing/i.test(videoTitle) || videoTitle.length < 4) videoTitle = "";
    }

    const channels = collectChannels(el);
    if (!videoId && channels.size === 0) return null;
    // Only bother reading the tile's publish text / duration when a blocked
    // channel has an age rule / a duration filter is active — parsing every
    // tile otherwise is wasted work.
    const ageDays = anyAgeRule && videoId ? parseAgeDays(el.textContent || "") : null;
    const durationSec =
      videoId && (durMinSec > 0 || durMaxSec > 0) ? readDurationSec(el) : null;
    return { videoId, videoTitle, channels, ageDays, durationSec };
  }

  // Why a tile is blocked, as a short string — null if it isn't. isBlocked()
  // is just "reason != null"; keeping them one function means the debug log
  // and the real decision can never disagree.
  function blockReason(info) {
    if (!info) return null;
    // Allow-list: a hard override. If any channel on this tile is allow-listed,
    // nothing hides it — not a keyword/duration filter, not a collaborator
    // block, not an age rule.
    if (allowSet.size) {
      for (const key of info.channels.keys()) if (isAllowlisted(key)) return null;
    }
    if (info.videoId && blockedVideoIds.has(info.videoId)) return "blocked video id";
    if (info.videoId && info.videoTitle && keywordMatchers.some((r) => r.test(info.videoTitle))) {
      return `keyword match: "${info.videoTitle.slice(0, 60)}"`;
    }
    const d = info.durationSec;
    if (d != null && d > 0) {
      if (durMinSec > 0 && d < durMinSec) return `duration ${d}s < ${durMinSec}s`;
      if (durMaxSec > 0 && d > durMaxSec) return `duration ${d}s > ${durMaxSec}s`;
    }
    for (const key of info.channels.keys()) {
      const e = blockedEntryFor(key);
      if (channelBlocks(e, info.videoId, info.ageDays)) {
        const via = blockedChannels.has(key) ? "key" : key.charAt(0) === "@" ? "@handle index" : "ucid index";
        return `channel ${key} (${e.mode || "full"}${e.blockOlderThanDays ? `, >${e.blockOlderThanDays}d` : ""}, via ${via})`;
      }
    }
    return null;
  }
  function isBlocked(info) {
    return blockReason(info) !== null;
  }

  function injectBlockButton(el, info) {
    if (el.dataset.btBtn === "1") return;
    el.dataset.btBtn = "1";
    if (!info.videoId && info.channels.size === 0) return;

    const btn = document.createElement("div");
    btn.className = "bt-block-btn";
    btn.title = "Block on BlockTube";
    btn.textContent = "🚫";

    const menu = document.createElement("div");
    menu.className = "bt-block-menu";
    menu.hidden = true;

    if (info.videoId) {
      const videoOpt = document.createElement("button");
      videoOpt.textContent = "Block this video";
      videoOpt.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        chrome.runtime.sendMessage({ type: MSG.BLOCK_VIDEO, id: info.videoId, title: info.videoTitle });
        const shelf = findShelfAncestor(el);
        el.remove();
        if (shelf) scheduleShelfPrune(shelf);
      });
      menu.appendChild(videoOpt);
    }
    // Two entries per channel — a tile can list several via YouTube's
    // channel-collaboration feature, and either block type can be applied to
    // any one of them independently.
    for (const [key, name] of info.channels) {
      const fullOpt = document.createElement("button");
      fullOpt.textContent = `Block channel${name ? ": " + name : ""}`;
      fullOpt.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        chrome.runtime.sendMessage({ type: MSG.BLOCK_CHANNEL, id: key, name, mode: CHANNEL_MODE.FULL });
        const shelf = findShelfAncestor(el);
        el.remove();
        if (shelf) scheduleShelfPrune(shelf);
      });
      menu.appendChild(fullOpt);

      // The softer mode: the channel itself stays reachable, only its videos
      // get blocked (with a whitelist manageable later from the options
      // page) — see CHANNEL_MODE.EXCEPT_WHITELIST in shared/constants.js.
      const softOpt = document.createElement("button");
      softOpt.textContent = `Block all videos from${name ? " " + name : " this channel"} (allow some later)`;
      softOpt.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        chrome.runtime.sendMessage({
          type: MSG.BLOCK_CHANNEL,
          id: key,
          name,
          mode: CHANNEL_MODE.EXCEPT_WHITELIST
        });
        const shelf = findShelfAncestor(el);
        el.remove();
        if (shelf) scheduleShelfPrune(shelf);
      });
      menu.appendChild(softOpt);
    }

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      e.preventDefault();
      document.querySelectorAll(".bt-block-menu").forEach((m) => {
        if (m !== menu) m.hidden = true;
      });
      menu.hidden = !menu.hidden;
    });

    document.addEventListener("click", () => {
      menu.hidden = true;
    });

    el.style.position = el.style.position || "relative";
    el.appendChild(btn);
    el.appendChild(menu);
  }

  // A tile counts as "members only" if it carries a badge whose text is
  // exactly the localised "Members only" phrase — covers the new `badge-shape`
  // view-model badge and the legacy `.badge-style-type-members-only`. Text
  // match because the new badge's class (`ytBadgeShapeCommerce`) is shared
  // with other paid badges.
  const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Compare on a squashed form (spaces/hyphens removed) so "Members only",
  // "members-only" and "membersonly" all match the same entry.
  const squash = (s) => s.toLowerCase().replace(/[\s\-]+/g, "");
  const MEMBERS_ONLY_SET = new Set([...L.membersOnly, "members only", "member only"].map(squash));
  const membersOnlyText = (s) => MEMBERS_ONLY_SET.has(squash(s));
  // Looser: matches a "Members only" / "Membership" shelf title anywhere in it.
  const MEMBERSHIP_ANY_RE = new RegExp(
    [...new Set([...L.membersOnly, ...L.membership])].map(reEscape).join("|"),
    "i"
  );
  function isMembersOnlyTile(el) {
    if (el.querySelector(".badge-style-type-members-only")) return true;
    return Array.from(
      el.querySelectorAll("badge-shape, ytd-badge-supported-renderer .badge, .badge, [class*='badge' i]")
    ).some((b) => membersOnlyText((b.textContent || "").trim()));
  }

  function processRenderer(el) {
    if (el.dataset.btChecked === "1") return;
    if (settings.hideMemberships && isMembersOnlyTile(el)) {
      const shelf = findShelfAncestor(el);
      dbg("removed", el.tagName.toLowerCase(), "— members-only");
      el.remove();
      if (shelf) scheduleShelfPrune(shelf);
      return;
    }
    const info = extractInfo(el);
    const reason = blockReason(info);
    if (reason) {
      const shelf = findShelfAncestor(el);
      dbg("removed", el.tagName.toLowerCase(), "—", reason);
      el.remove();
      if (shelf) scheduleShelfPrune(shelf);
      return;
    }
    if (blocklistLoaded) {
      // Don't lock in "checked" while a keyword filter is active and this
      // video tile's title hasn't hydrated yet — recheckHydratingTiles() will
      // come back for it once the title element mounts.
      const titlePending = keywordMatchers.length && info && info.videoId && !info.videoTitle;
      if (!titlePending) el.dataset.btChecked = "1";
      if (info) injectBlockButton(el, info);
    }
  }

  // Throttled backup for members-only content: catches tiles whose badge
  // hydrated after processRenderer already marked them checked, plus the
  // "Membership" / "Members-only content" shelf and the channel Membership
  // tab (neither is a tile). Gated on hideMemberships.
  function scrubMembersOnly(root) {
    if (!settings.hideMemberships) return;
    if (!root.querySelectorAll) return;
    queryTiles(root).forEach((el) => {
      if (el.isConnected && isMembersOnlyTile(el)) {
        const shelf = findShelfAncestor(el);
        el.remove();
        if (shelf) scheduleShelfPrune(shelf);
      }
    });
    root.querySelectorAll(SHELF_SELECTOR).forEach((sh) => {
      if (!sh.isConnected) return;
      const title = (sh.querySelector("#title, .title, h2, yt-formatted-string#title, span.title") || {}).textContent || "";
      if (MEMBERSHIP_ANY_RE.test(title.trim())) sh.remove();
    });
    const membershipTabSet = new Set([...L.membership, ...L.membersOnly, "members", "membership"].map((s) => s.toLowerCase()));
    root.querySelectorAll("yt-tab-shape, tp-yt-paper-tab, [role='tab']").forEach((t) => {
      if (t.isConnected && membershipTabSet.has((t.textContent || "").trim().toLowerCase())) t.remove();
    });
  }

  // ---------- a blocked channel's OWN page (Videos / Streams / Home tabs) ----------
  // On a channel's own page the video tiles carry no channel byline (you're
  // already there), so the per-tile scrub never links them to the blocklist.
  // If the page belongs to a channel we block *videos* for — EXCEPT_WHITELIST,
  // or FULL if its redirect hasn't fired yet — treat every video tile on the
  // page as that channel's and apply channelBlocks() (whitelist + age rule
  // still honoured). A pre-paint CSS layer (channelPageHideStyle) hides the
  // grid for the no-age-rule case; the JS pass does the rest and handles the
  // age rule (which CSS can't).
  const channelPageHideStyle = document.createElement("style");
  channelPageHideStyle.id = "bt-channel-page-hide";
  (document.documentElement || document).appendChild(channelPageHideStyle);
  const CHANNEL_PAGE_TILE_SEL = [
    "ytd-rich-item-renderer",
    "ytd-grid-video-renderer",
    "ytd-video-renderer",
    "ytm-rich-item-renderer",
    "yt-lockup-view-model"
  ].join(",");

  function updateChannelPageHideCSS(entry) {
    // CSS can't do date math, so an age-ruled channel is JS-only.
    if (!entry || entry.blockOlderThanDays > 0) {
      if (channelPageHideStyle.textContent) channelPageHideStyle.textContent = "";
      return;
    }
    const wl = Object.keys(entry.whitelist || {});
    const notWl = wl.length
      ? `:not(:has(${wl.map((id) => `a[href*="v=${cssStringEscape(id)}"]`).join(",")}))`
      : "";
    // Scoped to the channel-page browse container so it can never touch the
    // home feed (also a ytd-browse). If YouTube drops that attribute the CSS
    // just no-ops and the JS pass below still clears the grid (with a flash).
    channelPageHideStyle.textContent =
      `ytd-browse[page-subtype="channels"] :is(${CHANNEL_PAGE_TILE_SEL}):has(a[href*="watch?v="], a[href*="/shorts/"])${notWl} { display: none !important; }`;
  }

  function scrubOwnChannelPage(root) {
    if (!blocklistLoaded || !root.querySelectorAll) return;
    const pathKey = normalizeChannelKey(location.pathname);
    const entry = pathKey ? blockedEntryFor(pathKey) : null;
    updateChannelPageHideCSS(entry);
    if (!entry) return; // any blocked channel blocks its videos in some form
    queryTiles(root).forEach((el) => {
      if (!el.isConnected) return;
      const info = extractInfo(el);
      if (!info || !info.videoId) return;
      if (channelBlocks(entry, info.videoId, info.ageDays)) {
        const shelf = findShelfAncestor(el);
        el.remove();
        if (shelf) scheduleShelfPrune(shelf);
      }
    });
  }

  function sweep(root) {
    if (root.matches) {
      if (root.matches(RENDERER_SELECTOR)) processRenderer(root);
      else if (root.matches(LOCKUP_SELECTOR) && (!root.closest || !root.closest(RENDERER_SELECTOR))) {
        processRenderer(root);
      }
    }
    queryTiles(root).forEach(processRenderer);
  }

  // Playlist tiles in particular can mount their channel byline a moment
  // *after* the tile itself, so the very first check can run before there's
  // anything to see yet and the tile gets wrongly marked "safe" forever.
  // Walking every mutated node with .closest() to catch that turned out too
  // costly to do on every single DOM write, so instead this narrow set of
  // tags gets a cheap periodic re-check instead (see scheduleExtrasScrub()).
  const REHYDRATE_RECHECK_SELECTOR = [
    "ytd-playlist-renderer",
    "ytd-grid-playlist-renderer",
    "ytd-compact-playlist-renderer",
    "ytm-compact-playlist-renderer",
    LOCKUP_SELECTOR
  ].join(",");
  function recheckHydratingTiles(root) {
    if (!root.querySelectorAll) return;
    root.querySelectorAll(REHYDRATE_RECHECK_SELECTOR).forEach((el) => {
      if (el.matches(LOCKUP_SELECTOR) && el.closest(RENDERER_SELECTOR)) return; // already covered by its wrapper
      if (el.dataset.btChecked === "1") delete el.dataset.btChecked;
      processRenderer(el);
    });
    // Video tiles left un-checked by processRenderer because a keyword filter
    // is on and their title hadn't hydrated — re-process just those.
    if (anyFilter()) {
      root
        .querySelectorAll("ytd-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer")
        .forEach((el) => {
          if (el.dataset.btChecked !== "1") processRenderer(el);
        });
    }
  }

  // ---------- batch DOM mutations to one pass per frame ----------
  const pending = new Set();
  let scheduled = false;
  function scheduleFlush() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      const nodes = Array.from(pending);
      pending.clear();
      nodes.forEach(sweep);
    });
  }

  // Also watches the `is-active` attribute: YouTube's vertical Shorts feed
  // keeps several ytd-reel-video-renderer elements mounted at once and just
  // flips which one carries is-active as you scroll, so a plain childList
  // observer never sees the new short arrive.
  const observer = new MutationObserver((mutations) => {
    let activeShortChanged = false;
    for (const m of mutations) {
      if (m.type === "attributes") {
        if (m.attributeName === "is-active" && m.target.hasAttribute("is-active")) {
          activeShortChanged = true;
        }
        continue;
      }
      for (const node of m.addedNodes) {
        if (node.nodeType === 1) pending.add(node);
      }
    }
    if (pending.size) {
      scheduleFlush();
      scheduleExtrasScrub();
    }
    if (activeShortChanged) checkCurrentPageAndRedirect();
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["is-active"]
  });

  // Run the always-on scrubs once at startup. Deferred to runExtras() so it
  // waits for the feature toggles to load (settingsLoaded) — otherwise a
  // Shorts/related/etc. removal a user has *turned off* would still fire once
  // before their settings arrive, and remove() can't be undone.
  function runExtras() {
    scrubShorts(document.documentElement);
    scrubGuide(document.documentElement);
    scrubMasthead(document.documentElement);
    retargetLogo(document.documentElement);
    scrubSideRecommendations(document.documentElement);
    scrubEndScreen(document.documentElement);
    scrubVideoActions(document.documentElement);
    scrubMembersOnly(document.documentElement);
    scrubOwnChannelPage(document.documentElement);
  }

  // ---------- feature toggles (chrome.storage.sync: bt_settings) ----------
  let settingsLoaded = false;
  function applySettings(next) {
    settings = { ...DEFAULT_SETTINGS, ...(next || {}) };
    staticInstantHideCSS = buildStaticCSS();
    // rebuild the whole stylesheet (static + blocklist halves)
    updateInstantHideBlocklistCSS(lastAppliedChannels, lastAppliedVideos);
    if (settingsLoaded) runExtras(); // a live toggle change — re-apply now
  }
  // ---------- title-keyword filters (chrome.storage.sync: bt_keywords) ----------
  // A video whose title matches any pattern is scrubbed. JS-scrub only — CSS
  // can't match text — so there's a one-frame window vs. the :has() layer.
  let keywordMatchers = [];
  let durMinSec = 0; // block videos shorter than this (0 = off) — catches Shorts-in-disguise / clip spam
  let durMaxSec = 0; // block videos longer than this  (0 = off) — catches streams
  function applyKeywords(rec) {
    const list = (rec && Array.isArray(rec.list) ? rec.list : []).slice(0, 200);
    keywordMatchers = list
      .map(({ p, re }) => {
        const src = String(p || "").trim();
        if (!src) return null;
        try {
          return re
            ? new RegExp(src, "i")
            : new RegExp(src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    durMinSec = Math.max(0, Math.floor(Number(rec && rec.durMinSec) || 0));
    durMaxSec = Math.max(0, Math.floor(Number(rec && rec.durMaxSec) || 0));
  }
  function anyFilter() {
    return keywordMatchers.length > 0 || durMinSec > 0 || durMaxSec > 0;
  }
  // "M:SS" / "H:MM:SS" → seconds; null if not parseable.
  function parseDurationSec(text) {
    const m = (text || "").match(/\b(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\b/);
    if (!m) return null;
    return m[3] ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
  }
  // Pull a video's length off its tile. Scans the duration/time-status badges
  // specifically (a tile can carry other badges like "4K"/"New", and a title
  // can contain a stray "12:30"), taking the first that parses as a time.
  function readDurationSec(el) {
    const nodes = el.querySelectorAll(
      "ytd-thumbnail-overlay-time-status-renderer, #time-status, .badge-shape-wiz__text, badge-shape .badge-shape-wiz__text, .ytp-time-duration"
    );
    for (const n of nodes) {
      const s = parseDurationSec(n.textContent || "");
      if (s != null) return s;
    }
    return null;
  }
  function matchesFilter(info) {
    if (!info || !info.videoId) return false;
    if (info.videoTitle && keywordMatchers.some((r) => r.test(info.videoTitle))) return true;
    const d = info.durationSec;
    if (d != null && d > 0) {
      if (durMinSec > 0 && d < durMinSec) return true;
      if (durMaxSec > 0 && d > durMaxSec) return true;
    }
    return false;
  }

  chrome.storage.sync.get({ [SETTINGS_KEY]: DEFAULT_SETTINGS, [KEYWORDS_KEY]: null }, (res) => {
    applyKeywords(res[KEYWORDS_KEY]);
    applySettings(res[SETTINGS_KEY]);
    settingsLoaded = true;
    runExtras();
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    if (changes[SETTINGS_KEY]) applySettings(changes[SETTINGS_KEY].newValue);
    if (changes[KEYWORDS_KEY]) {
      applyKeywords(changes[KEYWORDS_KEY].newValue);
      // re-scan already-checked tiles against the new patterns
      queryTiles(document).forEach((el) => delete el.dataset.btChecked);
      sweep(document.documentElement);
    }
    if (changes[ALLOWLIST_KEY]) {
      const v = changes[ALLOWLIST_KEY].newValue;
      allowSet = new Set(Object.keys((v && v.list) || {}).map((k) => (k[0] === "@" ? k.toLowerCase() : k)));
      updateInstantHideBlocklistCSS(lastAppliedChannels, lastAppliedVideos);
      queryTiles(document).forEach((el) => delete el.dataset.btChecked);
      sweep(document.documentElement);
    }
  });

  // ---------- load blocklist from background, stay live-updated ----------
  // Channels the user has put on the allow-list: a hard "never hide anything
  // from this channel", overriding every block path (direct, collaborator,
  // title keyword, duration, age rule). @handle keys are lowercased.
  let allowSet = new Set();
  function isAllowlisted(key) {
    if (!key || !allowSet.size) return false;
    return allowSet.has(key) || allowSet.has(String(key).toLowerCase());
  }
  function applyBlocklist(channels, videos, allowlist) {
    if (allowlist && typeof allowlist === "object") {
      allowSet = new Set(Object.keys(allowlist).map((k) => (k[0] === "@" ? k.toLowerCase() : k)));
    }
    blockedChannels = new Map(Object.entries(channels || {}));
    blockedByHandle = new Map();
    blockedByUcid = new Map();
    for (const [key, entry] of blockedChannels) {
      if (key.charAt(0) === "@") blockedByHandle.set(key.toLowerCase(), entry);
      else if (key.startsWith("UC")) blockedByUcid.set(key, entry);
      if (entry && entry.handle) blockedByHandle.set(String(entry.handle).toLowerCase(), entry);
      if (entry && entry.ucid) blockedByUcid.set(String(entry.ucid), entry);
    }
    blockedVideoIds = new Set(Object.keys(videos || {}));
    anyAgeRule = Array.from(blockedChannels.values()).some((e) => e && e.blockOlderThanDays > 0);
    updateInstantHideBlocklistCSS(channels, videos);
    dbg(
      "blocklist applied —",
      blockedChannels.size,
      "channels,",
      blockedByHandle.size,
      "handle-indexed,",
      blockedByUcid.size,
      "ucid-indexed,",
      blockedVideoIds.size,
      "videos,",
      keywordMatchers.length,
      "keywords"
    );
  }

  chrome.runtime.sendMessage({ type: MSG.GET_BLOCKLIST }, (res) => {
    if (!res) return;
    applyBlocklist(res.channels, res.videos, res.allowlist);
    blocklistLoaded = true;
    // catch anything YouTube already inserted before the blocklist arrived
    sweep(document.documentElement);
    scrubOwnChannelPage(document.documentElement);
    // and catch a fresh/direct load landing straight on a blocked video/playlist
    checkCurrentPageAndRedirect();
  });

  // The container that represents "whose page is this" — scoped narrowly so we
  // never pick up unrelated channels (e.g. from sidebar recommendations, or
  // from other people's videos inside a playlist we're just viewing).
  function findScopeForCurrentPage() {
    return (
      // The currently-visible Shorts player (checked first: several
      // ytd-reel-video-renderer elements can be mounted at once for the
      // vertical feed's neighbors, only one carries is-active).
      document.querySelector("ytd-reel-video-renderer[is-active]") ||
      document.querySelector("ytd-watch-metadata") ||
      document.querySelector("#above-the-fold") ||
      document.querySelector("ytd-playlist-header-renderer") ||
      document.querySelector("ytd-playlist-sidebar-primary-info-renderer") ||
      document.querySelector("#owner") ||
      null
    );
  }

  // Info about whatever video/channel(s) the user is currently looking at —
  // used both by the popup's quick-block buttons and by the direct-navigation
  // safety-net redirect below. A video can have multiple channels attached via
  // YouTube's channel-collaboration feature, so this always returns an array.
  function getCurrentPageTarget() {
    const pathKey = normalizeChannelKey(location.pathname);
    if (pathKey) {
      return {
        videoId: null,
        videoTitle: "",
        channels: [{ key: pathKey, name: document.title.replace(/ - YouTube$/, "").trim() }]
      };
    }

    let videoId = null;
    let videoTitle = "";
    const vm =
      (location.pathname + location.search).match(VIDEO_ID_FROM_QUERY_RE) ||
      location.pathname.match(VIDEO_ID_FROM_SHORTS_RE);
    if (vm) {
      videoId = vm[1];
      videoTitle = document.title.replace(/ - YouTube$/, "").trim();
    }

    const scope = findScopeForCurrentPage();
    const channels = scope ? Array.from(collectChannels(scope), ([key, name]) => ({ key, name })) : [];

    return { videoId, videoTitle, channels };
  }

  // Safety net for direct/fresh navigation straight to a video or playlist
  // page: declarativeNetRequest (background.js) only knows exact blocked
  // video IDs and exact blocked channel *page* URLs — it has no way to know
  // "this video's uploader/collaborator is blocked" or "this playlist belongs
  // to a blocked channel", since neither URL shape carries that information.
  // This runs after the page has actually rendered its own metadata.
  function checkCurrentPageAndRedirect() {
    // Home and Shorts as destinations — gone entirely when their toggle is on,
    // regardless of the blocklist; sent straight to Subscriptions.
    const path = location.pathname;
    if (settings.redirectHomepage && path === "/") {
      window.location.href = SAFE_LANDING_URL;
      return;
    }
    if (settings.removeShorts && (path === "/shorts" || path.startsWith("/shorts/"))) {
      window.location.href = SAFE_LANDING_URL;
      return;
    }

    if (!blocklistLoaded) return;
    const target = getCurrentPageTarget();
    if (target.channels.some((c) => isAllowlisted(c.key))) return; // allow-list wins
    const ageDays = anyAgeRule && target.videoId ? currentPageAgeDays() : null;
    const blocked =
      (target.videoId && blockedVideoIds.has(target.videoId)) ||
      matchesFilter(target) ||
      target.channels.some((c) => channelBlocks(blockedEntryFor(c.key), target.videoId, ageDays));
    if (blocked) {
      window.location.href = SAFE_LANDING_URL;
    }
  }

  // Best-effort age of the video on the current watch page, for the age-rule
  // nav guard. Tries YouTube's relative text first, then an English absolute
  // date ("Jan 5, 2024" / "Premiered Jan 5, 2024"). null if neither is found —
  // callers treat that as "recent" (fail open), same as feed tiles.
  function currentPageAgeDays() {
    const scope =
      document.querySelector("ytd-watch-metadata, #above-the-fold, #info-container, ytd-watch-info-text") || document.body;
    const text = scope ? scope.textContent || "" : "";
    const rel = parseAgeDays(text);
    if (rel != null) return rel;
    const abs = text.match(/([A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4})/);
    if (abs) {
      const t = Date.parse(abs[1]);
      if (!Number.isNaN(t)) return (Date.now() - t) / 86400000;
    }
    return null;
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === MSG.BLOCKLIST_UPDATED) {
      applyBlocklist(msg.channels, msg.videos, msg.allowlist);
      // a newly-blocked id might match tiles already marked "checked"; force a recheck
      queryTiles(document).forEach((el) => {
        delete el.dataset.btChecked;
      });
      sweep(document.documentElement);
      scrubOwnChannelPage(document.documentElement);
    } else if (msg.type === MSG.GET_PAGE_TARGET) {
      sendResponse(getCurrentPageTarget());
    }
    return true;
  });

  // ---------- bounce out of blocked videos/channels reached via in-app (SPA) nav ----------
  // declarativeNetRequest (background.js) handles fresh/typed/external navigation.
  // YouTube's own client-side routing doesn't trigger a new network request, so we
  // intercept its "yt-navigate-start" event and bail out before the blocked page renders.
  window.addEventListener("yt-navigate-start", (e) => {
    const endpoint = e.detail?.endpoint;
    const webUrl = endpoint?.commandMetadata?.webCommandMetadata?.url || "";

    // Shorts — bail before the player even mounts (toggle-gated).
    if (settings.removeShorts && (endpoint?.reelWatchEndpoint || webUrl.startsWith("/shorts"))) {
      window.location.href = SAFE_LANDING_URL;
      return;
    }

    // The masthead logo (and anything else) routing to the home feed — send
    // it straight to Subscriptions with no bounce. "FEwhat_to_watch" is the
    // home-feed browseId; webUrl is "/" for the logo.
    if (
      (settings.redirectHomepage || settings.logoToSubscriptions) &&
      (webUrl === "/" || endpoint?.browseEndpoint?.browseId === "FEwhat_to_watch")
    ) {
      window.location.href = SAFE_LANDING_URL;
      return;
    }

    const videoId = endpoint?.watchEndpoint?.videoId;
    const browseId = endpoint?.browseEndpoint?.browseId;
    const canonicalUrl = endpoint?.browseEndpoint?.canonicalBaseUrl;
    const handleKey = canonicalUrl && canonicalUrl.startsWith("/") ? canonicalUrl.slice(1) : null;

    // Navigating straight to a channel's own page (no video involved) — an
    // EXCEPT_WHITELIST channel deliberately allows this, so channelBlocks()
    // is passed `null` for "no video", not `videoId`.
    const blocked =
      (videoId && blockedVideoIds.has(videoId)) ||
      (browseId && channelBlocks(blockedEntryFor(browseId), null)) ||
      (handleKey && channelBlocks(blockedEntryFor(handleKey), null));

    if (blocked) {
      window.location.href = SAFE_LANDING_URL;
    }
  });

  // Belt-and-suspenders: once a soft-navigation actually finishes rendering,
  // re-check its metadata (catches collaborator channels and playlist owners
  // that only become visible in the DOM after render, which yt-navigate-start
  // above can't see ahead of time) and re-scrub Shorts/guide/related, since a
  // whole new page's worth of content just mounted.
  window.addEventListener("yt-navigate-finish", () => {
    scrubShorts(document.documentElement);
    scrubGuide(document.documentElement);
    scrubMasthead(document.documentElement);
    retargetLogo(document.documentElement);
    scrubSideRecommendations(document.documentElement);
    scrubEndScreen(document.documentElement);
    scrubVideoActions(document.documentElement);
    scrubMembersOnly(document.documentElement);
    scrubOwnChannelPage(document.documentElement);
    checkCurrentPageAndRedirect();
  });

  // ---------- debug surface (only when DEBUG) ----------
  if (DEBUG) {
    console.debug(
      "%c[BlockTube] debug mode on%c — every removal is logged below with its reason. " +
        "For __blockTube.state() / __blockTube.why('<selector>'), switch the console's " +
        "JavaScript context (top-left dropdown) to “BlockTube”.",
      "color:#c00;font-weight:bold",
      "color:inherit;font-weight:normal"
    );
    window.__blockTube = {
      state: () => ({
        channels: blockedChannels.size,
        byHandle: blockedByHandle.size,
        byUcid: blockedByUcid.size,
        videos: blockedVideoIds.size,
        keywords: keywordMatchers.length,
        durMinSec,
        durMaxSec,
        anyAgeRule,
        settings,
        blocklistLoaded
      }),
      // Explain a tile: pass an element or a CSS selector (first match).
      why: (elOrSel) => {
        const el = typeof elOrSel === "string" ? document.querySelector(elOrSel) : elOrSel;
        if (!el) return "no element";
        const info = extractInfo(el);
        if (!info) return "not a tile (no video id / channel link)";
        const channels = [...info.channels.keys()].map((k) => ({
          key: k,
          blockedEntry: !!blockedEntryFor(k),
          via: blockedChannels.has(k) ? "key" : blockedByHandle.has(k.toLowerCase()) ? "@handle" : blockedByUcid.has(k) ? "ucid" : "—"
        }));
        return {
          videoId: info.videoId,
          title: info.videoTitle,
          durationSec: info.durationSec,
          ageDays: info.ageDays,
          channels,
          verdict: blockReason(info) || "NOT blocked"
        };
      },
      // Toggle persistent debug (survives reload) without the URL param.
      enable: () => localStorage.setItem("bt_debug", "1"),
      disable: () => localStorage.removeItem("bt_debug")
    };
  }
})();
