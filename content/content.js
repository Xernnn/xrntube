(() => {
  const { MSG, CHANNEL_MODE, DEFAULT_SETTINGS, SETTINGS_KEY, KEYWORDS_KEY, ALLOWLIST_KEY, resolveSettings } = self.BlockTube;

  // ---------- embedded players (manifest all_frames) ----------
  // The manifest injects into frames so a youtube.com/embed/<id> player on
  // someone else's page can be guarded. That means this file now runs in every
  // YouTube iframe, so the frame path must stay cheap: bail out here, before
  // any of the observers, stylesheets and timers below are set up. Only a real
  // /embed/ player does any work, and only when the opt-in switch is on.
  //
  // An embed can only be neutered from the inside — the extension has no
  // content script on the host page, so it cannot remove the <iframe> element
  // itself. Blanking the frame is the honest most we can do.
  if (window.top !== window) {
    const em = location.pathname.match(/^\/embed\/([\w-]{11})/);
    if (!em) return;
    const embedVideoId = em[1];
    chrome.storage.sync.get({ [SETTINGS_KEY]: null }, (sres) => {
      if (chrome.runtime.lastError) return;
      if (!resolveSettings(sres[SETTINGS_KEY]).blockInEmbeds) return;
      chrome.runtime.sendMessage({ type: MSG.GET_BLOCKLIST }, (bl) => {
        if (chrome.runtime.lastError || !bl) return;
        const allow = new Set(Object.keys(bl.allowlist || {}).map((k) => (k[0] === "@" ? k.toLowerCase() : k)));
        const channels = bl.channels || {};
        const byHandle = new Map();
        const byUcid = new Map();
        for (const [key, entry] of Object.entries(channels)) {
          if (key.charAt(0) === "@") byHandle.set(key.toLowerCase(), entry);
          else if (key.startsWith("UC")) byUcid.set(key, entry);
          if (entry && entry.handle) byHandle.set(String(entry.handle).toLowerCase(), entry);
          if (entry && entry.ucid) byUcid.set(String(entry.ucid), entry);
        }
        const lookup = (key) => {
          if (!key || allow.has(key[0] === "@" ? key.toLowerCase() : key)) return undefined;
          return channels[key] || byHandle.get(key.toLowerCase()) || byUcid.get(key);
        };
        const blank = () => {
          document.documentElement.innerHTML =
            '<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;' +
            'background:#0f0f0f;color:#888;font:13px system-ui,-apple-system,sans-serif">Blocked by BlockTube</body>';
          try {
            document.querySelectorAll("video").forEach((v) => v.pause());
          } catch {}
        };
        if ((bl.videos || {})[embedVideoId]) return blank();
        // Nothing on an embed page names the uploader, so ask the background
        // (oEmbed, cached) — the same lookup the top-level /embed/ guard uses.
        chrome.runtime.sendMessage({ type: MSG.RESOLVE_VIDEO_CHANNEL, videoId: embedVideoId }, (res) => {
          if (chrome.runtime.lastError || !res || !res.channelKey) return;
          const entry = lookup(res.channelKey);
          // A whitelisted video of a video-only channel still plays.
          if (!entry) return;
          if (entry.mode === CHANNEL_MODE.EXCEPT_WHITELIST && entry.whitelist && entry.whitelist[embedVideoId]) return;
          blank();
        });
      });
    });
    return;
  }

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
  // Every removable thing has its own switch (see SETTING_GROUPS). These are
  // the groups a scrub covers: the scrub bails early only when *nothing* in
  // its group is on, then checks each key where it acts.
  const SIDEBAR_KEYS = ["sidebarHome", "sidebarShorts", "sidebarExplore", "sidebarMoreFromYouTube", "sidebarReportHistory", "sidebarFooter"];
  const ACTION_KEYS = ["actionShare", "actionSave", "actionDownload", "actionClip", "actionThanks", "actionMore"];
  const MEMBERSHIP_KEYS = ["joinButton", "membershipPrices", "membersOnlyTiles", "membershipTab"];
  const CHANNEL_TAB_KEYS = ["tabPosts", "tabShows", "tabPodcasts", "tabStore", "shortsChannelTab", "membershipTab"];
  const anyOn = (keys) => keys.some((k) => settings[k]);

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
      shorts: ["shorts"],
      shows: ["shows"],
      store: ["store", "shop"],
      posts: ["posts", "community"],
      podcasts: ["podcasts"]
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
      shorts: ["shorts"],
      shows: ["chương trình"],
      store: ["cửa hàng"],
      posts: ["bài đăng", "cộng đồng"],
      podcasts: ["podcast"]
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
      shorts: ["shorts"],
      shows: ["programas", "series"],
      store: ["tienda"],
      posts: ["publicaciones", "comunidad"],
      podcasts: ["podcasts"]
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
      shorts: ["shorts"],
      shows: ["programas", "séries"],
      store: ["loja"],
      posts: ["publicações", "comunidade"],
      podcasts: ["podcasts"]
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
      shorts: ["shorts"],
      shows: ["émissions", "séries"],
      store: ["boutique"],
      posts: ["posts", "publications", "communauté"],
      podcasts: ["podcasts"]
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
      shorts: ["shorts"],
      shows: ["sendungen", "serien"],
      store: ["shop", "store"],
      posts: ["beiträge", "community"],
      podcasts: ["podcasts"]
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
    sidebarHome: `
      ytd-mini-guide-entry-renderer:has(> a[href="/"]),
      ytd-guide-entry-renderer:has(> a[href="/"]),
      ytm-pivot-bar-item-renderer:has(a[href="/"]),
      ytm-guide-entry-renderer:has(a[href="/"])
        { display: none !important; }`,
    sidebarShorts: `
      ytd-mini-guide-entry-renderer:has(> a[href="/shorts/"]),
      ytd-guide-entry-renderer:has(> a[href="/shorts/"]),
      ytd-guide-entry-renderer:has(> a[title="Shorts" i]),
      ytm-pivot-bar-item-renderer:has(a[href="/shorts/"]),
      ytm-guide-entry-renderer:has(a[href="/shorts/"])
        { display: none !important; }`,
    sidebarReportHistory: `
      ytd-guide-entry-renderer:has(> a[title="Report history" i])
        { display: none !important; }`,
    mastheadCreate: `
      ${ariaSel("ytd-masthead ", L.create)}
        { display: none !important; }`,
    mastheadNotifications: `
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
    actionShare: `
      ytd-watch-metadata #actions yt-button-view-model:has(:is(${ariaSel("", L.share)}))
        { display: none !important; }`,
    actionSave: `
      ytd-watch-metadata #actions yt-button-view-model:has(:is(${ariaSel("", L.save)}))
        { display: none !important; }`,
    actionClip: `
      ytd-watch-metadata #actions yt-button-view-model:has(:is(${ariaSel("", L.clip)}))
        { display: none !important; }`,
    actionThanks: `
      ytd-watch-metadata #actions yt-button-view-model:has(:is(${ariaSel("", L.thanks)}))
        { display: none !important; }`,
    actionDownload: `
      ytd-watch-metadata #actions ytd-download-button-renderer
        { display: none !important; }`,
    actionMore: `
      ytd-watch-metadata #actions yt-icon-button:has(:is(${ariaSel("", L.more)}))
        { display: none !important; }`,
    joinButton: `
      /* the legacy "Join" (channel membership) button, watch + channel page.
         The modern channel header's Join is a bare button-view-model with no
         membership-specific hook — scrubJoinButtons() matches that by label. */
      #sponsor-button,
      ytd-sponsor-button-renderer,
      yt-sponsor-button-view-model
        { display: none !important; }`,
    membersOnlyTiles: `
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
    shortsFeedTiles: `
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

  // Playlist / mix cards (their own tags, plus a lockup that carries a
  // real playlist link — PL… user playlists, UU… uploads, OL… official,
  // FL… favourites; RD… "mixes" are auto-generated and belong to nobody).
  const PLAYLIST_TILE_TAGS = [
    "ytd-playlist-renderer",
    "ytd-grid-playlist-renderer",
    "ytd-compact-playlist-renderer",
    "ytd-radio-renderer",
    "ytd-compact-radio-renderer",
    "ytm-playlist-renderer",
    "ytm-compact-playlist-renderer"
  ].join(",");
  const PLAYLIST_LINK_SEL =
    'a[href*="/playlist?list="], a[href*="&list=PL"], a[href*="?list=PL"], a[href*="&list=UU"], a[href*="?list=UU"], a[href*="&list=OL"], a[href*="&list=FL"]';

  // Community / "Posts" tab entries (and reshares). Handled on their own
  // path, not via RENDERER_SELECTOR — a post isn't a video tile.
  const POST_SELECTOR = [
    "ytd-backstage-post-thread-renderer",
    "ytd-post-renderer",
    "ytd-backstage-post-renderer",
    "ytd-shared-post-renderer",
    "ytm-post-renderer",
    "ytm-backstage-post-renderer"
  ].join(",");

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
  // How many blocked entries get a pre-paint `:has()` rule. This is a pure
  // anti-flash optimisation — the JS scrub removes everything regardless — and
  // it is not free: the browser re-evaluates the whole selector list on every
  // style recalc, so the cost scales with the cap and is paid on every page,
  // continuously, whether or not any of those channels is present.
  //
  // Measured while scrolling a search page for ~11s (style recalc time, and
  // total CPU as a share of wall):
  //   no extension   0.05s / 15%
  //   150 channels   0.14s / 15%
  //   400 channels   0.21s / 13%
  //   800 channels   0.42s / 17%
  //   1500 channels  0.86s / 23%   <- the old cap
  // At 400 the extension is indistinguishable from not running; at 1500 it is
  // the single largest thing it costs a normal page. Entries past the cap lose
  // only the pre-paint hide (a possible one-frame flash), never the block —
  // and they are the *least* recently blocked, so the ones you are least
  // likely to meet. Raising this back up is a real, measurable tax.
  const INSTANT_HIDE_MAX_CHANNELS = 400;
  const INSTANT_HIDE_MAX_VIDEOS = 250;
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
    // whitelisted video IDs". Soft channels also get playlist/post clauses
    // here (FULL channels' playlists/posts are already covered by the shared
    // `inner` rule below, which now includes POST_SELECTOR — no per-channel
    // cost). Soft channels are few, so a couple of extra clauses each is fine.
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
        // Playlists + community posts by a soft-blocked channel go regardless
        // of the age rule (a playlist has no single date). FULL channels get
        // this for free from the shared `inner` rule below.
        exceptRules.push(
          `:is(${PLAYLIST_TILE_TAGS}):has(${channelLink})`,
          `:is(${RENDERER_SELECTOR},${LOCKUP_SELECTOR}):has(${channelLink}):has(${PLAYLIST_LINK_SEL})`,
          `:is(${POST_SELECTOR}):has(${channelLink})`
        );
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
      // POST_SELECTOR in the :is() so a FULL-blocked channel's community
      // posts are hidden by the same rule (a post carries the author link).
      rules.push(
        `:is(${RENDERER_SELECTOR},${LOCKUP_SELECTOR},${POST_SELECTOR}):has(${inner.join(",")}) { display: none !important; }`
      );
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
    if (!settings.shortsFeedTiles) return;
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
  // Built per call now, because each guide entry has its own switch.
  function activeNavLabels() {
    const out = new Set();
    const add = (list) => { for (const s of list) out.add(s.toLowerCase()); };
    if (settings.sidebarShorts) add(L.shorts);
    if (settings.sidebarExplore) add(L.explore);
    if (settings.sidebarMoreFromYouTube) add(L.moreFromYouTube);
    if (settings.sidebarReportHistory) { add(L.reportHistory); add(L.report); }
    return out;
  }
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
    if (!anyOn(SIDEBAR_KEYS)) return;
    if (!root.querySelectorAll) return;
    root.querySelectorAll(GUIDE_CONTAINER_SELECTOR).forEach((guide) => {
      // Home and Shorts: matched by their link, not their tag/label — far
      // less likely to break if YouTube renames the wrapper element again
      // or the UI is in another language. YouTube's actual Shorts link is
      // "/shorts/" (trailing slash) — confirmed against the live site.
      const linkSel = [settings.sidebarHome && 'a[href="/"]', settings.sidebarShorts && 'a[href="/shorts/"]']
        .filter(Boolean)
        .join(",");
      if (!linkSel) return;
      guide.querySelectorAll(linkSel).forEach((a) => {
        const item = a.closest(NAV_ITEM_WRAPPER_SELECTOR) || a;
        item.remove();
      });
    });
    root
      .querySelectorAll(
        "ytd-guide-entry-renderer, ytd-mini-guide-entry-renderer, ytd-guide-section-renderer, ytm-pivot-bar-item-renderer, ytm-guide-entry-renderer"
      )
      .forEach((el) => {
        if (activeNavLabels().has(navLabelOf(el).toLowerCase())) el.remove();
      });
    // The little-print link list + copyright line at the bottom of the guide.
    // Scoped to ytd-guide-renderer and gated on its distinctive text so this
    // never touches an unrelated #footer elsewhere on the page.
    if (!settings.sidebarFooter) return;
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
    if (!settings.mastheadCreate && !settings.mastheadNotifications) return;
    const masthead = root.querySelector ? root.querySelector("ytd-masthead, ytm-app-bar-renderer") : null;
    if (!masthead) return;
    if (settings.mastheadNotifications) {
      masthead.querySelectorAll("ytd-notification-topbar-button-renderer").forEach((el) => el.remove());
    }
    masthead
      .querySelectorAll("button, a, yt-icon-button, ytd-button-renderer, tp-yt-paper-icon-button, ytd-topbar-menu-button-renderer")
      .forEach((el) => {
        const label = (el.getAttribute("aria-label") || el.getAttribute("title") || "").trim();
        const isCreate = settings.mastheadCreate && MASTHEAD_CREATE_LABELS.has(label.toLowerCase());
        const isNotif = settings.mastheadNotifications && MASTHEAD_HIDE_NOTIF_RE.test(label);
        if (isCreate || isNotif) {
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
  // Built per call: each button under a video is its own switch. "Report"
  // rides with More, because removing the overflow menu is what puts it out of
  // reach in the first place.
  function activeActionLabels() {
    const out = new Set();
    const add = (list) => { for (const s of list) out.add(s.toLowerCase()); };
    if (settings.actionShare) add(L.share);
    if (settings.actionSave) add(L.save);
    if (settings.actionClip) add(L.clip);
    if (settings.actionThanks) add(L.thanks);
    if (settings.actionDownload) add(L.download);
    if (settings.actionMore) { add(L.more); add(L.report); }
    return out;
  }
  function scrubVideoActions(root) {
    if (!anyOn(ACTION_KEYS)) return;
    if (!root.querySelectorAll) return;
    root.querySelectorAll("ytd-watch-metadata #actions").forEach((actions) => {
      actions.querySelectorAll("[aria-label]").forEach((el) => {
        const label = (el.getAttribute("aria-label") || "").trim().toLowerCase();
        if (!activeActionLabels().has(label) || label.includes("like")) return;
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
      // Must go through runExtras() rather than repeating its list here — this
      // is the path the 2s heartbeat drives, so anything listed only in one of
      // the two copies silently never runs on a normal page load.
      runExtras();
      recheckHydratingTiles(document.documentElement);
    }, 400);
  }
  // Heartbeat: guarantees these eventually run even on the rare page that
  // doesn't trigger a childList mutation our observer catches.
  setInterval(scheduleExtrasScrub, 2000);

  const CHANNEL_HREF_RE = /^\/(channel\/UC[\w-]{22}|@[\w.-]+)/;
  const VIDEO_ID_FROM_QUERY_RE = /[?&]v=([\w-]{11})/;
  const VIDEO_ID_FROM_SHORTS_RE = /\/shorts\/([\w-]{11})/;
  // YouTube serves the same video under several path shapes. /live/<id> and
  // /embed/<id> render a real player but carry no "?v=" — without these the
  // nav guard reads "no video on this page" and lets a blocked video play.
  const VIDEO_ID_FROM_PATH_RE = /^\/(?:live|embed|v)\/([\w-]{11})/;

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
  // Nothing on YouTube predates 2005, and a future date means we misread
  // something. A value outside this range is not an age, it is a parse bug.
  const MAX_PLAUSIBLE_AGE_DAYS = 100 * 365.25;
  function plausibleAgeDays(d) {
    return typeof d === "number" && Number.isFinite(d) && d >= -1 && d <= MAX_PLAUSIBLE_AGE_DAYS;
  }

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
    const isPlaylist =
      (el.matches && el.matches(PLAYLIST_TILE_TAGS)) || !!el.querySelector(PLAYLIST_LINK_SEL);
    if (!videoId && channels.size === 0 && !isPlaylist) return null;
    // Only bother reading the tile's publish text / duration when a blocked
    // channel has an age rule / a duration filter is active — parsing every
    // tile otherwise is wasted work.
    let ageDays = anyAgeRule && videoId ? parseAgeDays(el.textContent || "") : null;
    if (!plausibleAgeDays(ageDays)) ageDays = null;
    const durationSec =
      videoId && (durMinSec > 0 || durMaxSec > 0) ? readDurationSec(el) : null;
    return { videoId, videoTitle, channels, ageDays, durationSec, isPlaylist };
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
      if (!e) continue;
      const via = blockedChannels.has(key) ? "key" : key.charAt(0) === "@" ? "@handle index" : "ucid index";
      // A playlist made by a blocked channel goes regardless of block mode /
      // age rule — a playlist has no single publish date, and "block their
      // videos" naturally covers "block their playlists of those videos".
      if (info.isPlaylist) return `playlist by blocked channel ${key} (via ${via})`;
      if (channelBlocks(e, info.videoId, info.ageDays)) {
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
    if (settings.membersOnlyTiles && isMembersOnlyTile(el)) {
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
      notePageSuppressed(1);
      el.remove();
      if (shelf) scheduleShelfPrune(shelf);
      return;
    }
    if (blocklistLoaded) {
      // Don't lock in "checked" while a filter is active and the thing it
      // needs hasn't hydrated yet — recheckHydratingTiles() comes back for
      // these. A tile marked checked is never looked at again, so getting this
      // wrong doesn't delay a filter, it disables it: the duration badge
      // mounts a beat after the tile, and duration was missing from this test
      // entirely, which silently switched the whole length filter off on a
      // normal page load.
      const titlePending = keywordMatchers.length && info && info.videoId && !info.videoTitle;
      const durPending = (durMinSec > 0 || durMaxSec > 0) && info && info.videoId && info.durationSec == null;
      // A live stream has no duration and never will, so bound the retries
      // rather than re-processing it on every pass forever.
      const tries = Number(el.dataset.btPending || 0);
      if ((titlePending || durPending) && tries < REHYDRATE_MAX_TRIES) {
        el.dataset.btPending = String(tries + 1);
      } else {
        delete el.dataset.btPending;
        el.dataset.btChecked = "1";
      }
      if (info) injectBlockButton(el, info);
    }
  }

  // Community / "Posts" tab entries. A post isn't a video tile, so it gets
  // its own tiny path: if any channel it links to (its author, or a channel
  // it reshares/mentions) is blocked — and none is allow-listed — it's gone.
  function processPost(el) {
    if (!blocklistLoaded || el.dataset.btPost === "1") return;
    let hit = null;
    for (const a of el.querySelectorAll('a[href^="/@"], a[href^="/channel/UC"]')) {
      const key = normalizeChannelKey(a.getAttribute("href") || "");
      if (!key) continue;
      if (isAllowlisted(key)) return; // allow-list wins, leave it and don't re-check
      if (!hit && blockedEntryFor(key)) hit = key;
    }
    if (!hit) {
      el.dataset.btPost = "1";
      return;
    }
    const shelf = findShelfAncestor(el);
    dbg("removed post —", hit);
    el.remove();
    if (shelf) scheduleShelfPrune(shelf);
  }
  function scrubPosts(root) {
    if (!blocklistLoaded || !root.querySelectorAll) return;
    if (root.matches && root.matches(POST_SELECTOR)) processPost(root);
    root.querySelectorAll(POST_SELECTOR).forEach(processPost);
  }

  // ---------- comments by a blocked channel ----------
  // Blocking someone and then meeting their comments under every video you
  // watch is the most visible way "blocked" stops meaning blocked. Comments
  // are not tiles and not posts — they get their own path.
  //
  // Only the AUTHOR link decides. A comment that merely @mentions a blocked
  // channel must survive: it is someone else talking, and removing it is the
  // same class of false positive as matching `@mkbhd` against `@mkbhd508`.
  //
  // FULL blocks only, via `channelBlocks(entry, null)` — the same "does this
  // mode block the channel itself" question the nav guard asks. Video-only
  // mode means "keep the channel, drop its videos", so their comments stay.
  const COMMENT_THREAD_SELECTOR = "ytd-comment-thread-renderer, ytm-comment-thread-renderer";
  const COMMENT_SELECTOR = "ytd-comment-view-model, ytd-comment-renderer, ytm-comment-renderer";
  const COMMENT_AUTHOR_SEL = "#author-text, a#author-text, #header-author a[href]";

  function commentAuthorBlocked(comment) {
    const a = comment.querySelector(COMMENT_AUTHOR_SEL);
    if (!a) return null; // header hasn't hydrated — caller leaves it unmarked
    const key = normalizeChannelKey(a.getAttribute("href") || "");
    if (!key) return null;
    const entry = blockedEntryFor(key); // allow-list short-circuits in here
    return entry && channelBlocks(entry, null) ? key : false;
  }

  function scrubComments(root) {
    if (!blocklistLoaded || !root.querySelectorAll) return;
    if (!blockedChannels.size) return;

    // A thread goes as a unit when its top-level comment's author is blocked.
    // querySelector is document-order, so the first comment inside a thread is
    // the top-level one; replies sit deeper, inside ytd-comment-replies-renderer.
    root.querySelectorAll(COMMENT_THREAD_SELECTOR).forEach((thread) => {
      if (thread.dataset.btComment === "1" || !thread.isConnected) return;
      const top = thread.querySelector(COMMENT_SELECTOR);
      if (!top) return; // not hydrated yet; a later pass will catch it
      const verdict = commentAuthorBlocked(top);
      if (verdict === null) return; // author not readable yet
      if (verdict) {
        dbg("removed comment thread —", verdict);
        thread.remove();
        return;
      }
      thread.dataset.btComment = "1";
    });

    // Replies are individually authored, so they are judged individually.
    root.querySelectorAll("ytd-comment-replies-renderer " + COMMENT_SELECTOR).forEach((reply) => {
      if (reply.dataset.btComment === "1" || !reply.isConnected) return;
      const verdict = commentAuthorBlocked(reply);
      if (verdict === null) return;
      if (verdict) {
        dbg("removed comment reply —", verdict);
        reply.remove();
        return;
      }
      reply.dataset.btComment = "1";
    });
  }

  // Throttled backup for members-only content: catches tiles whose badge
  // hydrated after processRenderer already marked them checked, plus the
  // "Membership" / "Members-only content" shelf and the channel Membership
  // tab (neither is a tile). Gated on hideMemberships.
  function scrubMembersOnly(root) {
    if (!anyOn(MEMBERSHIP_KEYS)) return;
    if (!root.querySelectorAll) return;
    if (settings.membersOnlyTiles) {
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
    }
    if (settings.membershipTab) {
      const membershipTabSet = new Set([...L.membership, ...L.membersOnly, "members", "membership"].map((s) => s.toLowerCase()));
      root.querySelectorAll(CHANNEL_TAB_SEL).forEach((t) => {
        if (t.isConnected && membershipTabSet.has((t.textContent || "").trim().toLowerCase())) t.remove();
      });
    }
    if (settings.joinButton) scrubJoinButtons(root);
    if (settings.membershipPrices) scrubMembershipPrices(root);
  }

  // The Join button is hidden by CSS, but YouTube renders its *price offer*
  // as separate text beside it ("A$0 for 1st month", "A$7.49/mo") — hiding the
  // button alone leaves a bare price floating in the channel header.
  //
  // Text-matched, so it is scoped hard: only leaf elements, only inside the
  // channel/watch owner header, and only short strings that are essentially
  // nothing but a price. A channel page is full of video titles containing
  // "$5,000" (confirmed live), and those must not be touched — hence the
  // anchored patterns rather than a loose currency search.
  const MEMBERSHIP_PRICE_RE = [
    // "A$7.49/mo", "$4.99 / month", "€3,99/Monat" — anywhere in a short string,
    // since YouTube renders the offer as "Join  A$7.49/mo" and splits it
    // across spans.
    /\d[\d.,]*\s*\/\s*(mo|month|mois|monat|mês|mes|tháng)\b/i,
    // "A$0 for 1st month", "$0 for first month"
    /\d[\d.,]*\s+(for|pour|für|por|para|cho)\b.*\b(1st|first|premier|erste[rn]?|primeiro|primer|đầu)\b/i
  ];
  // Scope: the whole channel header (plus the watch page's owner row), MINUS
  // the description blurb. Scoping to just the action row was too tight — the
  // offer line is not necessarily a child of the button row — but the
  // description is free text that can legitimately contain "$5/mo", so it is
  // excluded explicitly rather than by hoping the pattern never matches it.
  const PRICE_SCOPE_SEL =
    "yt-flexible-actions-view-model, yt-page-header-renderer, yt-page-header-view-model, #channel-header, #channel-header-container, ytd-video-owner-renderer, #owner, #sponsor-button, ytd-sponsor-button-renderer, yt-sponsor-button-view-model";
  // Description-specific ONLY. Generic containers (`#content`, `#contents`)
  // must never appear here: they wrap the header itself on a channel page, so
  // excluding them silently disables the whole scrub.
  const PRICE_EXCLUDE_SEL =
    "#description, #description-container, .ytPageHeaderViewModelDescription, yt-description-preview-view-model, #channel-tagline, ytd-channel-tagline-renderer";
  function scrubMembershipPrices(root) {
    if (!root.querySelectorAll) return;
    for (const scope of root.querySelectorAll(PRICE_SCOPE_SEL)) {
      if (!scope.isConnected) continue;
      const hits = [];
      for (const el of scope.querySelectorAll("*")) {
        if (!el.isConnected) continue;
        if (el.closest(PRICE_EXCLUDE_SEL)) continue; // channel description etc.
        const t = (el.textContent || "").trim();
        // Bounded strings only: an offer is a line, not a paragraph. Matching
        // on textContent rather than leaf nodes is what catches "A$7.49/mo"
        // when YouTube splits it into per-token spans (a leaf-only pass sees
        // "A$7.49" and "/mo" separately and matches neither). The bound is
        // generous enough for a whole offer line ("A$0 for 1st month, then
        // A$7.49/mo") — the filter below takes the OUTERMOST match, so the
        // line goes as a unit rather than leaving its other half behind. The
        // bound is what stops that from walking up into the whole header.
        if (!t || t.length > 90) continue;
        if (MEMBERSHIP_PRICE_RE.some((re) => re.test(t))) hits.push(el);
      }
      // Keep only the outermost matches, then climb to the smallest wrapper
      // holding nothing but the price so the row doesn't collapse to an empty
      // padded box.
      for (const el of hits) {
        if (!el.isConnected) continue;
        if (hits.some((other) => other !== el && other.contains(el))) continue;
        let node = el;
        const t = (node.textContent || "").trim();
        while (node.parentElement && node.parentElement !== scope && (node.parentElement.textContent || "").trim() === t) {
          node = node.parentElement;
        }
        node.remove();
      }
    }
  }

  // The "Join" button. The CSS layer covers the old components
  // (`#sponsor-button` and friends), but the modern channel header renders it
  // as a plain `button-view-model` inside `yt-flexible-actions-view-model`
  // with NO membership-specific tag or id — confirmed live — so nothing in
  // that selector list matched and the button (and the price offer beside it)
  // stayed on the page. Match it the only way that's left: by its label.
  // `aria-label` is "Join this channel", so this is a prefix test, not equality.
  const JOIN_SCOPE_SEL =
    "yt-flexible-actions-view-model, yt-page-header-renderer, #channel-header, ytd-video-owner-renderer, #owner";
  const JOIN_BTN_SEL = "button, button-view-model, ytd-button-renderer, yt-button-shape, a[role='button']";
  function scrubJoinButtons(root) {
    if (!root.querySelectorAll) return;
    const joinRe = new RegExp("^(?:" + L.join.map(reEscape).join("|") + ")\\b", "i");
    for (const scope of root.querySelectorAll(JOIN_SCOPE_SEL)) {
      if (!scope.isConnected) continue;
      for (const btn of scope.querySelectorAll(JOIN_BTN_SEL)) {
        if (!btn.isConnected) continue;
        const label = (btn.getAttribute("aria-label") || btn.textContent || "").trim();
        if (!label || !joinRe.test(label)) continue;
        // Remove the flexible-actions slot rather than the bare button, so the
        // row doesn't keep its gap — and so an offer rendered inside the same
        // slot goes with it.
        const slot =
          btn.closest(".ytFlexibleActionsViewModelAction, button-view-model, ytd-button-renderer, #sponsor-button") || btn;
        slot.remove();
      }
    }
  }

  // ---------- channel-page tabs (Shorts / Shows / Store / Posts) ----------
  // Tabs are `yt-tab-shape` elements identified only by their visible label,
  // so this reads from LABELS_BY_LANG like the other text-matched chrome.
  // The Shorts tab also goes when `removeShorts` is on — that toggle's job is
  // to make Shorts unreachable, and a tab straight into them contradicts it.
  const CHANNEL_TAB_SEL = "yt-tab-shape, tp-yt-paper-tab, [role='tab']";
  function scrubChannelTabs(root) {
    if (!root.querySelectorAll) return;
    if (!anyOn(CHANNEL_TAB_KEYS)) return;
    const wanted = new Set();
    const addAll = (list) => { for (const s of list) wanted.add(s.toLowerCase()); };
    if (settings.tabShows) addAll(L.shows);
    if (settings.tabStore) addAll(L.store);
    if (settings.tabPosts) addAll(L.posts);
    if (settings.tabPodcasts) addAll(L.podcasts);
    if (settings.shortsChannelTab) addAll(L.shorts);
    if (settings.membershipTab) addAll([...L.membership, ...L.membersOnly]);
    if (!wanted.size) return;
    root.querySelectorAll(CHANNEL_TAB_SEL).forEach((t) => {
      if (t.isConnected && wanted.has((t.textContent || "").trim().toLowerCase())) t.remove();
    });

    // Same targets rendered as a BUTTON rather than a tab. YouTube's channel
    // header uses generic `ytSpecButtonShapeNext*` buttons with no
    // tab semantics, so the tab selectors above never see them. Matched on the
    // exact label and scoped to the header, because those button classes are
    // shared site-wide (Subscribe is the same family) — anything looser would
    // strip unrelated buttons.
    for (const scope of root.querySelectorAll(CHANNEL_TAB_LINK_SCOPE)) {
      if (!scope.isConnected) continue;
      for (const b of scope.querySelectorAll("button, button-view-model, ytd-button-renderer, yt-button-shape")) {
        if (!b.isConnected) continue;
        const label = (b.getAttribute("aria-label") || b.textContent || "").trim().toLowerCase();
        if (!label || !wanted.has(label)) continue;
        (b.closest(".ytFlexibleActionsViewModelAction, button-view-model, ytd-button-renderer") || b).remove();
      }
    }

    // Same targets, matched by URL instead of label. Tabs themselves carry no
    // href (confirmed live), but the header also renders these as plain links
    // in some layouts — and a link's path is locale-proof, so this catches a
    // "Community" entry on a UI language whose label isn't in the table.
    const paths = [];
    if (settings.tabShows) paths.push("shows");
    if (settings.tabStore) paths.push("store");
    if (settings.tabPodcasts) paths.push("podcasts");
    if (settings.tabPosts) paths.push("community", "posts", "releases");
    if (settings.shortsChannelTab) paths.push("shorts");
    if (!paths.length) return;
    const pathRe = new RegExp("/(?:" + paths.join("|") + ")/?$", "i");
    for (const a of root.querySelectorAll(CHANNEL_TAB_LINK_SCOPE + " a[href]")) {
      if (!a.isConnected) continue;
      const href = a.getAttribute("href") || "";
      // Only a channel's own sub-tab, i.e. /@handle/community or
      // /channel/UC…/community — never a bare /shorts feed link elsewhere.
      if (!/^\/(?:@|channel\/UC|c\/|user\/)/.test(href) || !pathRe.test(href.split("?")[0])) continue;
      (a.closest(CHANNEL_TAB_SEL) || a).remove();
    }
  }
  // Where such a link may legitimately be treated as a channel tab. Scoped so
  // a link in a description or a video tile can never be mistaken for one.
  const CHANNEL_TAB_LINK_SCOPE =
    "yt-page-header-renderer, yt-page-header-view-model, #channel-header, #channel-header-container, yt-tab-group-shape, tp-yt-paper-tabs, #tabsContent";

  // ---------- stop a fully-blocked feed loading forever ----------
  // YouTube's infinite feeds load more whenever a continuation sentinel is in
  // view. That assumes what it just added made the page taller. When the
  // blocklist suppresses *everything* — a blocked channel's own grid, or a
  // search where every result is blocked — the page height never changes, so
  // the sentinel stays on screen and YouTube fetches the next page
  // immediately, forever.
  //
  // Measured on a video-only-blocked channel's /videos tab, sitting still and
  // never scrolling: tiles 210 -> 510 -> 690 while document height stayed at
  // 1388px, node count 12k -> 35k in 24s, 77% CPU, and long tasks up to 1.5s —
  // which is what makes the whole browser (and the machine) stop responding to
  // typing. It does not settle on its own; it ends when the tab dies.
  //
  // So: when a feed has tiles but *none* of them are visible, drop the
  // sentinel. YouTube's observer then has nothing to trigger on and the loop
  // stops. The accumulated hidden tiles get removed too, in bounded batches, so
  // the DOM doesn't keep the memory.
  const CONTINUATION_SEL = "ytd-continuation-item-renderer, ytm-continuation-item-renderer";
  const CURB_MIN_SUPPRESSED = 12; // don't act on a feed that merely hasn't filled yet
  const CURB_REMOVE_BUDGET = 150; // per pass, so cleanup never becomes a long task
  const NOTICE_TAG = "bt-blocked-notice";

  // How many tiles this page view has had taken away. Counting removals — not
  // surviving tiles — is what makes the check below survive its own cleanup:
  // once the curb has removed everything there is nothing left to count, and a
  // tile-based test would stop recognising the very state it created.
  let suppressedOnPage = 0;
  function notePageSuppressed(n) {
    suppressedOnPage += n;
  }
  function resetPageSuppressed() {
    suppressedOnPage = 0;
    document.querySelectorAll(NOTICE_TAG).forEach((el) => el.remove());
  }

  // YouTube's infinite feeds fetch the next page whenever a continuation
  // sentinel is in the viewport. That assumes what it just added made the page
  // taller. When the blocklist suppresses *everything* — a blocked channel's
  // own grid, or a search where every result is blocked — the height never
  // changes, the sentinel never leaves the screen, and YouTube fetches forever.
  //
  // Measured on a video-only-blocked channel's /videos tab, sitting still:
  // 22 continuation requests in 30s (0 with the extension off), tiles
  // 210 -> 510 -> 690 against a document height pinned at 1388px, 12k -> 35k
  // nodes in 24s, 77% CPU, long tasks up to 1.5s. That last number is why the
  // machine stops responding to typing. It does not settle; it ends when the
  // tab dies.
  //
  // Removing the sentinel alone does NOT fix it — YouTube re-creates it and
  // asks again. The page has to become taller than the viewport, so the notice
  // is the load-bearing part, not decoration. It also answers the question a
  // silently blank page raises.
  function curbRunawayFeed() {
    const sentinel = document.querySelector(CONTINUATION_SEL);
    if (!sentinel) return;
    if (suppressedOnPage < CURB_MIN_SUPPRESSED) return; // short, but not by us
    // Match YouTube's own trigger: it fetches while the sentinel is in (or
    // near) the viewport. Testing "can the page scroll at all" is NOT the same
    // thing and gets this wrong — a blocked channel page still scrolls by the
    // height of its masthead and header (measured 1388px against a 1000px
    // viewport), so that test passed while the feed underneath was looping.
    const rect = sentinel.getBoundingClientRect();
    if (rect.top > window.innerHeight * 1.5) return; // out of range; loading normally

    sentinel.parentNode && document.querySelectorAll(CONTINUATION_SEL).forEach((el) => el.remove());

    // Reclaim whatever is still sitting hidden in the DOM, in bounded batches.
    let budget = CURB_REMOVE_BUDGET;
    for (const el of queryTiles(document)) {
      if (budget-- <= 0) break;
      if (el.offsetParent === null) el.remove();
    }

    if (!document.querySelector(NOTICE_TAG)) {
      // Insert *where the sentinel was* — inside the feed's own contents — so
      // the height lands above any sentinel YouTube re-creates. Appending after
      // the grid leaves the sentinel at the top of the viewport and changes
      // nothing (measured: still 21 requests in 30s).
      const host = sentinel.parentNode || document.querySelector("ytd-rich-grid-renderer, ytd-section-list-renderer");
      if (host) {
        const note = document.createElement(NOTICE_TAG);
        // Inline styles so neither YouTube's stylesheets nor our own can touch
        // it, and so it matches none of our scrub selectors. min-height is what
        // actually breaks the loop.
        note.style.cssText = [
          "display:flex",
          "align-items:center",
          "justify-content:center",
          "min-height:90vh",
          "padding:40px 20px",
          "color:#888",
          "font:500 14px/1.6 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
          "text-align:center"
        ].join(";");
        note.textContent = "Everything here is blocked by BlockTube.";
        host.appendChild(note);
        dbg("runaway feed curbed —", suppressedOnPage, "tiles suppressed; continuation stopped");
      }
    }
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
    "ytd-grid-playlist-renderer",
    "ytd-playlist-renderer",
    "ytm-rich-item-renderer",
    "yt-lockup-view-model"
  ].join(",");

  function updateChannelPageHideCSS(entry) {
    if (!entry) {
      if (channelPageHideStyle.textContent) channelPageHideStyle.textContent = "";
      return;
    }
    const scope = 'ytd-browse[page-subtype="channels"] ';
    const parts = [];
    // Videos / Shorts grid — CSS can't do date math, so an age-ruled channel
    // leaves this to the JS pass. Scoped to the channel-page browse container
    // so it can never touch the home feed (also a ytd-browse).
    if (!(entry.blockOlderThanDays > 0)) {
      const wl = Object.keys(entry.whitelist || {});
      const notWl = wl.length
        ? `:not(:has(${wl.map((id) => `a[href*="v=${cssStringEscape(id)}"]`).join(",")}))`
        : "";
      parts.push(`${scope}:is(${CHANNEL_PAGE_TILE_SEL}):has(a[href*="watch?v="], a[href*="/shorts/"])${notWl}`);
    }
    // The Playlists tab — a playlist has no publish date, so it's hidden for
    // any blocked mode (including age-ruled).
    parts.push(`${scope}:is(${CHANNEL_PAGE_TILE_SEL}):has(${PLAYLIST_LINK_SEL})`);
    channelPageHideStyle.textContent = parts.join(",\n") + " { display: none !important; }";
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
      if (!info) return;
      // Playlists on the Playlists tab: gone for any blocked mode.
      // Videos on the Videos/Streams grid: whitelist + age rule still apply.
      const remove = info.isPlaylist
        ? true
        : info.videoId && channelBlocks(entry, info.videoId, info.ageDays);
      if (remove) {
        const shelf = findShelfAncestor(el);
        notePageSuppressed(1);
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
    scrubPosts(root);
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
  // How many passes a tile gets to hydrate its title/duration before we stop
  // asking. The bound exists for a live stream, which has no duration and
  // never will — without it such a tile is re-examined every pass for the life
  // of the page.
  //
  // Size it off the SLOW path, not the fast one. The throttle is ~400ms, but
  // it only fires on DOM mutation; once a page goes quiet the 2s heartbeat is
  // what drives it. At 8 tries that was ~16s, and a late-hydrating tile on a
  // settled page was still being locked in before its badge arrived (one
  // 2½-hour video survived a length bound in exactly that way). 25 gives ~50s
  // on the heartbeat, and the cost of being wrong the other way is only a few
  // cheap re-reads of a handful of tiles.
  const REHYDRATE_MAX_TRIES = 25;
  function recheckHydratingTiles(root) {
    if (!root.querySelectorAll) return;
    root.querySelectorAll(REHYDRATE_RECHECK_SELECTOR).forEach((el) => {
      if (el.matches(LOCKUP_SELECTOR) && el.closest(RENDERER_SELECTOR)) return; // already covered by its wrapper
      if (el.dataset.btChecked === "1") delete el.dataset.btChecked;
      processRenderer(el);
    });
    // Video tiles processRenderer left un-checked because a title or duration
    // badge hadn't hydrated — re-process just those. LOCKUP_SELECTOR belongs
    // here: search results are `yt-lockup-view-model` now, so leaving it out
    // meant the modern tiles were never re-examined at all.
    if (anyFilter()) {
      root
        .querySelectorAll(
          "ytd-video-renderer, ytd-rich-item-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, " +
            LOCKUP_SELECTOR
        )
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
    scrubChannelTabs(document.documentElement);
    scrubOwnChannelPage(document.documentElement);
    scrubPosts(document.documentElement);
    scrubComments(document.documentElement);
    curbRunawayFeed();
    // A fresh (non-SPA) load renders its metadata long after the blocklist
    // arrives, and "yt-navigate-finish" is not guaranteed to fire for it — so
    // the one-shot checks at load time can both run against an empty page and
    // miss. Re-checking here (throttled, plus the 2s heartbeat) is what
    // actually catches a blocked channel's video opened by URL.
    checkCurrentPageAndRedirect();
  }

  // ---------- feature toggles (chrome.storage.sync: bt_settings) ----------
  let settingsLoaded = false;
  function applySettings(next) {
    settings = resolveSettings(next); // expands legacy coarse keys too
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

  chrome.storage.sync.get({ [SETTINGS_KEY]: null, [KEYWORDS_KEY]: null }, (res) => {
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
      document.querySelectorAll(POST_SELECTOR).forEach((el) => delete el.dataset.btPost);
      document.querySelectorAll("[data-bt-comment]").forEach((el) => delete el.dataset.btComment);
      sweep(document.documentElement);
      scrubComments(document.documentElement);
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
  const SCOPE_CHANNEL_LINK_SEL = 'a[href^="/@"], a[href^="/channel/UC"]';
  const CHANNEL_LINK_SEL = SCOPE_CHANNEL_LINK_SEL;
  // The uploader byline on a watch page — the owner and any collaborators,
  // without the description's links to the same channel's other URL form.
  const OWNER_BYLINE_SEL = "#owner, ytd-video-owner-renderer, ytm-slim-owner-renderer";
  function findScopeForCurrentPage() {
    // The currently-visible Shorts player wins outright: several
    // ytd-reel-video-renderer elements are mounted at once for the vertical
    // feed's neighbours and only one carries is-active.
    const activeReel = document.querySelector("ytd-reel-video-renderer[is-active]");
    if (activeReel) return activeReel;

    // Candidates for THIS page type only. A flat "first selector that matches
    // anything" chain is wrong, for two compounding reasons:
    //   1. after an SPA navigation YouTube leaves the *other* page types'
    //      components mounted as empty shells — a /playlist page still has a
    //      childless `ytd-watch-metadata`, which used to win the chain and
    //      answer "no channel here", so a blocked channel's playlist pages
    //      stayed reachable;
    //   2. even within one page type the first match can be the empty one
    //      (a /playlist page has two `yt-page-header-renderer`s; only one
    //      carries the owner byline).
    // So: restrict by path, then prefer the first candidate that actually
    // names a channel, falling back to a bare match only if none do.
    const path = location.pathname;
    let selectors;
    if (path === "/playlist") {
      // The owner byline moved into the shared `yt-page-header-renderer`;
      // the two legacy tags still render, but empty.
      selectors = [
        "yt-page-header-renderer",
        "ytd-playlist-header-renderer",
        "ytd-playlist-sidebar-primary-info-renderer"
      ];
    } else if (path.startsWith("/post/")) {
      // A standalone community-post permalink: the post itself is the scope,
      // so its author gets picked up by the channel check.
      selectors = ["ytd-backstage-post-renderer", "ytd-post-renderer"];
    } else {
      selectors = ["ytd-watch-metadata", "#above-the-fold", "#owner"];
    }

    let fallback = null;
    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.querySelector(SCOPE_CHANNEL_LINK_SEL)) return el;
        if (!fallback) fallback = el;
      }
    }
    return fallback;
  }

  // Every channel key the CURRENT PAGE claims as its own identity, from the
  // page's canonical metadata rather than from arbitrary links in the body (a
  // channel page also links plenty of *other* channels — featured channels,
  // collaborators — and those must not be treated as "whose page is this").
  // Used to bridge the two identity formats: the URL carries one, the entry may
  // be keyed by the other. Header selectors are best-effort; canonical/meta are
  // the reliable ones.
  const CHANNEL_HEADER_SEL =
    "ytd-channel-name, #channel-header, #channel-header-container, yt-page-header-renderer, .page-header-view-model-wiz";
  function pageIdentityKeys() {
    const keys = new Set();
    const add = (raw) => {
      if (!raw) return;
      let path = raw;
      if (/^https?:\/\//i.test(raw)) {
        try {
          path = new URL(raw).pathname;
        } catch {
          return;
        }
      }
      const key = normalizeChannelKey(path);
      if (key) keys.add(key);
    };

    add(document.querySelector('link[rel="canonical"]')?.getAttribute("href"));
    add(document.querySelector('meta[property="og:url"]')?.getAttribute("content"));
    // itemprop="identifier" is the VIDEO id on a watch page, so only take a
    // value that actually looks like a channel id.
    for (const m of document.querySelectorAll('meta[itemprop="channelId"], meta[itemprop="identifier"]')) {
      const v = m.getAttribute("content") || "";
      if (/^UC[\w-]{22}$/.test(v)) keys.add(v);
    }
    // The channel header itself carries the other format (a /channel/UC… page
    // shows the @handle and vice versa) — scoped to the header so featured
    // channels elsewhere on the page can't leak in.
    for (const header of document.querySelectorAll(CHANNEL_HEADER_SEL)) {
      for (const a of header.querySelectorAll('a[href^="/@"], a[href^="/channel/UC"]')) {
        const key = normalizeChannelKey(a.getAttribute("href") || "");
        if (key) keys.add(key);
      }
    }
    return keys;
  }

  // Info about whatever video/channel(s) the user is currently looking at —
  // used both by the popup's quick-block buttons and by the direct-navigation
  // safety-net redirect below. A video can have multiple channels attached via
  // YouTube's channel-collaboration feature, so this always returns an array.
  // `withAliases` is for the block CHECK only (see checkCurrentPageAndRedirect):
  // it adds the page's other identity formats so a block matches however the
  // user navigated here. The popup must NOT pass it — it renders one button per
  // returned channel, and the aliases are the same channel twice.
  function getCurrentPageTarget(withAliases) {
    const pathKey = normalizeChannelKey(location.pathname);
    const legacyChannelPage = /^\/(?:c|user)\//.test(location.pathname);
    if (pathKey || legacyChannelPage) {
      const name = document.title.replace(/ - YouTube$/, "").trim();
      const keys = new Map();
      if (pathKey) keys.set(pathKey, name);
      // The URL carries only ONE of the two identities a channel has, and the
      // blocklist may be keyed by the other (a @handle-keyed entry vs. a
      // /channel/UC… URL, or a legacy /c/… // /user/… URL that names neither).
      // The page's own canonical metadata resolves the rest, so a block sticks
      // whichever form the user arrives by.
      if (withAliases || !pathKey) {
        for (const key of pageIdentityKeys()) if (!keys.has(key)) keys.set(key, name);
      }
      return {
        videoId: null,
        videoTitle: "",
        channels: Array.from(keys, ([key, n]) => ({ key, name: n }))
      };
    }

    let videoId = null;
    let videoTitle = "";
    const vm =
      (location.pathname + location.search).match(VIDEO_ID_FROM_QUERY_RE) ||
      location.pathname.match(VIDEO_ID_FROM_SHORTS_RE) ||
      location.pathname.match(VIDEO_ID_FROM_PATH_RE);
    if (vm) {
      videoId = vm[1];
      videoTitle = document.title.replace(/ - YouTube$/, "").trim();
    }

    const scope = findScopeForCurrentPage();
    // For the block CHECK, collect from the whole scope: the more identity
    // formats we see, the more likely one matches however the entry is keyed.
    // For the POPUP, narrow to the owner byline first — confirmed live that a
    // watch page's wider metadata also carries /channel/UC… links from the
    // *description*, which are the same channel in its other format. Harmless
    // for the check, but the popup renders one button per entry and would
    // offer to block the same channel twice. The byline still lists every
    // collaborator, so genuine multi-channel videos keep a row each.
    let collectFrom = scope;
    if (!withAliases && scope && scope.querySelector) {
      const owner = scope.querySelector(OWNER_BYLINE_SEL);
      if (owner && owner.querySelector(CHANNEL_LINK_SEL)) collectFrom = owner;
    }
    const channels = collectFrom ? Array.from(collectChannels(collectFrom), ([key, name]) => ({ key, name })) : [];

    return { videoId, videoTitle, channels };
  }

  // Safety net for direct/fresh navigation straight to a video or playlist
  // page: declarativeNetRequest (background.js) only knows exact blocked
  // video IDs and exact blocked channel *page* URLs — it has no way to know
  // "this video's uploader/collaborator is blocked" or "this playlist belongs
  // to a blocked channel", since neither URL shape carries that information.
  // This runs after the page has actually rendered its own metadata.
  // We are standing ON the offending page here, so `replace()` — not an
  // assignment to location.href — is what keeps it out of session history.
  // With a plain push, Back lands on the blocked page again, and (now that
  // this check re-runs on a timer) bounces forward, leaving Back apparently
  // broken. `bounced` stops a slow redirect from being fired repeatedly by
  // the heartbeat while the new page is still loading.
  let bounced = false;
  function bounce() {
    if (bounced) return;
    bounced = true;
    window.location.replace(SAFE_LANDING_URL);
  }

  function checkCurrentPageAndRedirect() {
    // Home and Shorts as destinations — gone entirely when their toggle is on,
    // regardless of the blocklist; sent straight to Subscriptions.
    const path = location.pathname;
    if (settings.redirectHomepage && path === "/") {
      bounce();
      return;
    }
    if (settings.shortsPlayer && (path === "/shorts" || path.startsWith("/shorts/"))) {
      bounce();
      return;
    }

    if (!blocklistLoaded) return;
    const target = getCurrentPageTarget(true);
    if (target.channels.some((c) => isAllowlisted(c.key))) return; // allow-list wins
    const ageDays = anyAgeRule && target.videoId ? currentPageAgeDays() : null;
    const blocked =
      (target.videoId && blockedVideoIds.has(target.videoId)) ||
      matchesFilter(target) ||
      target.channels.some((c) => channelBlocks(blockedEntryFor(c.key), target.videoId, ageDays));
    if (blocked) {
      dbg("bouncing off blocked page:", location.pathname, target.channels.map((c) => c.key).join(","));
      bounce();
      return;
    }
    // A player with no readable channel byline — /embed/<id> is the case that
    // matters, since nothing on that page names the uploader. Ask the
    // background to resolve it (cached, one request per unseen video) rather
    // than letting a blocked channel through on a URL shape we can't parse.
    if (target.videoId && !target.channels.length && blockedChannels.size) {
      resolveChannelForVideo(target.videoId);
    }
  }

  // One in-flight/settled request per video id — checkCurrentPageAndRedirect()
  // re-runs on a timer, and this must not re-fetch on every tick.
  const videoChannelAsked = new Map(); // videoId -> channel key | null
  function resolveChannelForVideo(videoId) {
    if (videoChannelAsked.has(videoId)) return;
    videoChannelAsked.set(videoId, null);
    chrome.runtime.sendMessage({ type: MSG.RESOLVE_VIDEO_CHANNEL, videoId }, (res) => {
      if (chrome.runtime.lastError || !res || !res.channelKey) return;
      videoChannelAsked.set(videoId, res.channelKey);
      // The page may have moved on while we were waiting.
      const still =
        (location.pathname + location.search).match(VIDEO_ID_FROM_QUERY_RE) ||
        location.pathname.match(VIDEO_ID_FROM_SHORTS_RE) ||
        location.pathname.match(VIDEO_ID_FROM_PATH_RE);
      if (!still || still[1] !== videoId) return;
      if (channelBlocks(blockedEntryFor(res.channelKey), videoId, null)) {
        dbg("bouncing off blocked page (channel resolved via oEmbed):", res.channelKey);
        bounce();
      }
    });
  }

  // A small transient banner, used by the right-click block to confirm what it
  // did — the tile you blocked is often not the one you right-clicked, and may
  // be off-screen entirely. Inline styles and a unique tag name so no YouTube
  // stylesheet (or ours) can affect it, and so it can't match any of our own
  // scrub selectors.
  let toastEl = null;
  let toastTimer = 0;
  function showToast(text) {
    if (!text || !document.body) return;
    if (!toastEl) {
      toastEl = document.createElement("bt-toast");
      toastEl.style.cssText = [
        "position:fixed",
        "left:50%",
        "bottom:28px",
        "transform:translateX(-50%)",
        "z-index:2147483647",
        "max-width:min(90vw,420px)",
        "padding:10px 16px",
        "border-radius:10px",
        "background:rgba(20,20,20,0.94)",
        "color:#fff",
        "font:500 13px/1.4 system-ui,-apple-system,'Segoe UI',Roboto,sans-serif",
        "box-shadow:0 4px 18px rgba(0,0,0,0.35)",
        "pointer-events:none",
        "opacity:0",
        "transition:opacity .15s ease"
      ].join(";");
      document.body.appendChild(toastEl);
    }
    toastEl.textContent = text;
    // re-append so it stays on top of anything YouTube added since
    document.body.appendChild(toastEl);
    requestAnimationFrame(() => {
      if (toastEl) toastEl.style.opacity = "1";
    });
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      if (!toastEl) return;
      toastEl.style.opacity = "0";
      setTimeout(() => {
        if (toastEl && toastEl.parentNode) toastEl.remove();
        toastEl = null;
      }, 250);
    }, 2600);
  }

  // Best-effort age of the video on the current watch page, for the age-rule
  // nav guard. Tries YouTube's relative text first, then an English absolute
  // date ("Jan 5, 2024" / "Premiered Jan 5, 2024"). null if neither is found —
  // callers treat that as "recent" (fail open), same as feed tiles.
  // How old is the video on THIS page? Only consulted for a channel with an
  // "block videos older than N days" rule, and a wrong answer here is a false
  // bounce off a video the user is entitled to watch.
  //
  // Read the machine-readable date first. `<meta itemprop="datePublished">` is
  // exact, ISO-8601 and locale-proof — the visible line says "16 Sept 2026" in
  // en-GB and something else again in every other UI language, and the absolute
  // -date fallback below only ever understood the US "Sep 16, 2026" spelling.
  //
  // **Never scan `document.body`.** That was the old fallback whenever the
  // watch metadata had not mounted yet, and `document.body.textContent`
  // *includes the contents of `<script>` tags*: on a watch page that is ~807KB
  // of YouTube's inline JSON against ~36KB of real text. Something in that JSON
  // always matches "<number> <unit> ago", so the page's age came back as
  // **5.1e26 days** — greater than any threshold, so an age-ruled channel
  // blocked *every* video including one published 18 hours ago. Confirmed live.
  // An unknown age must read as unknown (null → channelBlocks does not block);
  // the 2s heartbeat re-checks once the real metadata mounts.
  const AGE_SCOPE_SELECTORS = [
    "ytd-watch-info-text", // the "N views • <date>" line itself
    "#info-container",
    "ytd-watch-metadata",
    "#above-the-fold"
  ];
  function currentPageAgeDays() {
    const meta = document.querySelector(
      'meta[itemprop="datePublished"], meta[itemprop="uploadDate"]'
    );
    if (meta && meta.content) {
      const t = Date.parse(meta.content);
      if (!Number.isNaN(t)) {
        const days = (Date.now() - t) / 86400000;
        if (plausibleAgeDays(days)) return days;
      }
    }
    for (const sel of AGE_SCOPE_SELECTORS) {
      const el = document.querySelector(sel);
      const text = el ? el.textContent || "" : "";
      if (!text.trim()) continue;
      const rel = parseAgeDays(text);
      if (plausibleAgeDays(rel)) return rel;
      const abs = text.match(/([A-Z][a-z]{2,8}\s+\d{1,2},\s+\d{4})/);
      if (abs) {
        const t = Date.parse(abs[1]);
        if (!Number.isNaN(t)) {
          const days = (Date.now() - t) / 86400000;
          if (plausibleAgeDays(days)) return days;
        }
      }
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
      document.querySelectorAll(POST_SELECTOR).forEach((el) => delete el.dataset.btPost);
      document.querySelectorAll("[data-bt-comment]").forEach((el) => delete el.dataset.btComment);
      sweep(document.documentElement);
      scrubComments(document.documentElement);
      scrubOwnChannelPage(document.documentElement);
      // Blocking a channel while you're sitting on its video should take you
      // off that page, not just scrub the tiles around it.
      checkCurrentPageAndRedirect();
    } else if (msg.type === MSG.GET_PAGE_TARGET) {
      sendResponse(getCurrentPageTarget());
    } else if (msg.type === MSG.SHOW_TOAST) {
      showToast(msg.text);
    }
    return true;
  });

  // ---------- bounce out of blocked videos/channels reached via in-app (SPA) nav ----------
  // declarativeNetRequest (background.js) handles fresh/typed/external navigation.
  // YouTube's own client-side routing doesn't trigger a new network request, so we
  // intercept its "yt-navigate-start" event and bail out before the blocked page renders.
  // NOTE on history: these fire BEFORE the blocked page becomes the current
  // entry, so the current entry is still the innocent page the user is leaving.
  // They therefore use a normal (pushing) assignment — `location.replace()`
  // here would erase that referring page from history instead of the blocked
  // one, and Back would skip past where the user actually came from. The
  // blocked URL never enters history at all, which is the point.
  // checkCurrentPageAndRedirect()'s bounce() is the opposite case and must
  // replace; see the comment there.
  window.addEventListener("yt-navigate-start", (e) => {
    const endpoint = e.detail?.endpoint;
    const webUrl = endpoint?.commandMetadata?.webCommandMetadata?.url || "";

    // Shorts — bail before the player even mounts (toggle-gated).
    if (settings.shortsPlayer && (endpoint?.reelWatchEndpoint || webUrl.startsWith("/shorts"))) {
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
    // A soft navigation is a new page view: whatever we bounced off before is
    // no longer what's on screen, and the suppressed-tile tally starts over.
    bounced = false;
    resetPageSuppressed();
    runExtras(); // the scrub batch + checkCurrentPageAndRedirect()
  });

  // Back/Forward. A page restored from the back/forward cache does NOT re-run
  // this script and fires no yt-navigate-* event, so without these a blocked
  // page reached via Back would simply sit there. `bounced` is cleared first:
  // this is a different page view than the one we already bounced out of.
  window.addEventListener("pageshow", (e) => {
    if (e.persisted) {
      bounced = false;
      checkCurrentPageAndRedirect();
    }
  });
  window.addEventListener("popstate", () => {
    bounced = false;
    resetPageSuppressed();
    scheduleExtrasScrub();
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
