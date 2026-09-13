// Shared across background, content script, popup, and options.
// Loaded as a plain classic script everywhere, so it just hangs things off `self`.
self.BlockTube = self.BlockTube || {};

self.BlockTube.MSG = {
  BLOCK_CHANNEL: "BLOCK_CHANNEL",
  BLOCK_VIDEO: "BLOCK_VIDEO",
  UNBLOCK_CHANNEL: "UNBLOCK_CHANNEL",
  UNBLOCK_VIDEO: "UNBLOCK_VIDEO",
  GET_BLOCKLIST: "GET_BLOCKLIST",
  BLOCKLIST_UPDATED: "BLOCKLIST_UPDATED",
  IMPORT_BLOCKLIST: "IMPORT_BLOCKLIST",
  CLEAR_BLOCKED_VIDEOS: "CLEAR_BLOCKED_VIDEOS", // wipe every blocked video in one bulk write
  GET_PAGE_TARGET: "GET_PAGE_TARGET",
  // A blocked channel can be in one of two modes (BlockTube.CHANNEL_MODE
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
  // Enrich a batch of channels in one round-trip: fetch each channel page
  // concurrently in the worker, then write all results with a single storage
  // write (per-channel FETCH_CHANNEL_SUBS was one sync/local write each — the
  // real bottleneck on a big list). Also captures @handle + display name.
  BULK_FETCH_CHANNEL_INFO: "BULK_FETCH_CHANNEL_INFO",
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
  GET_RECENT_UNBLOCKS: "GET_RECENT_UNBLOCKS",
  RESTORE_UNBLOCK: "RESTORE_UNBLOCK",
  CLEAR_RECENT_UNBLOCKS: "CLEAR_RECENT_UNBLOCKS",
  // Cross-browser blocklist sync via a private GitHub Gist (see
  // background/gist-sync.js). The options page owns the UI; background.js owns
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
self.BlockTube.CHANNEL_MODE = {
  FULL: "full",
  EXCEPT_WHITELIST: "exceptWhitelist"
};

// chrome.storage.sync hard limits: QUOTA_BYTES = 102400, QUOTA_BYTES_PER_ITEM = 8192,
// MAX_ITEMS = 512. We chunk each list into multiple keys so no single item ever
// gets close to the per-item cap, and we track how many items exist so we know
// when we're approaching MAX_ITEMS and must spill into local-only storage.
self.BlockTube.STORAGE = {
  CHUNK_SIZE: 50, // entries per sync storage chunk, kept well under 8KB/item
  MAX_SYNC_ITEMS: 480, // stay under the 512 hard cap with headroom for meta keys
  META_KEY: "bt_meta",
  CHANNEL_CHUNK_PREFIX: "bt_ch_",
  VIDEO_CHUNK_PREFIX: "bt_vid_",
  LOCAL_OVERFLOW_KEY: "bt_overflow",
  // chrome.storage.local. Tombstones record deletions so the gist merge doesn't
  // resurrect an entry another device already unblocked: { "channel:<key>" |
  // "video:<id>": <deletedAtMs> }. Pruned once older than TOMBSTONE_TTL_MS.
  TOMBSTONE_KEY: "bt_tombstones",
  TOMBSTONE_TTL_MS: 30 * 24 * 60 * 60 * 1000,
  // chrome.storage.local. The gist-sync record — GitHub token, gist id, last
  // seen version, timestamps, last error, and the device's clock offset vs.
  // GitHub. Deliberately in local (not sync) storage: the token must not ride
  // chrome.storage.sync to other browsers.
  SYNC_KEY: "bt_sync"
};

// Feature toggles for the always-on, non-blocklist behaviours. Stored as one
// small object in chrome.storage.sync under SETTINGS_KEY. All default true, so
// an install with nothing saved behaves exactly as it did before toggles
// existed. The options page edits these; content.js reads them (and
// background.js reads redirectHomepage / removeShorts when building DNR rules).
self.BlockTube.SETTINGS_KEY = "bt_settings";
// chrome.storage.sync. { list: [{ p: <pattern>, re: <bool: treat as regex> }],
// ts: <ms> }. A video whose title matches any pattern is scrubbed (JS only —
// CSS can't match text). ts drives last-write-wins in the gist merge.
self.BlockTube.KEYWORDS_KEY = "bt_keywords";
// chrome.storage.sync. { list: { [channelKey]: { note?, ts } }, ts: <ms> } —
// channels that must never be hidden, whatever else matches. `ts` drives
// last-write-wins in the gist merge (same scheme as KEYWORDS_KEY).
self.BlockTube.ALLOWLIST_KEY = "bt_allowlist";
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
self.BlockTube.SETTING_GROUPS = [
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
    id: "watch",
    label: "Watch page",
    desc: "The page a video plays on.",
    items: [
      { key: "removeRelated", label: "Related videos column", desc: "Removes the \u201cup next\u201d column and widens the video into the space." },
      { key: "removeEndScreen", label: "End-screen suggestions", desc: "The grid of videos over the player at the end, plus in-player cards." },
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
self.BlockTube.DEFAULT_SETTINGS = {};
for (const g of self.BlockTube.SETTING_GROUPS) {
  for (const it of g.items) self.BlockTube.DEFAULT_SETTINGS[it.key] = it.default !== false;
}

// Settings written by an older version used one coarse key per surface. Map
// each to the leaves that replaced it so an upgrade keeps the user's choices
// instead of silently switching removed features back on. Applied on read, and
// only where the user had explicitly turned something OFF.
self.BlockTube.LEGACY_SETTING_MAP = {
  removeShorts: ["shortsFeedTiles", "shortsPlayer", "shortsChannelTab"],
  cleanSidebar: ["sidebarHome", "sidebarShorts", "sidebarExplore", "sidebarMoreFromYouTube", "sidebarReportHistory", "sidebarFooter"],
  cleanMasthead: ["mastheadCreate", "mastheadNotifications"],
  hideVideoActions: ["actionShare", "actionSave", "actionDownload", "actionClip", "actionThanks", "actionMore"],
  hideMemberships: ["joinButton", "membershipPrices", "membersOnlyTiles", "membershipTab"],
  cleanChannelTabs: ["tabPosts", "tabShows", "tabPodcasts", "tabStore", "shortsChannelTab"]
};

// Merge stored settings over the defaults, expanding any legacy coarse keys.
self.BlockTube.resolveSettings = function (stored) {
  const out = { ...self.BlockTube.DEFAULT_SETTINGS };
  const s = stored || {};
  for (const [legacy, leaves] of Object.entries(self.BlockTube.LEGACY_SETTING_MAP)) {
    if (s[legacy] === false) for (const k of leaves) out[k] = false;
  }
  for (const [k, v] of Object.entries(s)) {
    if (k in out) out[k] = v !== false;
  }
  return out;
};

// GitHub Gist sync (background/gist-sync.js).
self.BlockTube.SYNC = {
  GIST_FILENAME: "blocktube-blocklist.json",
  GIST_DESCRIPTION: "BlockTube blocklist sync — managed by the extension, do not hand-edit",
  SCHEMA_VERSION: 1,
  POLL_ALARM: "bt-sync-poll",
  POLL_PERIOD_MIN: 3, // how often each device pulls (no realtime channel)
  PUSH_DEBOUNCE_MS: 4000 // coalesce a burst of local edits into one push
};
