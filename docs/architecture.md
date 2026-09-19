# Architecture

How the four contexts fit together and what each one owns.

Four contexts talk to each other exclusively through `chrome.runtime`
messages defined in `shared/constants.js` (`BlockTube.MSG`) — there is no
shared module system, so this file is the map of what messages exist and
must be loaded via `<script>`/`importScripts` before any file that uses
`self.BlockTube`.

The background context is split across two files. On Chrome, `background.js`
is the service worker and pulls the other two in with
`importScripts("../shared/constants.js", "./gist-sync.js")`. On Firefox
(where MV3 background service workers don't run and `importScripts` doesn't
exist), `manifest.json`'s `background.scripts` array loads all three as
classic scripts in order — `shared/constants.js`, `background/gist-sync.js`,
`background/background.js`. The manifest carries **both** `background.service_worker`
and `background.scripts`; each browser reads the one it supports (Chrome logs
a harmless "Unrecognized manifest key 'background.scripts'" warning). The
`typeof importScripts === "function"` guard at the top of `background.js` is
what keeps the two paths from double-loading.

## `background/background.js`

The service worker, and the *only* writer to
storage. Owns the chunked `chrome.storage.sync` engine (blocklist entries
are spread across multiple small keys to stay under the 8KB-per-item /
512-item sync quota; once that's exhausted, new entries silently fall back
to `chrome.storage.local` as "local-only"). Also rebuilds
`declarativeNetRequest` dynamic rules whenever the blocklist changes, and
broadcasts `BLOCKLIST_UPDATED` to every open YouTube tab after each write.
`rebuildDnrRules()` assigns rule IDs from fixed bases —
`DNR_RULE_ID_BASE_VIDEO = 100000`, `DNR_RULE_ID_BASE_EMBED = 300000` (the
`sub_frame` block rules, see [fragility.md](fragility.md) → embeds) and
`DNR_RULE_ID_BASE_CHANNEL = 500000` are *bases*, one rule at `base + index`
per blocklist entry, while
`DNR_RULE_ID_HOME = 900001` / `DNR_RULE_ID_SHORTS = 900002` are singletons
always present regardless of the blocklist. Every call clears all dynamic
rules and re-adds from scratch, so the ID ranges only need to not collide.
Rules are **capped** (`DNR_MAX_VIDEO_RULES = 800` — regex-filtered, under
Chrome's 1000 regex-rule limit; `DNR_MAX_CHANNEL_RULES = 3000` — url-filtered)
and go to the *most recently blocked* entries (`ts` desc); DNR is only the
no-flash optimisation for direct navigation, and `content.js`'s
`checkCurrentPageAndRedirect()` / `yt-navigate-start` guards still cover
everything else. `updateDynamicRules()` is wrapped in try/catch so a DNR
failure can never abort a blocklist write. The `DNR_RULE_ID_HOME` /
`DNR_RULE_ID_SHORTS` singletons are added only when their feature toggle is
on (`getSettings()` reads `bt_settings`), and a `chrome.storage.onChanged`
listener rebuilds the rule set when `bt_settings` changes. All other contexts read/write the
blocklist by sending it messages (`GET_BLOCKLIST`, `BLOCK_CHANNEL`,
`BLOCK_VIDEO`, `UNBLOCK_CHANNEL`, `UNBLOCK_VIDEO`, `IMPORT_BLOCKLIST`) rather
than touching storage directly (also `SET_ENTRY_HIDDEN` /
`SET_CHANNEL_AGE_RULE` — one-entry edits via the generalized
`mutateEntry(kind, id, mutate)`, of which `mutateChannelEntry` is now just
an alias — `FETCH_CHANNEL_SUBS` / `BULK_FETCH_CHANNEL_INFO`, which use
`applyChannelInfo()` for a batched single write, and `ALLOW_CHANNEL` /
`DISALLOW_CHANNEL` for the `bt_allowlist` "Never-block" override — see
"Channel allow-list"). `IMPORT_BLOCKLIST` merges in memory and does one
`writeFullState()` (never `addEntry`-per-entry — a multi-thousand-entry
import would blow `chrome.storage.sync`'s write-rate quota and take minutes)
and carries across the optional per-entry extras (`hidden`,
`blockOlderThanDays`, `subs`).
Every blocked entry now also carries `updated_at` (bumped on every
mutation, stamped from `syncedNow()` — `Date.now()` plus a GitHub-derived
`clockOffset`), and `removeEntry()` writes a **tombstone** to
`chrome.storage.local` (`bt_tombstones`, `{ "channel:<key>"|"video:<id>":
deletedAtMs }`, pruned after `TOMBSTONE_TTL_MS`); both exist purely so the
gist merge (see `background/gist-sync.js` below) can do last-write-wins without a stale device
resurrecting a delete. `writeFullState()` re-chunks the whole blocklist
from a merged in-memory state (what the merge and `IMPORT_BLOCKLIST`
produce; `addEntry`/`removeEntry` only touch one entry). Its bulk
`chrome.storage.sync.set` is all-or-nothing, so on failure (one 50-entry
chunk over the 8KB/item cap — long multi-byte names) it retries in order and
spills from the first chunk that won't fit onward to the local overflow
bucket, keeping `bt_ch_0..N` contiguous.

## `background/gist-sync.js`

Loaded into the background context *before*
`background.js`. The cross-vendor sync engine. `chrome.storage.sync`
can't bridge Chrome↔Firefox; this mirrors the blocklist to a single
**private GitHub Gist** instead (no server), written with a fine-grained
PAT the user pastes into the options page (`Gists: Read and write` scope,
stored in `chrome.storage.local` under `bt_sync`, never synced). It
exposes `self.BlockTube.gistSync` with `init(host)` / `onLocalChange()`
(debounced push, called from `broadcastUpdate()`) / `onPoll()` (the
`bt-sync-poll` `chrome.alarms` tick, every `SYNC.POLL_PERIOD_MIN`) /
`configure(token)` / `syncNow()` / `status()`. The one `cycle()` does
pull → per-entry LWW merge (on `updated_at`, with tombstones) → apply
locally via `host.applyMergedState()` (which calls `writeFullState()` then
`broadcastUpdate(state, { fromSync: true })` so it doesn't loop back into
another push) → push if the merged result differs from the remote. It
never touches blocklist storage directly — only through the `host` object
`background.js` hands it. No realtime channel: changes land on the next
poll or the next debounced push. Timestamps come from GitHub's response
`Date` header, not the device clock, so skew can't decide a merge.

## `content/content.js`

Injected into `youtube.com`/`m.youtube.com` at
`document_start`. Does four jobs:
0. **Instant, pre-paint hiding via CSS**: the very first thing this script
   does is create a `<style id="bt-instant-hide">` tag. It holds two
   parts: static rules (Shorts, sidebar Home/Shorts/Report-history,
   masthead Create/Notifications, `#secondary`) set once at startup, and a
   dynamic rule rebuilt by `updateInstantHideBlocklistCSS()` every time
   the blocklist loads/changes, using `:has()` to match any tile
   containing a blocked channel/video link — but only for the
   `INSTANT_HIDE_MAX_CHANNELS` (400) / `INSTANT_HIDE_MAX_VIDEOS` (250)
   *most recently blocked* (`newestFirst()`). **That cap is a measured
   performance budget, not a guess.** The browser re-evaluates the whole
   selector list on every style recalc, continuously, on every page, whether
   or not any of those channels is present — scrolling a search page for
   ~11s cost 0.05s of style recalc with the extension off, 0.21s at 400
   channels, and **0.86s at the old cap of 1500** (23% CPU against a 15%
   baseline). Entries past the cap lose only the pre-paint hide, never the
   block: the JS scrub still removes them a frame later, and they are the
   least recently blocked, so the ones you are least likely to meet.
   Raising it back up is a real, measurable tax on every page. Because `:has()` is
   matched continuously by the browser's style engine as part of normal
   layout — not by a JS callback reacting after the fact — this hides a
   tile before the `MutationObserver` below would ever get a turn to run,
   which matters during a fast burst of insertions (e.g. search results
   loading). It only *hides* (`display: none`); the scrub below is what
   actually deletes the node, and is the only thing that works at all in
   a browser without `:has()` support. `manifest.json` sets Firefox
   `strict_min_version` to `115.0`, roughly the `:has()` baseline in
   Gecko — older Firefox falls back to the JS scrub (job 1) only, with a
   one-frame flash the CSS layer would otherwise prevent.
1. **DOM scrubbing**: a `MutationObserver` on `document.documentElement`
   catches every inserted node, matches it against `RENDERER_SELECTOR`
   (the list of YouTube's custom element tag names for video/playlist/
   channel-card tiles across every surface — home grid, search, sidebar,
   shorts, playlists), and removes it outright if it matches the
   blocklist. Mutation batching happens via `requestAnimationFrame` to
   avoid re-scanning on every one of YouTube's frequent DOM writes. After
   a removal, `scheduleShelfPrune()` checks the tile's shelf ancestor
   (`SHELF_SELECTOR` — "Latest from [channel]", a Shorts shelf, etc.) and
   removes the whole shelf ~1s later if it's now empty, so blocking
   doesn't leave a headless shelf frame behind. Running dry is not the
   only way a shelf goes, though: `scrubShelfOwners()` (in `runExtras()`,
   so throttled) reads the owner off the shelf's own **header** and
   removes a FULL-blocked channel's shelf up front. Waiting for it to
   empty left the channel's name, avatar and "View full channel" button on
   screen for a beat — and permanently whenever one tile survived, which
   an `EXCEPT_WHITELIST` channel with a whitelisted video in the shelf
   always does. This is upstream BlockTube's `shelfRenderer` rule
   (`endpoint.browseEndpoint.browseId`) done through the DOM. It is FULL
   blocks only: a video-only channel may legitimately show whitelisted or
   recent videos in a shelf, so those shelves stay and their tiles are
   judged one at a time as before. The same observer also
   watches for the `is-active` attribute flipping on
   `ytd-reel-video-renderer` — YouTube's vertical Shorts feed keeps
   several mounted at once and just re-flags which is current, so a plain
   childList watch would miss it.
2. **Hover-to-block UI**: injects a 🚫 button into unblocked tiles with a
   menu listing "Block this video" plus, per distinct channel found in
   that tile (a tile can list more than one via YouTube's
   channel-collaboration feature — see `collectChannels()`), *two* entries:
   a full "Block channel: X" and a softer "Block all videos from X (allow
   some later)" — see [blocking-rules.md](blocking-rules.md) for what the difference
   actually does.
3. **Navigation interception**: `declarativeNetRequest` (background.js)
   only catches exact blocked video IDs or exact channel *page* URLs
   belonging to a FULL-mode channel at the network layer — it cannot know
   "this video's channel/collaborator is blocked" or "this playlist
   belongs to a blocked channel" from the URL alone, and deliberately
   doesn't redirect an EXCEPT_WHITELIST channel's own page at all.
   `checkCurrentPageAndRedirect()` closes the remaining gap by
   re-checking the page's actual rendered channel(s) — via
   `findScopeForCurrentPage()` (scoped to e.g.
   `ytd-watch-metadata`/`ytd-playlist-header-renderer` so it never picks
   up unrelated channels from elsewhere on the page) and `channelBlocks()`
   (which knows about whitelist exceptions) — redirecting to
   `SAFE_LANDING_URL` (Subscriptions) if blocked. `yt-navigate-start` is
   also intercepted for an earlier bounce on exact video-ID matches and on
   navigating straight to a FULL-blocked channel's page.

   **It must run repeatedly, not once.** It is part of the
   `runExtras()` batch, so the `scheduleExtrasScrub()` throttle and the 2s
   heartbeat re-run it until the page has hydrated; the one-shot calls at
   blocklist-load and on `yt-navigate-finish` are *not* sufficient on their
   own, because a fresh (non-SPA) load renders its channel byline long
   after the blocklist arrives and need not fire `yt-navigate-finish` at
   all. That combination is exactly how a blocked channel's video used to
   play normally. It also runs on `BLOCKLIST_UPDATED` (blocking a channel
   while watching its video takes you off the page) and on `pageshow`
   (`persisted`) / `popstate`, since a back/forward-cache restore re-runs
   no script and fires no `yt-navigate-*` event.

   **History matters as much as the redirect.** `bounce()` uses
   `location.replace()` — we are standing *on* the offending page, so the
   blocked URL must not be left in session history; with a plain
   `location.href` assignment, Back returns to the blocked page (and, now
   that the check repeats, bounces forward again, so Back looks broken).
   The `yt-navigate-start` guards are the opposite case — they fire while
   the *innocent* referring page is still current, so they deliberately
   push instead, and the blocked URL never enters history at all.

   URL shapes: a video is reachable as `?v=<id>`, `/shorts/<id>`,
   `/live/<id>`, `/embed/<id>` and `/v/<id>`, and a channel as `/@handle`,
   `/channel/UC…`, `/c/<name>` and `/user/<name>` — all of which the guard
   and the DNR rules must cover, not just the canonical two.
   `pageIdentityKeys()` reads the page's own `<link rel="canonical">` /
   `<meta itemprop>` / channel header so a block matches whichever identity
   format the URL carries (see "Channel identity"). `/embed/<id>` is the
   one page with no readable byline at all — nothing on it names the
   uploader — so a videoId with no channel in scope is resolved through
   `MSG.RESOLVE_VIDEO_CHANNEL` (background, YouTube's public oEmbed
   endpoint, cached per video id).

Separately, `content/content.js` also enforces things that are **not**
blocklist-driven. Each is gated on its own **feature toggle**, and the
toggles are a two-level tree (`SETTING_GROUPS` in `shared/constants.js`):
seven groups, and **one leaf per thing removed** — 33 of them. Only leaves are
stored (flat, in `chrome.storage.sync` under `SETTINGS_KEY` / `bt_settings`).
All default `true` **except `blockInEmbeds`**, which ships off because it is
the only leaf that affects sites other than YouTube; a leaf opts out with
`default: false` in the tree and `DEFAULT_SETTINGS` is derived from that; a group's master switch in the options UI is *derived*
from its leaves, never persisted, so it cannot disagree with what is applied.
`resolveSettings(stored)` merges over `DEFAULT_SETTINGS` and expands
`LEGACY_SETTING_MAP` — the coarse per-surface keys an older version wrote
(`cleanSidebar`, `hideVideoActions`, `hideMemberships`, `cleanChannelTabs`,
`cleanMasthead`, `removeShorts`) — so an upgrade keeps a user's disabled
features off instead of silently switching them back on. `applySettings()`
goes through it, rebuilds the static instant-hide stylesheet
(`buildStaticCSS()` joins the `STATIC_CSS_PARTS` whose **leaf** key is on,
so the CSS layer is per-element too) plus the blocklist half, and — on a
*live* change — re-runs `runExtras()`. The startup `runExtras()` is deferred
until `chrome.storage.sync.get` resolves (`settingsLoaded`), because a
`remove*` a user has turned off must not fire its irreversible `.remove()`
once before their settings arrive. `chrome.storage.onChanged` keeps it live.
Blocklist enforcement itself has no toggle — it's the point of the extension.

A scrub that covers several leaves bails early only when *nothing* in its
group is on (`anyOn(KEYS)`), then re-checks the specific key at each place it
acts — `activeNavLabels()` / `activeActionLabels()` rebuild their match sets
per call for exactly that reason. The groups and what they gate:
- **Shorts** — `shortsFeedTiles` (shelves/tiles, and the CSS part),
  `shortsPlayer` (the full-screen player, the `/shorts/*` and
  `reelWatchEndpoint` nav guards, and the `DNR_RULE_ID_SHORTS` network rule),
  `shortsChannelTab`.
- **Home page and navigation** — `redirectHomepage` (the `/` → Subscriptions
  bounce: `DNR_RULE_ID_HOME` plus the nav guards), `logoToSubscriptions`
  (`retargetLogo()`).
- **Left sidebar** — `sidebarHome` / `sidebarShorts` (matched by link, not
  label), `sidebarExplore`, `sidebarMoreFromYouTube`, `sidebarReportHistory`,
  `sidebarFooter`.
- **Top bar** — `mastheadCreate`, `mastheadNotifications`, `hideVoiceSearch`,
  `hideSearchSuggestions`, `accountButtonOnHover`.
- **Watch page** — `removeRelated` (plus the reflow CSS described below),
  `removeEndScreen`, and one leaf per action button: `actionShare`,
  `actionSave`, `actionDownload`, `actionClip`, `actionThanks`, `actionMore`
  (Report rides with More, since removing the overflow menu is what puts it
  out of reach).
- **Channel page** — `joinButton`, `membershipPrices`, `membersOnlyTiles`,
  `membershipTab`, `tabPosts`, `tabShows`, `tabPodcasts`, `tabStore`.

`removeRelated`'s reflow CSS caps `#primary` at
`min(100%, max(426px, calc((100vh - 144px) * 16/9)))` — wide enough to use
the freed space, but bounded so a 16:9 player's height stays under
`viewport − masthead − title`, i.e. the player *and* the title still fit
above the fold (going full-width made the player taller than the viewport on
wide screens). The inner chain (`#player-container` etc.) is forced to fill
that capped column with zero right padding (YouTube's JS had sized it for the
2-column layout, leaving a right gap), and `overflow-x: clip` on `ytd-app`
stops the page ever scrolling sideways — without that, at some widths a
scrollbar appears and arrow keys pan the page instead of seeking.
`[theater]` is left alone.

All of the above `scrub*` / `retargetLogo` / `scrubOwnChannelPage` /
`scrubShelfOwners` functions (there are ~11) plus
`checkCurrentPageAndRedirect()` live in
**`runExtras()`**, and `recheckHydratingTiles()` (playlist tiles with
late-hydrating bylines, and keyword tiles with late titles) alongside it,
run through the `scheduleExtrasScrub()` throttle — at most every ~400ms
rather than on every mutation, because several full-document
`querySelectorAll` passes per DOM write made the first page load
noticeably slower.

**Keep that list in exactly one place.** `scheduleExtrasScrub()` and the
`yt-navigate-finish` handler both *call* `runExtras()`; they used to repeat
its contents inline instead, and anything added to only one of the three
copies silently never ran on a normal page load — that is precisely how the
page-redirect check ended up dead on fresh loads while looking wired up. A
`setInterval` heartbeat re-triggers the same throttle every 2s as a
fallback, and `yt-navigate-finish` runs the batch on SPA navigation. Only
the blocklist-driven removals in `processRenderer()` — and `scrubPosts()`,
cheap because posts are rare — run in the hot per-mutation path
(`scheduleFlush` / the `MutationObserver` callback via `sweep()`) —
don't add a new document-wide scan there without routing it through the
throttle.

`SAFE_LANDING_URL` (`https://www.youtube.com/feed/subscriptions`) is
defined independently in both `content/content.js` and
`background/background.js` (no shared module system to hold one copy) —
change both if it ever needs to move.

## `content/content.css`

The manifest's only stylesheet, and it covers **just the hover UI** — the
🚫 `.bt-block-btn` and its `.bt-block-menu`. The button is anchored
bottom-right of a tile on purpose: YouTube's thumbnail sits along the full
top (grid tiles) or the full left (compact/search/sidebar tiles), so
bottom-right lands in the metadata area either way, clear of both the
mouseover video preview (which paints over anything on the thumbnail at any
z-index) and YouTube's own 3-dot menu.

Everything else that was once here — the `#secondary` removal, the
`#primary` reflow — now lives in content.js's `<style id="bt-instant-hide">`,
because it is toggle-driven and a static stylesheet cannot be switched off.
**A new rule belongs here only if it should apply unconditionally, forever.**

## `popup/`

Quick-block UI for the tab you're currently on. Asks the
content script for `GET_PAGE_TARGET` (current video + the channels found
in scope) and renders both block-mode buttons per channel (see [Channel
block modes](blocking-rules.md)), same as the hover menu. It renders **one row per
returned channel**, which is why `getCurrentPageTarget(withAliases)` splits:
the nav guard passes `true` and wants every identity format it can find (more
chances to match however an entry is keyed), the popup passes nothing and
wants one row per real channel. Without that split a watch page returned both
`@handle` and `UC…` for the *same* channel and the popup offered to block it
twice — the byline holds only `/@handle`, but the **description** carries
`/channel/UC…/videos` and `/about` links, so collecting from the whole
metadata swept up the other format. The popup path therefore narrows to
`OWNER_BYLINE_SEL` first; collaborators are all in that byline, so genuine
multi-channel videos still get a row each. `popup-test` guards it.

## `options/`

The full blocklist manager (search, unblock, JSON
export/import), opened via `chrome.runtime.openOptionsPage()`. Listens to
`chrome.storage.onChanged` to live-refresh (debounced ~300ms;
`suppressStorageRefresh` mutes it during a bulk sub-count load). The page is a
two-column shell: a sticky `.sidenav` (brand, five `.page-tab` buttons with
live count badges, a footer note) beside a `.main` column holding `.wrap`.
`showPage()` toggles the `.page` divs `#page-blocklist` / `#page-keywords` /
`#page-allowlist` / `#page-settings` / `#page-sync`, last one remembered in
`localStorage`. Under 860px the rail collapses to a horizontal icon strip.
Every colour is a CSS custom property defined once on `:root`, with a
`prefers-color-scheme: dark` block redefining **only** the tokens — no rule
hard-codes a colour.

Blocklist's chrome is **one row** (`.bl-bar`): search, a **Show** select
(`#filter-by`), a **Sort** select (`#sort-by`), **Select**, and a **⋯**
overflow menu (`#bl-menu-btn` / `#bl-menu`). Everything used to sit out in
the open — six filter pills, both sub-count sweeps, export, import, the
small-channel filter, clear-all-videos — and a page whose every control is
permanently visible is a page you have to read before you can use it. The
menu holds what's touched about once a month (the two sweeps, the "hide
under N subs" filter, export/import, clear all videos); the bar holds what's
touched every visit. The menu closes on an outside click and on Escape, but
**not** when the click lands on a `<label>` inside it — the threshold filter
is a control, not a command, and closing the menu out from under it made it
unusable.

`#filter-by` narrows to All / full channels / video-only channels / videos /
**No sub count** / **Hidden** ("No sub count" = `subsToNumber(e.subs) ==
null`, so it gathers the never-fetched *and* the ones whose count is hidden
or came back "n/a" — exactly the rows the subs sort can't place and the size
filter can't judge). Only those last two options carry a **count** in their
label, and only when non-zero: a count is there to answer "is there anything
in here?", which is a question you only ask of the two exception buckets.
Tests drive it with `selectOption("#filter-by", …)` — the `.filter-tab`
pills are gone. Anything that moved into the ⋯ menu (`#fetch-all-subs-btn`,
`#load-subs-btn`, `#clear-videos-btn`, `#export-btn`, `#import-input`,
`#hide-small`) is `isHidden()` until `#bl-menu-btn` is clicked, so a test
that touches one must open the menu first — the same shape as the row
drawer holding **Hide**. Lists
render `RENDER_CAP` (300) rows and then **grow** — `renderList()`'s
`#…-more` line carries "Show N more" / "Show all", stepping `shown[key]` by
`RENDER_STEP`. It is a cap, not a truncation: the whole blocklist has to be
reachable by scrolling, not only by guessing a search term. `resetShown()`
runs whenever the visible set changes (tab / search / sort) so a list never
opens mid-way down. Rows are **two lines**: the
channel/video name on its own, then a quiet `.row-meta` line carrying the
`@handle`/id, the subs chip, the block-mode badge and any "local only" tag —
a row gets scanned far more often than it gets acted on, and eight controls
competing on one line is what made the list unreadable. The right-hand
`.row-actions` column holds only **Unblock** plus a **⋯** disclosure; ⋯
opens `.row-drawer`, which holds **Hide** (`buildHideBtn` →
`SET_ENTRY_HIDDEN`), the mode switch, and — for a video-only channel — the
whitelist/age editor. Because the actions column is fixed-width, the buttons
line up down the list instead of landing at a different x on every row. the video section has a
**"Clear all N blocked videos"** button (`#clear-videos-btn` →
`CLEAR_BLOCKED_VIDEOS`, a single bulk write + a tombstone per video) with an
undo entry in the **Recently unblocked** `<details>` below it; a
video-only channel's whitelist/age panel is a `<details>` inside that drawer,
so a page of them stays short. Channel rows show a subscriber-count
chip (`buildSubsChip` → `FETCH_CHANNEL_SUBS` for one, cached on the entry
**permanently** — there is deliberately no staleness window; see
[subscriber-counts.md](subscriber-counts.md)) and — once known — the channel's **`@handle`** in place of
the raw `UC…` id (a channel keyed by `@handle` shows no separate id line at
all; the `UC…` becomes a tooltip). `bulkFetchSubs()` batches ids (40 each)
into `BULK_FETCH_CHANNEL_INFO` messages, two in flight; each message
fetches its batch 8-wide in the worker and does **one** storage write —
the old one-message-and-one-write-per-channel path is what made a
few-thousand-channel sweep crawl. It also captures `entry.handle` +
a real `entry.name`. Button doubles as Stop, mutes the storage-refresh
meanwhile, fires one `SYNC_NOW` at the end. "Load sub counts"
(`#load-subs-btn`) does the rendered rows, "Fetch all sub counts"
(`#fetch-all-subs-btn`) the whole blocklist (resumable — skips channels
already attempted); a successful **import** offers to run the
whole-blocklist sweep. `#sort-by`
(`sortBy`: recent / subs↓ / subs↑ / name — `subsToNumber()` parses
"1.2M"-style strings, unknowns sort last; **defaults to subs↓**, and the
`selected` attribute in `options.html` must track that default) and the
**"Hide under N subs"** view filter (`hideSmall` / `smallThreshold`, unknown
counts kept, in the ⋯ menu) narrow the channel list. `#channel-stats` is a
single quiet line of counts (channels · videos · total subs) — it used to
explain itself in prose, which is exactly the kind of text a page shows once
and then makes you skim past forever. The **"What gets hidden"** page
(`#settings-list`, `SETTING_GROUPS` → `renderSettings()`) renders the toggle
tree: one `.sgroup` card per group, a `.group-toggle` master in its header,
and one `.switch` per leaf. The master is **derived** — checked when every
leaf in the group is on, cleared when none are, `indeterminate` in between —
and clicking it writes every leaf in that group. No group state is stored, so
a master can never claim a group is on while a leaf inside it is off.
`#settings-search` filters by group and item text. Writes land in
`bt_settings` on every flip; it live-updates from `chrome.storage.onChanged`.
**Count contract:** `#settings-list .switch` is exactly the leaves (33, of
which 32 are checked by default) —
masters use `.group-toggle` precisely so they don't inflate it. Each switch
carries **`data-key="<setting>"`** and every test must select through it —
`nth(11)` and hand-maintained mirrors of the settings order are how adding a
setting silently re-points a test at the wrong switch, so the failure lands
on an unrelated assertion (adding `cleanChannelTabs` once made `layout2-test`
report "autocomplete did not return"). Adding a setting means: a leaf in
`SETTING_GROUPS`, the gating code in `content.js`, and the toggle-count
assertions in `settings` / `ui-hide` / `members` / `ux` / `layout2`. Those
tests' `setToggle()` takes a key **or an array of keys**, so a former coarse
toggle is flipped as its group of leaves. Also hosts the **Sync** card (`#sync-card`,
`initSync()`) — paste a GitHub PAT to connect, "Sync now" / "Disconnect this
device", and a status block from `GET_SYNC_STATUS` showing the synced
channel/video counts, a link to the gist, and a "paste the same token on
your other devices" hint. (`ensureGistId()` sets `lastPushedAt` when it
*creates* the gist, since creating it with the snapshot is the first push —
otherwise the line read "last pushed: never" right after a successful
connect.) The token round-trips through `SET_SYNC_CONFIG` to
`background/gist-sync.js`; the options page never talks to GitHub itself. Each EXCEPT_WHITELIST channel row expands into a panel
(`buildWhitelistSection()`) with the whitelist editor (`extractVideoId()`
parses a URL or bare ID), the "only block videos older than N days" control
(`buildAgeRule()` → `SET_CHANNEL_AGE_RULE`), and a flip-to-FULL button.

## `shared/constants.js`

Holds the message-type enum, storage chunking config
(`CHUNK_SIZE`, `MAX_SYNC_ITEMS`, key prefixes, plus `TOMBSTONE_KEY` /
`TOMBSTONE_TTL_MS` / `SYNC_KEY`), the gist-sync config block (`SYNC.*` —
gist filename, poll period, push debounce), and the feature-toggle
contract — `SETTINGS_KEY` = `bt_settings`, `SETTING_GROUPS` (the two-level
toggle tree), `DEFAULT_SETTINGS` (33 leaf booleans derived from the tree —
all `true` bar the opt-in `blockInEmbeds`), `LEGACY_SETTING_MAP` and
`resolveSettings()`. Loaded as a plain script
everywhere (`importScripts` in the service worker, `<script src>` in HTML
pages, first entry in the manifest's `content_scripts.js` array) and
attaches to `self`.

## Sync: two layers

1. **`chrome.storage.sync`** (the chunked engine in `background.js`) — free,
   automatic, but only bridges browsers signed into the *same vendor's*
   account sync (Chrome↔Chrome via Google, Firefox↔Firefox via a Firefox
   Account). It does **not** bridge Chrome desktop to Firefox for Android.
2. **GitHub Gist** (`background/gist-sync.js`, opt-in per device via a PAT in
   the options page) — closes the cross-vendor gap. Layered *on top of*
   layer 1, not replacing it: the chunked local store is still the fast
   read/write path and the offline cache, and `gist-sync.js` reconciles it
   with the gist on a timer. `localOnly` / the 480-item overflow still apply
   as a local concept; entries past the cap that also need to sync ride the
   gist but not `chrome.storage.sync`.

Merge is per-entry last-write-wins on `updated_at` with tombstones (see the
the `background/gist-sync.js` section above). It is intentionally simple —
conflicts are rare for one person with a few devices, and the semantics are
forgiving (re-adding an already-blocked entry is a no-op; the worst case is
a resurrected unblock, which the tombstone TTL bounds). If a genuinely
robust multi-writer story is ever needed, that's a CRDT/vector-clock
rewrite, not a tweak here.
