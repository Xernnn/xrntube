# Blocking rules

What "blocked" actually means: the two channel modes, the age rule, the
keyword/duration filter, the allow-list override, and how a channel is
identified in the first place. See also
[subscriber-counts.md](subscriber-counts.md) (the enrichment that makes
cross-format matching work) and [architecture.md](architecture.md).

## Channel block modes

A blocked-channel entry is `{ name, ts, updated_at, localOnly, mode, whitelist,
blockOlderThanDays?, hidden?, subs?, subsAt?, handle?, ucid?, gone? }` (a video entry
is `{ title, ts, updated_at, hidden? }`). `mode` is from
`BlockTube.CHANNEL_MODE` (`shared/constants.js`):

- **`FULL`** (the default, and what every entry predating this field
  implicitly is — `channelBlocks()`/DNR treat a missing `mode` as `FULL`):
  the channel's own page is gone (network-level DNR redirect) and every
  tile/video/playlist of theirs is removed everywhere, no exceptions.
- **`EXCEPT_WHITELIST`**: the channel's own page and its non-video tiles
  (its own channel card, "Channels" tab entries, etc.) are deliberately left
  alone — no DNR rule is generated for the channel URL at all (see
  `rebuildDnrRules()` in background.js) — but its *videos* are blocked
  except the IDs in `entry.whitelist` (`{ [videoId]: title }`, managed via
  `MSG.WHITELIST_CHANNEL_VIDEO`/`UNWHITELIST_CHANNEL_VIDEO`, or flipped
  wholesale to/from `FULL` via `MSG.SET_CHANNEL_MODE`). If
  `entry.blockOlderThanDays > 0` (set via `MSG.SET_CHANNEL_AGE_RULE`), only
  videos older than that are blocked — recent uploads pass, whitelist still
  wins. In feeds/search/recs the age rule needs a tile with a channel byline
  **and** a parseable relative publish date; the channel's own `/videos` tab
  tiles have neither byline nor (for age) always a relative date, so
  **`scrubOwnChannelPage()`** handles that surface separately: when
  `normalizeChannelKey(location.pathname)` resolves to a blocked entry it
  treats *every* video tile on the page as that channel's and runs
  `channelBlocks()` on it (whitelist + age honoured), and removes *every*
  playlist tile outright (`info.isPlaylist` — a playlist has no publish
  date, so it goes for any mode incl. age-ruled). A companion
  `<style id="bt-channel-page-hide">` (`updateChannelPageHideCSS()`, scoped
  `ytd-browse[page-subtype="channels"]`) has two clauses — the video/short
  grid (`:not(:has())` the whitelisted IDs, skipped for age-ruled channels
  since CSS can't do dates) and a playlist clause (`:has(PLAYLIST_LINK_SEL)`,
  always). Wired into `scheduleExtrasScrub()`, `yt-navigate-finish`, and both
  blocklist-load paths; the style clears itself when you navigate off the
  channel page. Date parsing (`parseAgeDays()`) is
  language-independent (`AGE_UNITS`, ~15 languages — see "UI-language
  labels").

  **`currentPageAgeDays()` answers "how old is the video on this page", and a
  wrong answer is a false bounce off a video the user is entitled to watch.**
  It used to fall back to `document.body` whenever the watch metadata had not
  mounted yet — and `document.body.textContent` **includes the contents of
  `<script>` tags**: measured live, ~807KB of YouTube's inline JSON against
  ~36KB of real text. Something in that JSON always matches "<number> <unit>
  ago", so the age came back as **5.1e26 days**, greater than any threshold, and
  an age-ruled channel therefore bounced you out of *every* video — including
  one published 18 hours ago under a 365-day rule. That is the "it throws me out
  even for a video that isn't in the blocked window" bug.

  So: read `<meta itemprop="datePublished">` first — exact, ISO-8601 and
  locale-proof, where the visible line says "16 Sept 2026" in en-GB and
  something else again per UI language (the English `Sep 16, 2026` fallback
  regex never matched it). Then a short, ordered list of *narrow* scopes
  (`ytd-watch-info-text`, `#info-container`, `ytd-watch-metadata`,
  `#above-the-fold`) — **never `document.body`**. Every result, here and in the
  tile path, goes through `plausibleAgeDays()` (−1 … 100 years): a value outside
  that is not an age, it is a parse bug, and it must read as *unknown*. Unknown
  means `null`, and `channelBlocks()` does not block on null — the 2s heartbeat
  re-checks once the real metadata mounts. `age-test` asserts both directions on
  the watch page, since a rule that blocks everything and a rule that blocks
  nothing both look like "working" from one side. `extractInfo()` only reads the date when `anyAgeRule` is true
  (some blocked channel has the field), so the common case pays nothing.

Other per-entry fields (channels *and* videos): `hidden` — a pure
options-UI flag (`MSG.SET_ENTRY_HIDDEN`); the entry stays fully blocked,
it's just filtered out of the blocklist manager unless the "Hidden" tab is
active. `subs` / `subsAt` / `handle` (channels only) — the scraped
subscriber-count string, when it was fetched, and the channel's `@handle`.
`scrapeChannelInfo()` in the background fetches a page belonging to the
channel (no API key) and reads the sub count, `@handle`, name and UC id out of
**the channel's own `pageHeaderRenderer`** — see [subscriber-counts.md](subscriber-counts.md), which is the whole story and not a detail. It streams the
response and stops ~12KB past that header, and reports a 429 so the caller can
back off. Entries carry `subsV` (`SUBS_SCRAPE_VERSION`), the generation of the
scrape that produced the number, so a change of source re-fetches once and
then never again. `applyChannelInfo(map)` writes a whole batch of
results with one storage write. `MSG.FETCH_CHANNEL_SUBS` (one channel) and
`MSG.BULK_FETCH_CHANNEL_INFO` (a batch, fanned out 8-wide) both go through
it — **neither calls `broadcastUpdate`** (this metadata is cosmetic: content
scripts and DNR don't use it), so a big sweep isn't N × DNR-rebuilds; the
options page repaints from `storage.onChanged` and pushes to the gist once
at the end via `SYNC_NOW`. All of these fields ride the gist sync
automatically as extra keys on the entry.

## `channelBlocks()` — the single decision function

`content/content.js`'s `channelBlocks(entry, videoId, ageDays)` is the
single source of truth both the DOM scrub (`isBlocked()`) and the navigation
guards (`checkCurrentPageAndRedirect()` — which computes `ageDays` via
`currentPageAgeDays()` — and `yt-navigate-start`) call through — pass
`null` for videoId to get "does this mode block the channel itself", a real
video ID (+ optional `ageDays`) to get "does this mode block this specific
video". The instant-hide CSS layer
mirrors this exactly in `updateInstantHideBlocklistCSS()`: an
`EXCEPT_WHITELIST` channel gets its own `:has(channelLink):has(a[href*="v="],
a[href*="/shorts/"]):not(:has(whitelistedLink...))` rule (one clause per such
channel, since each has a different whitelist) rather than joining the
single shared "hide if it has any of these links" rule used for `FULL`
channels and individually-blocked videos (that shared rule's `:is()` also
includes `POST_SELECTOR`, so a FULL channel's community posts fall to it for
free). The `:has(a[href*="v="], ...)` clause is deliberate — it keeps a
soft-blocked channel's own card (no video link) out of the *video* rule. A
soft channel additionally gets, regardless of any age rule, one clause each
for its playlists (`PLAYLIST_TILE_TAGS`, or a lockup `:has(PLAYLIST_LINK_SEL)`)
and its posts (`:is(POST_SELECTOR):has(channelLink)`) — soft channels are
few, so the extra clauses are cheap; FULL channels get playlists/posts from
the shared rule and cost nothing extra. The age-ruled soft channel still
gets **no** *video* clause (CSS can't do date math) — the JS scrub handles
that alone.

## Title-keyword and duration filters

`chrome.storage.sync` key `bt_keywords` =
`{ list: [{ p, re }], ts, durMinSec, durMaxSec }`. A video is scrubbed if
its title matches any pattern **or** (when either bound is > 0) its duration
badge is shorter than `durMinSec` / longer than `durMaxSec`. `content.js`
compiles the patterns in `applyKeywords()` (loaded alongside `bt_settings`,
live via `chrome.storage.onChanged`) into `keywordMatchers`; `blockReason()`
(the single function `isBlocked()` delegates to — it returns a *string* so
the debug log and the real decision can't drift) and the nav guard's
`matchesFilter()` check both. `anyFilter()` gates the work: `extractInfo()`
only reads the duration badge (`readDurationSec()` — scans the
time-status/duration badges specifically, ignoring "4K"/"New") when a bound
is set, only reads the title from `#video-title` when a keyword exists.
**JS-scrub only** — CSS can't match text or parse a badge — so there's a
one-frame window vs the `:has()` layer.

**The hydration trap — this silently disabled the length filter entirely.**
`processRenderer()` marks a tile `data-bt-checked="1"`, and a checked tile is
*never looked at again*. YouTube mounts the tile before its title and its
duration badge, so marking it checked too early doesn't delay a filter, it
turns the filter off. Only the *title* case was treated as pending, so every
tile got locked in before its badge arrived and `durMinSec`/`durMaxSec` did
nothing at all on a normal page load (confirmed live: 13 of 13 under-bound
videos survived). Both are pending now, `recheckHydratingTiles()` re-processes
them, and its query includes **`LOCKUP_SELECTOR`** — leaving that out meant
modern search tiles were never re-examined either, which also weakened the
keyword recheck. `REHYDRATE_MAX_TRIES` bounds the retries so a live stream —
no duration, ever — isn't re-read for the life of the page; size it against
the **2s heartbeat**, not the ~400ms throttle, because the throttle only fires
on DOM mutation and a settled page is driven by the heartbeat alone (at 8
tries ≈ 16s a 2½-hour video still slipped through). The options **Keywords** page
tab edits both (title list + a "Block videos by length" block). The gist
merge carries the whole `keywords` object as last-write-wins on `ts`;
`kwFingerprint()` (list + duration bounds, ts excluded) in `sameBlocklist()`
is what makes a duration-only edit still push.

## Channel allow-list ("Never-block")

`chrome.storage.sync` key `bt_allowlist` =
`{ list: { [channelKey]: { note?, ts } }, ts }` — a hard override that beats
*every* block path: a direct block, a collaborator block, a keyword/duration
filter, an age rule, and the DNR channel-page redirect. `@handle` keys are
stored lowercased. Background owns the writes (`MSG.ALLOW_CHANNEL` /
`DISALLOW_CHANNEL` → `setAllowed()`); it's carried in the `GET_BLOCKLIST` /
`BLOCKLIST_UPDATED` payload and also read live by `content.js` via
`chrome.storage.onChanged`. `content.js` builds `allowSet` and short-circuits
in `blockedEntryFor()` (returns `undefined` for an allow-listed key — covers
the nav guards and `scrubOwnChannelPage`), at the top of `blockReason()`
(covers keyword/duration), in `checkCurrentPageAndRedirect()`, and skips the
channel's clause in `updateInstantHideBlocklistCSS()`. `background.js`
excludes allow-listed keys from `rebuildDnrRules()`. `gist-sync.js` syncs it
exactly like `keywords` (LWW on `ts`, `allowFingerprint()` in
`sameBlocklist()`). Options **Never-block** page tab + a "Never-block"
button in the bulk-select bar manage it. A DOM node already deleted before a
channel was allow-listed only reappears on YouTube's next re-render (same as
unblocking) — the allow-list is not retroactive within a paint.

## Playlists and community posts

`extractInfo()` sets `info.isPlaylist` (the tile matches `PLAYLIST_TILE_TAGS`
or carries a `PLAYLIST_LINK_SEL` link — `list=PL…/UU…/OL…/FL…`, not
auto-`RD…` mixes). `blockReason()` then returns "blocked" for a playlist
tile as soon as *any* channel on it resolves via `blockedEntryFor()` —
regardless of block mode or age rule, since a playlist has no single date.

Community posts are **not** tiles (`RENDERER_SELECTOR` doesn't list them) —
`POST_SELECTOR` (`ytd-backstage-post-thread-renderer` + friends) gets its
own `processPost()` / `scrubPosts()` path: any `/@` or `/channel/UC` link in
the post that resolves to a blocked entry (and none allow-listed) removes
it, marking `data-bt-post="1"` when clear (cleared on `BLOCKLIST_UPDATED`
and an allow-list change, like `data-bt-checked`). `scrubPosts()` is in the
`sweep()` hot path (home-feed posts) and the `scheduleExtrasScrub()` /
`runExtras()` / `yt-navigate-finish` backups. A `/post/…` permalink is
covered by `findScopeForCurrentPage()` picking up the post's author for
`checkCurrentPageAndRedirect()` (FULL bounces; soft strips in place).

## Comments by a blocked channel

Comments are neither tiles (`RENDERER_SELECTOR`) nor community posts
(`POST_SELECTOR`), so for a long time they were handled nowhere at all: you
could block a channel and still meet its comments under every video you
watched, which is the most visible way "blocked" stops meaning blocked.

`scrubComments()` removes a whole `ytd-comment-thread-renderer` when the
**top-level** comment's author is blocked, and judges each reply inside
`ytd-comment-replies-renderer` individually. `querySelector` is document
order, so the first `ytd-comment-view-model` inside a thread is the top-level
comment — replies sit deeper.

Two rules that matter more than the mechanics:

- **Only the author link decides** (`#author-text`). A comment that merely
  *@mentions* a blocked channel must survive — that is someone else talking,
  and removing it is the same class of false positive as matching `@mkbhd`
  against `@mkbhd508` (two different channels; the audit that first "found"
  a channels-tab leak was itself doing a substring match, and the leak wasn't
  real).
- **FULL blocks only**, via `channelBlocks(entry, null)` — the same "does this
  mode block the channel itself" question the nav guards ask. Video-only mode
  means "keep the channel, drop its videos", so its comments stay.

It runs in the throttled `runExtras()` batch, not the per-mutation hot path:
a watch page carries 60+ comment threads, and `scrubPosts()` is only in the
hot path because posts are rare. Processed comments are marked
`data-bt-comment="1"` so later passes are cheap, and that mark is cleared on
`BLOCKLIST_UPDATED` and on an allow-list change, exactly like
`data-bt-checked` / `data-bt-post`.

## Channel identity

A channel is keyed either by its canonical ID (`UCxxxxxxxxxxxxxxxxxxxxxx`,
stored without the `channel/` prefix) or by its `@handle`, whichever format
appears in the DOM link being inspected (`normalizeChannelKey()` in
`content/content.js`). The storage key stays whatever was captured, but the
scrub **does** cross-reference now: `applyBlocklist()` builds two side
indexes — `blockedByHandle` (from each entry's own `@handle` key *and* its
scraped `entry.handle`) and `blockedByUcid` (from each entry's own `UC…` key
*and* its scraped `entry.ucid`) — and every lookup goes through
`blockedEntryFor(key)`, which tries the raw key, then the lowercased handle,
then the UC id. This matters because **modern YouTube feed/search tiles link
the channel byline via `/@handle`, not `/channel/UC…`** — a `UC…`-keyed entry
(e.g. everything in an imported old BlockTube list) blocks *nothing* in feeds
until its `entry.handle` is populated by the "Fetch all sub counts" sweep
(`scrapeChannelInfo` grabs `subs` + `handle` + `name` + `ucid`). The
`updateInstantHideBlocklistCSS()` `:has()` rules likewise emit
`a[href="/@handle" i]` / `a[href="/channel/<ucid>"]` when known. So: **an
imported `UC…` list must be enriched to actually block** — the post-import prompt says so, and a
bulk enrich ends with `REBROADCAST_BLOCKLIST` so open tabs pick up the new
handles without a reload.

**A tile links exactly one of the two identities, and which one depends on the
surface.** Measured live on search results: **20 of 20** tiles carried
`/@handle` and none carried `/channel/UC…`. So an entry that knows only the
identity it was stored under is invisible on any surface that uses the other —
this is what "I blocked them and their videos are still in my search results"
actually is, and it runs in *both* directions, not just for imported `UC…`
lists. The options page's one-line "N may not block everywhere yet · Resolve"
note therefore counts a `UC…`-keyed entry with no `handle` **and** an
`@handle`-keyed entry with no `ucid`. Its gate is `subsAttempted()`: an entry
the current scrape has already looked at and still couldn't pair is a dead end,
and nagging about it forever is noise. (It used to use a 7-day "scraped
recently" window, which meant a sweep that resolved nothing left the page
claiming there was nothing left to resolve.) Blocking directly from a channel's own page (via
the popup) still captures the format the page shows.

`MSG.BLOCK_CHANNEL` now resolves the *other* identity itself:
`enrichChannelIdentity()` scrapes the channel once, fire-and-forget (the
block must not wait on the network), and rebroadcasts — so a channel blocked
by `@handle` also blocks `/channel/UC…` (and gets a DNR rule for both, see
`rebuildDnrRules()`) without waiting for a sub-count sweep. It is
best-effort: offline, rate-limited, or a service worker torn down mid-fetch
just leaves the entry keyed as it was, and `pageIdentityKeys()` in
`content.js` still bridges the formats from the page's own metadata.

**Identity parsing is a trap.** `parseChannelHtml()` must take the UC id and
handle only from sources that describe *the page itself* — `<link
rel="canonical">`, `<meta itemprop>`, `"externalId"`, `"vanityChannelUrl"`.
A channel page embeds shelves of other people's videos, each carrying its
own `"channelId"` / `"canonicalBaseUrl"`. Leading the match list with the
ambiguous keys therefore recorded a **stranger's** UC id on the entry — which
then cross-indexed the blocklist and generated a DNR redirect against an
innocent channel. `verifyChannelInfo()` is the backstop: if a fetch of
`/@foo` comes back claiming a different handle, the handle and ucid are
dropped (subs/name, being cosmetic, are kept).
