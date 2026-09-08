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
self.BlockTube.DEFAULT_SETTINGS = {
  removeShorts: true, // shelves, tiles, the full-screen player, /shorts redirects
  redirectHomepage: true, // youtube.com/ -> Subscriptions (network + SPA)
  logoToSubscriptions: true, // the masthead YouTube logo points at Subscriptions
  cleanSidebar: true, // guide: Home/Shorts/Explore/More from YouTube/Report history + footer
  cleanMasthead: true, // the Create (+) and Notifications buttons
  removeRelated: true, // the "up next" #secondary column on watch pages (+ reflow)
  removeEndScreen: true, // end-of-video suggestion grid + in-player teaser cards
  hideVoiceSearch: true, // the "Search with your voice" mic button in the masthead
  accountButtonOnHover: true, // account avatar button hidden until the top-right is hovered
  hideVideoActions: true, // Share / Save / Download / Clip / "..." (More, incl. Report) under a video
  hideMemberships: true, // the "Join" button + members-only videos/shelves + the channel Membership tab
  hideSearchSuggestions: true // the autocomplete dropdown under the search box
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
