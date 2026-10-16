// Shared across background, content script, popup, and options.
// Loaded as a plain classic script everywhere, so it just hangs things off `self`.
self.XrnTube = self.XrnTube || {};

self.XrnTube.MSG = {
  BLOCK_CHANNEL: "BLOCK_CHANNEL",
  BLOCK_VIDEO: "BLOCK_VIDEO",
  UNBLOCK_CHANNEL: "UNBLOCK_CHANNEL",
  UNBLOCK_VIDEO: "UNBLOCK_VIDEO",
  GET_BLOCKLIST: "GET_BLOCKLIST",
  BLOCKLIST_UPDATED: "BLOCKLIST_UPDATED",
  IMPORT_BLOCKLIST: "IMPORT_BLOCKLIST",
  GET_PAGE_TARGET: "GET_PAGE_TARGET",
  // A blocked channel can be in one of two modes (XrnTube.CHANNEL_MODE
  // below): SET_CHANNEL_MODE flips an already-blocked channel between them,
  // and WHITELIST/UNWHITELIST manage the "let these specific videos through"
  // exception list used by the softer mode.
  SET_CHANNEL_MODE: "SET_CHANNEL_MODE",
  WHITELIST_CHANNEL_VIDEO: "WHITELIST_CHANNEL_VIDEO",
  UNWHITELIST_CHANNEL_VIDEO: "UNWHITELIST_CHANNEL_VIDEO",
  // SET_ENTRY_HIDDEN toggles an entry's `hidden` flag — a pure options-UI
  // convenience (the entry stays fully blocked, it's just filtered out of the
  // blocklist manager). SET_CHANNEL_AGE_RULE sets `blockOlderThanDays` on an
  // EXCEPT_WHITELIST channel (0 = off). FETCH_CHANNEL_SUBS scrapes the
  // channel's public subscriber count and caches it on the entry.
  SET_ENTRY_HIDDEN: "SET_ENTRY_HIDDEN",
  SET_CHANNEL_AGE_RULE: "SET_CHANNEL_AGE_RULE",
  FETCH_CHANNEL_SUBS: "FETCH_CHANNEL_SUBS",
  // Look a few channels up and wait for the answer (one storage write for the
  // lot). Also captures @handle + display name.
  BULK_FETCH_CHANNEL_INFO: "BULK_FETCH_CHANNEL_INFO",
  // The sweep: queue channels for lookup in the background, where it keeps
  // going after the options page closes and pauses itself when YouTube
  // throttles. Progress lives in chrome.storage.local under `bt_sweep`.
  START_SWEEP: "START_SWEEP",
  STOP_SWEEP: "STOP_SWEEP",
  GET_SWEEP: "GET_SWEEP",
  // Push the current blocklist to every open YouTube tab once (after a bulk
  // enrich, so tabs pick up the freshly-scraped @handles without a reload —
  // the enrich messages skip the per-write broadcast for speed).
  REBROADCAST_BLOCKLIST: "REBROADCAST_BLOCKLIST",
  // Asks the background which channel a video belongs to, for the pages that
  // render a player but no channel byline the content script can read — most
  // notably /embed/<id>. Answered from YouTube's public oEmbed endpoint and
  // cached, so it costs one small request per unseen video, and only on those
  // pages (a normal watch page reads the byline from the DOM instead).
  RESOLVE_VIDEO_CHANNEL: "RESOLVE_VIDEO_CHANNEL",
  // Background -> content script: show a short transient banner on the page.
  // The right-click block has no other way to confirm it worked (the thing you
  // blocked may be off-screen), and this keeps us off the `notifications`
  // permission, which would be a new install-time prompt for a one-line message.
  SHOW_TOAST: "SHOW_TOAST",
  // "Recently unblocked" undo log (chrome.storage.local, not synced).
  // RESTORE_UNBLOCK takes `ts` (the record's own stamp, returned by every
  // removal) or a log `index`; `ts` is what an Undo toast uses, since the
  // index of a record shifts as soon as anything else is removed.
  GET_RECENT_UNBLOCKS: "GET_RECENT_UNBLOCKS",
  RESTORE_UNBLOCK: "RESTORE_UNBLOCK",
  CLEAR_RECENT_UNBLOCKS: "CLEAR_RECENT_UNBLOCKS",
  // Remove many things in ONE storage write and ONE undo record:
  // { channels: [ids] | "all", videos: [ids] | "all", keywords: bool,
  //   allowlist: bool }. Per-entry UNBLOCK_* is one loadAll + write + DNR
  // rebuild each, which is unusable for "delete all" on a 5,000-entry list.
  DELETE_DATA: "DELETE_DATA",
  // Blocklist sync through your own server (see background/server-sync.js
  // and server/xrntube-sync.py). The options page owns the UI; background.js owns
  // the token and runs the push/pull/merge cycle.
  GET_SYNC_STATUS: "GET_SYNC_STATUS",
  SET_SYNC_CONFIG: "SET_SYNC_CONFIG",
  SYNC_NOW: "SYNC_NOW",
  // Channel allow-list ("never block these"): a hard override that wins over
  // every block path — a collaborator block, a title-keyword / duration
  // filter, an age rule. ALLOW_CHANNEL adds a key ("UC…" or "@handle"),
  // DISALLOW_CHANNEL removes it. Stored in chrome.storage.sync under
  // ALLOWLIST_KEY and carried in the GET_BLOCKLIST / BLOCKLIST_UPDATED payload.
  ALLOW_CHANNEL: "ALLOW_CHANNEL",
  DISALLOW_CHANNEL: "DISALLOW_CHANNEL"
};

// FULL: nothing from this channel exists anymore — its own page, videos, and
// playlists are all redirected/removed.
// EXCEPT_WHITELIST: the channel's own page stays reachable, but its videos are
// blocked except the ones listed in the entry's `whitelist` map (keyed by
// video ID). If the entry also has `blockOlderThanDays > 0`, only videos
// published more than that many days ago are blocked — recent uploads pass
// (and whitelisted IDs always pass). Defaults to FULL when a channel entry
// predates the `mode` field, so old blocklists keep behaving exactly as before.
// Where blocked content — and Home / Shorts, when those toggles are on — get
// sent instead. Lives here because background.js redirects to it at the
// network layer (DNR) and content.js redirects to it from the page, and the
// two must not drift; it used to be declared separately in both.
self.XrnTube.SAFE_LANDING_URL = "https://www.youtube.com/feed/subscriptions";

self.XrnTube.CHANNEL_MODE = {
  FULL: "full",
  EXCEPT_WHITELIST: "exceptWhitelist"
};

self.XrnTube.STORAGE = {
  // chrome.storage.local. { channels: { <key>: entry }, videos: { <id>: entry } }
  // — the whole blocklist, one key (see background.js → the blocklist store).
  BLOCKLIST_KEY: "bt_blocklist",
  // chrome.storage.local. Tombstones record deletions so the sync merge doesn't
  // resurrect an entry another device already unblocked: { "channel:<key>" |
  // "video:<id>": <deletedAtMs> }. Pruned once older than TOMBSTONE_TTL_MS.
  TOMBSTONE_KEY: "bt_tombstones",
  TOMBSTONE_TTL_MS: 30 * 24 * 60 * 60 * 1000,
  // chrome.storage.local. The sync record — server address, user name and
  // password, last seen version, timestamps, last error, and the device's
  // clock offset vs. the server. Deliberately in local (not sync) storage: the
  // password must not ride chrome.storage.sync to other browsers.
  SYNC_KEY: "bt_sync"
};

// Feature toggles for the always-on, non-blocklist behaviours. Stored as one
// small object in chrome.storage.sync under SETTINGS_KEY. All default true, so
// an install with nothing saved behaves exactly as it did before toggles
// existed. The options page edits these; content.js reads them (and
// background.js reads redirectHomepage / removeShorts when building DNR rules).
self.XrnTube.SETTINGS_KEY = "bt_settings";

// Which generation of the channel scrape produced an entry's `subs`. Bumped
// when the scrape starts reading a *different, better* place, so entries whose
// number came from the old one are re-fetched exactly once and then left alone
// forever (see subsAttempted() in options.js).
//   1 — the first sub count in the document. It was often another channel's:
//       a channel page embeds shelves of other people's videos and channel
//       cards, and the page's own header sits past where the reader stopped.
//   2 — the channel's own `pageHeaderRenderer`, off its search tab.
self.XrnTube.SUBS_SCRAPE_VERSION = 2;
// chrome.storage.sync. { list: [{ p: <pattern>, re: <bool: treat as regex> }],
// ts: <ms> }. A video whose title matches any pattern is scrubbed (JS only —
// CSS can't match text). ts drives last-write-wins in the sync merge.
self.XrnTube.KEYWORDS_KEY = "bt_keywords";
// chrome.storage.sync. { list: { [channelKey]: { note?, ts } }, ts: <ms> } —
// channels that must never be hidden, whatever else matches. `ts` drives
// last-write-wins in the sync merge (same scheme as KEYWORDS_KEY).
self.XrnTube.ALLOWLIST_KEY = "bt_allowlist";
// ---------------------------------------------------------------------------
// Feature toggles.
//
// Two levels, and only the LEAVES are stored: each leaf is one thing the
// extension removes from YouTube, and a group is just a heading with a
// "toggle everything here" master in the UI. The master is computed from its
// leaves, never persisted — an independent parent flag would create the
// contradiction of a group switched off while a child inside it reads "on",
// and every consumer would then have to remember to AND the two together.
//
// Adding a leaf: add it here, gate the code on it via `on(key)` in content.js,
// and it appears in the options UI automatically.
self.XrnTube.SETTING_GROUPS = [
  {
    id: "shorts",
    label: "Shorts",
    desc: "YouTube's short-form feed.",
    items: [
      { key: "shortsFeedTiles", label: "Shorts shelves and tiles", desc: "In the home feed, search results and sidebars." },
      { key: "shortsPlayer", label: "The full-screen Shorts player", desc: "Opening a /shorts/ link sends you to Subscriptions instead." },
      { key: "shortsChannelTab", label: "The Shorts tab on channels", desc: "The per-channel Shorts tab." }
    ]
  },
  {
    id: "nav",
    label: "Home page and navigation",
    desc: "Where YouTube sends you by default.",
    items: [
      { key: "redirectHomepage", label: "Skip the home feed", desc: "youtube.com opens your Subscriptions instead of recommendations." },
      { key: "logoToSubscriptions", label: "Point the logo at Subscriptions", desc: "The YouTube logo in the top bar goes to Subscriptions." }
    ]
  },
  {
    id: "sidebar",
    label: "Left sidebar",
    desc: "Entries in the guide. Subscriptions and Library always stay.",
    items: [
      { key: "sidebarHome", label: "Home", desc: "" },
      { key: "sidebarShorts", label: "Shorts", desc: "" },
      { key: "sidebarExplore", label: "Explore", desc: "" },
      { key: "sidebarMoreFromYouTube", label: "More from YouTube", desc: "" },
      { key: "sidebarReportHistory", label: "Report history", desc: "" },
      { key: "sidebarFooter", label: "The small-print footer", desc: "About, Press, Copyright, Terms, and the rest." }
    ]
  },
  {
    id: "masthead",
    label: "Top bar",
    desc: "The bar across the top of every page.",
    items: [
      { key: "mastheadCreate", label: "Create (+) button", desc: "" },
      { key: "mastheadNotifications", label: "Notifications bell", desc: "" },
      { key: "hideVoiceSearch", label: "Voice search microphone", desc: "" },
      { key: "hideSearchSuggestions", label: "Search autocomplete", desc: "The suggestions dropdown under the search box." },
      { key: "accountButtonOnHover", label: "Account avatar until hovered", desc: "Fades the avatar in only when you move to the top-right." }
    ]
  },
  {
    id: "ai",
    label: "AI features",
    desc: "YouTube's generative-AI surfaces.",
    items: [
      { key: "hideAskYouTube", label: "\u201cAsk\u201d buttons and panels", desc: "The AI chat button beside the search box, and the matching \u201cAsk\u201d section under a video's description." },
      { key: "hideVideoSummaries", label: "AI video summaries", desc: "The collapsible \u201cSummary\u201d card YouTube folds into a search result, above the video's own description." },
      { key: "hideAutoChapters", label: "Auto-generated chapters", desc: "The chapters YouTube makes up for a video whose creator didn't add any \u2014 the marks on the progress bar, the chapter name beside the timer, and the Chapters list. Chapters the creator wrote stay." }
    ]
  },
  {
    id: "watch",
    label: "Watch page",
    desc: "The page a video plays on.",
    items: [
      { key: "removeRelated", label: "Related videos column", desc: "Removes the \u201cup next\u201d column and widens the video into the space." },
      { key: "removeEndScreen", label: "End-screen suggestions", desc: "The grid of videos over the player at the end, plus in-player cards." },
      { key: "descriptionInfocards", label: "Channel card in the description", desc: "The creator's avatar, subscriber count, Videos/About buttons and outbound social links, shown under a video's description." },
      { key: "commentsTwoColumn", label: "Comments in two columns", desc: "Lays the comment list out in two columns instead of one, so more fits on screen." },
      { key: "pipButton", label: "Picture-in-picture button", desc: "Adds YouTube's own (normally hidden) pop-out button to the player: the video floats in a small window that stays on top while you use other tabs and apps." },
      { key: "actionShare", label: "Share button", desc: "" },
      { key: "actionSave", label: "Save button", desc: "" },
      { key: "actionDownload", label: "Download button", desc: "" },
      { key: "actionClip", label: "Clip button", desc: "" },
      { key: "actionThanks", label: "Thanks button", desc: "" },
      { key: "actionMore", label: "More actions (\u2026)", desc: "The overflow menu, which is what puts Report out of reach." }
    ]
  },
  {
    id: "channel",
    label: "Channel page",
    desc: "A channel's own page. Home, Videos, Live, Playlists and Search always stay.",
    items: [
      { key: "joinButton", label: "Join button", desc: "The channel-membership button in the header." },
      { key: "membershipPrices", label: "Membership price offers", desc: "The \u201c$0 for 1st month, then $7.49/mo\u201d line beside Join." },
      { key: "membersOnlyTiles", label: "Members-only videos", desc: "Tiles and shelves you cannot watch without paying." },
      { key: "membershipTab", label: "Membership tab", desc: "" },
      { key: "tabPosts", label: "Posts (Community) tab", desc: "" },
      { key: "tabShows", label: "Shows tab", desc: "" },
      { key: "tabPodcasts", label: "Podcasts tab", desc: "" },
      { key: "tabStore", label: "Store tab", desc: "" }
    ]
  },
  {
    id: "embeds",
    label: "Embeds on other sites",
    desc: "YouTube players embedded in pages elsewhere on the web.",
    items: [
      {
        key: "blockInEmbeds",
        // The only leaf that starts OFF. Everything else here changes
        // youtube.com, which you opened deliberately; this one reaches into
        // every other site you visit, so it has to be a choice you make rather
        // than one you discover.
        default: false,
        label: "Block embedded videos too",
        desc: "Blank a blocked channel's video when it's embedded in someone else's page. Off by default — this is the only setting that affects sites other than YouTube."
      }
    ]
  }
];

// Flat { key: bool } derived from the tree — the stored shape. Everything
// defaults on except a leaf that opts out with `default: false`.
self.XrnTube.DEFAULT_SETTINGS = {};
for (const g of self.XrnTube.SETTING_GROUPS) {
  for (const it of g.items) self.XrnTube.DEFAULT_SETTINGS[it.key] = it.default !== false;
}

// Settings written by an older version used one coarse key per surface. Map
// each to the leaves that replaced it so an upgrade keeps the user's choices
// instead of silently switching removed features back on. Applied on read, and
// only where the user had explicitly turned something OFF.
self.XrnTube.LEGACY_SETTING_MAP = {
  removeShorts: ["shortsFeedTiles", "shortsPlayer", "shortsChannelTab"],
  cleanSidebar: ["sidebarHome", "sidebarShorts", "sidebarExplore", "sidebarMoreFromYouTube", "sidebarReportHistory", "sidebarFooter"],
  cleanMasthead: ["mastheadCreate", "mastheadNotifications"],
  hideVideoActions: ["actionShare", "actionSave", "actionDownload", "actionClip", "actionThanks", "actionMore"],
  hideMemberships: ["joinButton", "membershipPrices", "membersOnlyTiles", "membershipTab"],
  cleanChannelTabs: ["tabPosts", "tabShows", "tabPodcasts", "tabStore", "shortsChannelTab"]
};

// Merge stored settings over the defaults, expanding any legacy coarse keys.
self.XrnTube.resolveSettings = function (stored) {
  const out = { ...self.XrnTube.DEFAULT_SETTINGS };
  const s = stored || {};
  for (const [legacy, leaves] of Object.entries(self.XrnTube.LEGACY_SETTING_MAP)) {
    if (s[legacy] === false) for (const k of leaves) out[k] = false;
  }
  for (const [k, v] of Object.entries(s)) {
    if (k in out) out[k] = v !== false;
  }
  return out;
};

// Sync through your own server (background/server-sync.js).
self.XrnTube.SYNC = {
  SCHEMA_VERSION: 1,
  POLL_ALARM: "bt-sync-poll",
  POLL_PERIOD_MIN: 3, // how often each device pulls (no realtime channel)
  PUSH_DEBOUNCE_MS: 4000 // coalesce a burst of local edits into one push
};
