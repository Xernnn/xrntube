# Architecture

How the four contexts fit together and what each one owns.

Four contexts talk to each other exclusively through `chrome.runtime`
messages defined in `shared/constants.js` (`XrnTube.MSG`) — there is no
shared module system, so this file is the map of what messages exist and
must be loaded via `<script>`/`importScripts` before any file that uses
`self.XrnTube`.

The background context is one MV3 service worker, `background.js`, which
pulls in the other two plain scripts with
`importScripts("../shared/constants.js", "./server-sync.js")`. (Firefox, with
its separate `background.scripts` path, is no longer supported: the extension
targets Chromium browsers — Chrome on the desktop, Quetta on the phone.)

## `background/background.js`

The service worker, and the *only* writer to the blocklist. **The blocklist
store** is one `chrome.storage.local` key, `bt_blocklist` =
`{ channels, videos }`, read and written whole (~1MB for 5,000 channels;
`unlimitedStorage` lifts the 10MB ceiling). Every write goes through
`updateStore(change)`, a one-at-a-time queue that loads the store, lets
`change` mutate it (returning `false` skips the write) and saves it — without
the queue, two writers that each read the whole list and wrote it back would
drop one another's edit. `addEntry` / `removeEntry` / `mutateEntries` /
`applyChannelInfo` / `deleteData` / the restore and the import are all
`updateStore` callers; `writeFullState()` (the sync merge's whole-list
replace) is one too. Until v2 the blocklist lived in `chrome.storage.sync` as
50-entry chunks with a local-only overflow, forced by its 8KB-per-item and
512-item limits — the cause of two silent-write bugs. `migrateFromSyncChunks()`
folds that layout into the new key on the first `loadAll()`, and removes the
old keys only after the new one is written. Also rebuilds
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
`SET_CHANNEL_AGE_RULE` — edits in place via
`mutateEntries(kind, ids, mutate)`, with `mutateChannelEntry` as its
one-channel form — `FETCH_CHANNEL_SUBS` / `BULK_FETCH_CHANNEL_INFO` and the
sweep (below), which use `applyChannelInfo()` for one write per batch, and `ALLOW_CHANNEL` /
`DISALLOW_CHANNEL` for the `bt_allowlist` "Never-block" override — see
"Channel allow-list"). `IMPORT_BLOCKLIST` merges in memory and does one
`writeFullState()` (never `addEntry`-per-entry — a multi-thousand-entry
import would blow `chrome.storage.sync`'s write-rate quota and take minutes)
and carries across the optional per-entry extras (`hidden`,
`blockOlderThanDays`, `subs`). It matches an incoming channel against
**every identity** an existing entry answers to — its key, its scraped
`handle`, its scraped `ucid`, handles lowercased — so a file naming a
channel by its `UC…` id lands on the entry you already block by `@handle`
instead of adding a second one; and for an entry that already exists it
fills in only what the entry lacks (sub count, the other identity, a real
name, a video's title), never its mode, whitelist or age rule. It also
merges an optional `allowlist` map, and answers with what the file changed
(`added`, `enriched`, `duplicates`, `allowAdded`) as well as the totals.
The quick-add box and `fillVideoTitles()` both ride this same path.

**Bulk forms.** `SET_CHANNEL_MODE`, `SET_ENTRY_HIDDEN` and `ALLOW_CHANNEL`
take `ids` as well as `id` (`idsOf(msg)`): `mutateEntries()` and
`setAllowed()` are one write for the whole selection — a per-entry loop is a
whole-list write and a DNR rebuild per row.
**`DELETE_DATA`** `{ channels: [ids] | "all", videos: [ids] | "all",
keywords, allowlist }` removes any mix of those in one `writeFullState()`
plus one tombstone write, and pushes **one** undo record holding everything
it removed (keywords and the never-block list included). Every removal answers with
`undoTs`, the record's stamp, which `RESTORE_UNBLOCK { ts }` restores by —
an index shifts the moment anything else is removed, which made "Undo" on a
toast restore the wrong thing. Restoring merges the whole record back in one
write too (a 5,000-entry "delete all" restored through `addEntry()` would
hit the write quota a hundred entries in).
Every blocked entry also carries `updated_at` (bumped on every mutation,
stamped from `syncedNow()` — `Date.now()` plus the sync server's clock
offset), and `removeEntry()` writes a **tombstone** to `chrome.storage.local`
(`bt_tombstones`, `{ "channel:<key>"|"video:<id>": deletedAtMs }`, pruned
after `TOMBSTONE_TTL_MS`); both exist so the sync merge can do
last-write-wins without a stale device resurrecting a delete.

**Duplicates fold.** One channel can be stored twice — blocked once as
`@foo`, once as its `UC…` — and only a lookup (or an import) pairs the two.
`foldDuplicateChannels()` runs at the end of `applyChannelInfo()` and of the
import: a union over key / `handle` / `ucid`, each group folded into its
earliest entry (stricter mode wins, video-only exceptions combine, the newer
sub count and both identities kept), the folded keys tombstoned.

**The sweep** — every bulk sub-count / identity lookup. `lookupChannels()`
runs 3 lanes with ~300–600ms between requests; a 429 or a fetch that throws
(YouTube redirecting to Google's "unusual traffic" page, a host the extension
may not follow) stops the batch, and the channel is neither recorded nor
dropped. `START_SWEEP { ids, label }` queues channels in
`chrome.storage.local` `bt_sweep` (`queue`, `total`, `done`, `got`,
`missed`, `pauseUntil`, `backoffMs`…); `runSweep()` works through it 24 at a
time, one `applyChannelInfo()` write per batch, rebroadcasting every 200 so
open tabs pick up new `@handle`s as they arrive. Throttling pauses the queue
30s, doubling to 15min; an alarm (`bt-sweep`) brings a suspended worker back,
and any wake resumes an unfinished queue. `STOP_SWEEP` empties it,
`GET_SWEEP` reports it. The options page only queues and draws progress from
`bt_sweep`'s storage changes, so closing it no longer stops anything.
`BULK_FETCH_CHANNEL_INFO` stays as a small lookup the caller waits for (the
tests use it), through the same `lookupChannels()`.

## `background/server-sync.js`

Sync with the user's own server (`server/xrntube-sync.py`; protocol and
deployment in [sync-server.md](sync-server.md)). The address, user name and
password live in `chrome.storage.local` `bt_sync` (never in sync storage). It
exposes `self.XrnTube.serverSync` with `init(host)` / `onLocalChange()`
(debounced push, from `broadcastUpdate()`) / `onPoll()` (the `bt-sync-poll`
alarm, every `SYNC.POLL_PERIOD_MIN`) / `configure({ url, user, password })`
(or `null` to disconnect) / `syncNow()` / `status()`. The one `cycle()`:
GET the document → per-entry LWW merge on `updated_at` with tombstones
(keywords and the allow-list are whole-object LWW on their `ts`) → apply
locally via `host.applyMergedState()` (then `broadcastUpdate(…, { fromSync:
true })`, so it doesn't loop into another push) → PUT if the merge differs from
the remote, with `If-Match` set to the version it read. A **412** means
another device wrote in between: the cycle simply runs again on the newer
copy. The server's `Date` header sets the clock offset. It never touches
blocklist storage directly — only through `host`.

## `content/page-hook.js`

The **MAIN-world** content script, injected at `document_start`. It is the
only code that runs in the page's own JavaScript world, which is the only
place `window.fetch` and `window.ytInitialData` can be intercepted — an
ordinary content script sees a different `window`.

It is layer 0: it filters YouTube's own JSON **before Polymer renders it**,
for `/youtubei/v1/search`, `/youtubei/v1/browse`, `/youtubei/v1/next` and
`/youtubei/v1/get_watch` (search results, every channel tab, the watch page's
related column, and the continuations all of them page in with) plus the
first paint's `ytInitialData`. `get_watch` — what an in-app click to a video
fetches now — is streamed through part by part (`streamWatchParts()`) so the
player part isn't held back. It also applies one switch rather than a
verdict: `hideAutoChapters` arrives in the `config` message and strips
YouTube's generated chapters synchronously (`stripAutoChapters()`). Everything below reacts to a tile YouTube has already
decided to render; this one deletes the tile from the data. Measured live on
a search page: 4 responses inspected, 203 renderers described, 40 removed
before render.

`/next` is the one endpoint here that is not an optimisation. **A related
tile names its uploader in plain text** — measured live, a rail of 26
`yt-lockup-view-model`s carrying exactly two anchors each, both
`/watch?v=…`, and not one channel link on the page. `tileChannels()`
therefore finds nothing, every channel block misses, and the hover menu can
only offer "Block this video"; matching the visible name against a blocklist
would be guessing a channel, which is the one thing this codebase never
does. The first rail comes with `ytInitialData` and was already covered, but
**every in-app hop from one video to the next fetches a fresh rail from
`/next`** — so without it, blocked channels reappeared in the sidebar the
moment you clicked anything. `/player` is still left alone deliberately: it
is the playback path, and a blocked video is caught by DNR and the nav guard
long before it matters.

**It decides nothing.** It knows only *where* the fields are — the `RULES`
table maps a renderer key (`videoRenderer`, `lockupViewModel`,
`universalWatchCardRenderer`, …) to the paths holding its video id, title,
duration badge and publish text, plus two fields for tags that serve several
kinds of tile: `kindFrom` (a `lockupViewModel` says whether it is a video, a
playlist or a Short in `contentType`, and a playlist's `contentId` is a `PL…`
id, not a video id) and `bylinePaths` (a lockup keeps its channel thirteen
levels down, three past where the generic scan stops — see
[fragility.md](fragility.md)). It reads those raw, posts them to
content.js, and applies the list of indices that comes back. Channel URLs go
across unnormalised and durations un-parsed; every question of *meaning* is
answered by `shared/block-logic.js` in the isolated world.

That split is forced, not stylistic. **Chrome injects a given script path
only once per document, even across `content_scripts` entries in different
worlds.** Listing `shared/block-logic.js` in both entries means only one of
them gets it — and when the isolated entry is the loser, content.js dies on
startup with *"Cannot destructure property 'MSG' of 'self.XrnTube'"*.
Confirmed live in both entry orders, and with dynamic
`chrome.scripting.registerContentScripts` too. So the MAIN entry lists this
file **and nothing else**, and the only way to keep one copy of the decision
is to keep the decision out of that world. Adding a shared file to the MAIN
entry will break the extension in a way that looks nothing like its cause.

Two further consequences worth keeping:

- **A miss here is a latency regression, never a blocking failure.** An
  unhooked endpoint, a renderer with no rule, a shape that changed this
  morning, a verdict that doesn't arrive inside `JUDGE_TIMEOUT_MS` — each
  hands back the original response untouched and lets the DOM scrub do what
  it always did. That is what lets `RULES` be precise (named byline fields,
  no guessing) rather than defensive.
- **Nothing is deferred.** Upstream BlockTube queues YouTube's own bootstrap
  until its blocklist arrives, which filters the first paint reliably but
  means a blocklist that never arrives wedges the page. Here `ytInitialData`
  is filtered opportunistically: the write starts the round-trip, and the
  edit lands in place if Polymer hasn't read it yet. We win the first paint
  often, never at the cost of a hung page.

One interaction to keep in mind when touching either side:
`curbRunawayFeed()` decides a feed is short *because of us* by counting
`suppressedOnPage`, which the DOM scrub increments as it removes tiles. A
tile layer 0 deleted never reaches the DOM to be counted, so `content.js`
adds the verdict count when it answers a `judge`. Without that the curb waits
for YouTube to deliver 12 tiles layer 0 failed to catch, and a fully-blocked
feed fires extra continuation fetches before the loop breaks (measured: 2
instead of 0). Anything else that starts removing content earlier in the
pipeline has to feed that counter too.

The same handler also counts **rounds**, which is the half of the runaway
problem geometry cannot see (`noteJudgedRound()` → `feedExhausted`). One
judged batch is one fetch, so a batch that carried videos and had none
survive is an empty round; a single surviving video resets the count. After
`EXHAUST_ROUNDS` (3) of those on a paging surface — search, the feeds, a
channel's tabs; never `/watch`, whose rail is fixed-length and whose
continuation also loads comments — the surface is declared exhausted:
`postHookConfig()` sends `exhausted: true`, the hook's `stripContinuations()`
takes `continuationItemRenderer` / `continuations` out of every further
response, and `curbRunawayFeed()` puts up the notice without waiting for the
sentinel to be in range. The flag is lifted again at
`yt-navigate-start` — not at `-finish` — because the next page's `/next`
goes out while the navigation is in flight, and a watch page's `/next` also
carries the "load more comments" continuation; `resetPageSuppressed()`
clears it on a fresh page view too. Both tell the hook. Without this a search page — tall on its own, so its
sentinel sits out of range — kept fetching "until one gets through".

It also beats the DOM at channel identity: a `browseEndpoint` usually carries
`browseId` (`UC…`) **and** `canonicalBaseUrl` (`/@handle`) together, so a
`UC…`-keyed blocklist matches a tile that renders only the handle — without
waiting for the enrich sweep to pair them up.

Privacy note: the MAIN world *is* the page, so its `postMessage` traffic is
readable by YouTube's scripts. Keeping the blocklist in the isolated world
means what crosses is only a description of what YouTube itself just sent,
plus a list of indices — never the blocklist, and no `XrnTube` global.

## `content/content.js`

Injected into `youtube.com`/`m.youtube.com` at
`document_start`. Answers layer 0's questions (`judgeHookItem()` translates a
renderer description into the same `blockReasonFor()` call a DOM tile gets),
and does four jobs of its own:
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
   a browser without `:has()` support.
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
eight groups, and **one leaf per thing removed** — 39 of them. Only leaves are
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
- **AI features** — `hideAskYouTube` (the chat button beside the search box
  *and* the "Ask" section under a description; both surfaces of one feature,
  so one leaf), `hideVideoSummaries` (the AI summary card in a search result;
  its host element is shared with a watch page's chapters, so the rule keys
  off `has-video-summary` / the inner view model, never the tag),
  `hideAutoChapters` (YouTube's generated chapters; creator and AI chapters
  render identically, so this one is applied in `page-hook.js` — the switch
  rides the hook's `config` message — with only a CSS backstop for the side
  panel, whose `target-id` names the auto kind).
- **Watch page** — `removeRelated` (plus the reflow CSS described below),
  `removeEndScreen`, `descriptionInfocards`, `commentsTwoColumn`, `pipButton` (the
  one leaf that *shows* something: YouTube's own picture-in-picture button,
  which every player carries hidden; gated on `document.pictureInPictureEnabled`,
  so a browser without the API gets no dead button), and one leaf
  per action button: `actionShare`,
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
`scrubShelfOwners` / `capComments` functions (there are ~12) plus
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

`SAFE_LANDING_URL` (`https://www.youtube.com/feed/subscriptions`) lives in
`shared/constants.js`. It used to be declared separately in
`content/content.js` and `background/background.js`, on the grounds that
there was no shared module system to hold one copy — which stopped being
true once `constants.js` was loaded by both.

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

On a touch screen (`@media (hover: none)`) the button is always shown, a
little larger — there is no hover to reveal it, so without this every 🚫 on
m.youtube.com was there but invisible. Always shown, its page-wide z-index
also drew it over YouTube's sticky watch-page player for a tile scrolled
underneath, so there each host (`[data-bt-btn]`) gets `isolation: isolate`,
which keeps the z-index inside its own tile.

One button per tile means one per grid cell: `*-rich-item-renderer` wraps
the real tile, and both are in `RENDERER_SELECTOR`. `injectBlockButton()`
gives the button to the wrapper (removing it removes the whole cell) and
none to the tile inside it. On a phone, a button on each showed two XrnTube
menus per video on channel tabs and the other rich-grid feeds.

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

On **m.youtube.com** (a phone browser) the owner is the icon link in
`ytm-slim-video-action-bar-renderer` and the scope is
`ytm-slim-video-metadata-section-renderer`; the tab title stays a bare
"YouTube" for a while there, so the title falls back to
`h2.slim-video-information-title` (`mobile-test` guards both).

Anything already blocked shows its status with an **Unblock** button rather
than a dead label, and `findChannelKey()` recognises a channel stored under
its *other* identity (key, `handle` or `ucid`) — without it a channel blocked
as `@foo` was offered for blocking again on a page that names it by `UC…`.

## `options/`

The full blocklist manager (search, block, delete, backup/import), opened via
`chrome.runtime.openOptionsPage()`. Listens to `chrome.storage.onChanged` to
live-refresh (debounced ~300ms; `suppressStorageRefresh` mutes it during a
bulk sub-count load or a bulk action). The page is a two-column shell: a
sticky `.sidenav` (brand, six `.page-tab` buttons with live count badges, a
footer with the keyboard hints) beside a `.main` column holding `.wrap`.
`showPage()` toggles the `.page` divs `#page-blocklist` / `#page-keywords` /
`#page-allowlist` / `#page-settings` / `#page-sync` / `#page-data`, last one
remembered in `localStorage`; a `#<page>` hash (the popup's "Backup &
import" opens `options.html#data`) wins over that. Under 860px the rail
collapses to a horizontal icon strip.

**No native dialogs.** Every confirmation is the page's own `#modal`
(`openModal()` → a promise; `#modal-confirm` / `#modal-cancel`, Esc and a
backdrop click cancel), every notice a `toast()` in `#toasts` — a removal's
toast carries an **Undo** that calls `RESTORE_UNBLOCK { ts: undoTs }`. Tests
accept a confirmation by clicking `#modal-confirm`; `page.on("dialog")` no
longer sees anything. `confirmDelete()` adds a "Download a backup first"
button to the dialog, and "Delete everything" passes `requireText` so the
confirm stays disabled until `delete` is typed.

**Backup & data** (`#page-data`): `exportBackup()` writes
`{ format: "xrntube-backup", version: 2, channels, videos, allowlist,
keywords: { list, durMinSec, durMaxSec, commentLimit }, settings }` — the
blocklist from `GET_BLOCKLIST`, the rest read fresh from storage, `localOnly`
stripped, never the sync token. Import goes `importFile()` →
`buildImportPlan()` (an XrnTube backup of any version, a bare array of ids,
or the original BlockTube's `filterData` via `convertOldBlockTube()`) →
`previewAndImport()`, which shows a checkbox per part with its "new" count
(`countNewChannels()` uses the background's identity matching) and every
line in `plan.skipped` grouped by reason, then sends `IMPORT_BLOCKLIST` and
writes keywords / switches itself. The sub-count sweep then starts on its
own — an imported `UC…`-only channel blocks nothing in feeds until it has its
`@handle`. The danger zone is `DELETE_DATA` in its various shapes, plus
`deleteLookupFailures()`: `lookupFailures()` splits the channels the lookup
has *attempted* (`subsAttempted()`) into gone / failed / hiding-their-count,
and only the first two are pre-ticked. The import keeps an entry's
`subsAt`/`subsV` even when it carries no `subs` — a failed lookup has to
survive a backup round trip as "tried", or it is fetched again and never
lands in the failed group.

**Per-viewer preferences** — sort, the "hide under N subs" filter and the
thumbnail toggle — live in `localStorage` (`xt-blocklist-view`). The
**Show** filter deliberately is not remembered: reopening on "Hidden" and
seeing three rows out of five thousand reads as data loss.
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
pills are gone. Anything in the ⋯ menu (`#fetch-all-subs-btn`,
`#load-subs-btn`, `#clear-videos-btn`, `#clear-channels-btn`,
`#menu-export-btn`, `#menu-import-btn`, `#hide-small`) is `isHidden()` until
`#bl-menu-btn` is clicked, so a test that touches one must open the menu
first — the same shape as the row drawer holding **Hide from list**. The
real `#export-btn` and `#import-input` live on the Backup & data page.
Above the bar sit four `.stat` tiles (channels, videos, sub counts known as
a meter, combined subscribers — `renderStats()`) and the **quick-add** form
(`#quick-add` → `parseTargets()` → `IMPORT_BLOCKLIST`, then a sweep for the
new channels' names/identities and `fillVideoTitles()` via oEmbed);
`parseTargets()` refuses `/c/` and `/user/` links rather than guess. The
bar itself is `position: sticky`, and so is `#bulk-bar` under it. Lists
render `RENDER_CAP` (300) rows and then **grow** — `renderList()`'s
`#…-more` line carries "Show N more" / "Show all", stepping `shown[key]` by
`RENDER_STEP`. It is a cap, not a truncation: the whole blocklist has to be
reachable by scrolling, not only by guessing a search term. `resetShown()`
runs whenever the visible set changes (tab / search / sort) so a list never
opens mid-way down. Rows are **two lines**: the
channel/video name on its own, then a quiet `.row-meta` line carrying the
`@handle`/id, the subs chip, the block-mode badge and any "gone" tag —
a row gets scanned far more often than it gets acted on, and eight controls
competing on one line is what made the list unreadable. The right-hand
`.row-actions` column holds only **Delete** (`.unblock-btn`, with an Undo
toast) plus a **⋯** disclosure; ⋯ opens `.row-drawer`, which holds the mode
switch, **Hide from list** (`buildHideBtn` → `SET_ENTRY_HIDDEN`), **Copy
link**, and — for a video-only channel — **Open on YouTube** and the
whitelist/age editor. Open drawers and whitelist panels are tracked in
`openDrawers` / `openWhitelists` so a storage-triggered re-render doesn't
snap them shut under the cursor. Select mode (`selected` holds
`"c:<key>"` / `"v:<id>"`, so channels and videos mix) puts a `.row-check` on
every row, makes the row itself a hit target, and supports Shift-click
ranges; every bulk action is one message with `ids`. Because the actions column is fixed-width, the buttons
line up down the list instead of landing at a different x on every row. each section header has a
**Delete all** (and the ⋯ menu a "Clear all N blocked videos" /
"Delete all N channels" — `deleteAll()` → `DELETE_DATA`, one bulk write +
a tombstone per entry) with an undo entry in the **Recently removed**
`<details>` at the bottom; a
video-only channel's whitelist/age panel is a `<details>` inside that drawer,
so a page of them stays short. Channel rows show a subscriber-count
chip (`buildSubsChip` → `FETCH_CHANNEL_SUBS` for one, cached on the entry
**permanently** — there is deliberately no staleness window; see
[subscriber-counts.md](subscriber-counts.md)) and — once known — the channel's **`@handle`** in place of
the raw `UC…` id (a channel keyed by `@handle` shows no separate id line at
all; the `UC…` becomes a tooltip). `bulkFetchSubs()` only queues ids for the
background sweep (`START_SWEEP`); `renderSweep()` draws `#bulk-progress`
(text, a meter, `#bulk-stop`, "paused — YouTube is throttling" with the
resume time) from `bt_sweep`'s storage changes, the menu button doubles as
Stop, and a summary toast appears when a sweep this page watched ends. "Load sub counts"
(`#load-subs-btn`) does the rendered rows, "Fetch all sub counts"
(`#fetch-all-subs-btn`) the whole blocklist (resumable — skips channels
already attempted); a successful **import** starts the
whole-blocklist sweep by itself. `#sort-by`
(`sortBy`: recent / oldest / subs↓ / subs↑ / name — `subsToNumber()` parses
"1.2M"-style strings, unknowns sort last; **defaults to subs↓**, and the
`selected` attribute in `options.html` must track that default) and the
**"Hide under N subs"** view filter (`hideSmall` / `smallThreshold`, unknown
counts kept, in the ⋯ menu) narrow the channel list. The **"What gets hidden"** page
(`#settings-list`, `SETTING_GROUPS` → `renderSettings()`) renders the toggle
tree: one `.sgroup` card per group, a `.group-toggle` master in its header,
and one `.switch` per leaf. The master is **derived** — checked when every
leaf in the group is on, cleared when none are, `indeterminate` in between —
and clicking it writes every leaf in that group. No group state is stored, so
a master can never claim a group is on while a leaf inside it is off.
`#settings-search` filters by group and item text. Writes land in
`bt_settings` on every flip; it live-updates from `chrome.storage.onChanged`.
**Count contract:** `#settings-list .switch` is exactly the leaves (39, of
which 38 are checked by default) —
masters use `.group-toggle` precisely so they don't inflate it. Each switch
carries **`data-key="<setting>"`** and every test must select through it —
`nth(11)` and hand-maintained mirrors of the settings order are how adding a
setting silently re-points a test at the wrong switch, so the failure lands
on an unrelated assertion (adding `cleanChannelTabs` once made `layout2-test`
report "autocomplete did not return"). Adding a setting means: a leaf in
`SETTING_GROUPS`, the gating code in `content.js`, and the toggle-count
assertions in `settings` / `ui-hide` / `members` / `ux` / `layout2`. Those
tests' `setToggle()` takes a key **or an array of keys**, so a former coarse
toggle is flipped as its group of leaves. Also hosts the **Sync** card
(`#sync-card`, `initSync()`): the server address, user name and password,
Connect / "Sync now" / "Disconnect this device", and a status block from
`GET_SYNC_STATUS` (the server's host, the remote counts, last push and
pull). An empty password on an already-connected device keeps the saved one.
The options page never talks to the server itself — everything goes through
`SET_SYNC_CONFIG` / `SYNC_NOW` to `server-sync.js`. Each EXCEPT_WHITELIST channel row expands into a panel
(`buildWhitelistSection()`) with the whitelist editor (`extractVideoId()`
parses a URL or bare ID), the "only block videos older than N days" control
(`buildAgeRule()` → `SET_CHANNEL_AGE_RULE`), and a flip-to-FULL button.

## `shared/constants.js`

Holds the message-type enum, the storage keys (`STORAGE.BLOCKLIST_KEY`,
`TOMBSTONE_KEY` / `TOMBSTONE_TTL_MS`, `SYNC_KEY`), the sync timing block
(`SYNC.*` — poll period, push debounce), and the feature-toggle
contract — `SETTINGS_KEY` = `bt_settings`, `SETTING_GROUPS` (the two-level
toggle tree), `DEFAULT_SETTINGS` (39 leaf booleans derived from the tree —
all `true` bar the opt-in `blockInEmbeds`), `LEGACY_SETTING_MAP` and
`resolveSettings()`. Loaded as a plain script
everywhere (`importScripts` in the service worker, `<script src>` in HTML
pages, first entry in the manifest's `content_scripts.js` array) and
attaches to `self`.

## `shared/block-logic.js`

The verdict. Pure functions only — no DOM, no `chrome.*` — because the same
answer has to be reachable from the DOM scrub and from layer 0's questions:
`buildBlockIndex()` (the channel map plus the `@handle` / `UC…` side
indexes, blocked video ids, allow-list, and whether any entry has an age
rule), `lookupEntry()` / `isAllowedKey()`, `channelBlocks()` (the block-mode
semantics), `compileFilters()`, the locale-independent `parseAgeDays()` /
`AGE_UNITS`, `parseDurationSec()`, `normalizeChannelKey()`, and
`blockReasonFor()` which ties them together into one reason string.

It exists because the decision was about to be written twice. The DOM scrub
and the JSON filter look at completely different inputs — an element versus a
renderer object — but must reach the same verdict for the same video, or a
tile is hidden on one path and not the other and the two layers disagree
about what "blocked" means. **Layers may differ in what they can SEE; never
in what they DECIDE.** `content.js` holds exactly one `blockIndex` built here
and reads through it rather than caching pieces of it.

Loaded after `shared/constants.js` (it needs `CHANNEL_MODE`) and, like it,
only in the isolated world — see `content/page-hook.js` for why it must not
also be listed in the MAIN entry.

## Sync

One layer: the user's server, through `server-sync.js` (see that section and
[sync-server.md](sync-server.md)). `chrome.storage.sync` still carries the
small records — `bt_settings`, `bt_keywords`, `bt_allowlist` — between
Chrome profiles on one Google account, and the server merge carries keywords
and the allow-list too (whole-object LWW on their `ts`); the blocklist itself
is local and travels only through the server.

Merge is per-entry last-write-wins on `updated_at` with tombstones. It is
intentionally simple — conflicts are rare for one person with a few devices,
and the semantics are forgiving (re-adding an already-blocked entry is a
no-op; the worst case is a resurrected unblock, which the tombstone TTL
bounds). If a genuinely
robust multi-writer story is ever needed, that's a CRDT/vector-clock
rewrite, not a tweak here.
