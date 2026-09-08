# BlockTube

A browser extension that actually removes blocked YouTube channels and videos —
not a "blocked" placeholder tile, the element is deleted from the page — from
your home feed, search results, and recommendations. Works on Chrome, Edge,
Brave (Chromium) and Firefox, including Firefox for Android.

## How it works

- **Feeds/search/recommendations** — two layers, both aimed at never letting
  a blocked tile actually get painted:
  1. A `<style>` tag built from your blocklist uses the CSS `:has()`
     selector to hide any tile containing a blocked channel/video link —
     this is matched continuously by the browser's own style engine as part
     of normal layout, not by extension JS reacting after the fact, so it
     applies before the tile is ever visible even in a burst of fast-loading
     search results.
  2. A content script watches the page with a `MutationObserver` and
     actually deletes the matching element outright — this is what makes it
     truly gone (not just hidden) and is also the fallback for a browser
     without `:has()` support.
- **Direct navigation** (typed URL, bookmark, external link) — a
  `declarativeNetRequest` rule redirects the request to youtube.com's home
  page at the network layer, before YouTube even renders the page.
- **In-app navigation** (clicking a recommendation without a full page load)
  — YouTube's own `yt-navigate-start` event is intercepted and blocked
  destinations are bounced back to the home page.
- **Blocking UI** — hover any video tile for a 🚫 button (block video or
  block its channel in one click), or use the toolbar popup on a video/channel
  page, or manage everything from the full options page.
- **Sync** — the blocklist lives in `chrome.storage.sync`, chunked across
  several keys to stay under the 8KB-per-item / 512-item sync quota. If you
  ever hit that ceiling, new blocks fall back to local-only storage
  automatically (flagged in the options page) instead of failing.

## ⚠️ Important: sync only bridges browsers of the same vendor

`chrome.storage.sync` rides on **your browser's own account sync** — Chrome
sync (Google account) or Firefox Sync (Firefox account). It does **not**
bridge across vendors. Concretely:

- Chrome desktop ↔ Chrome/Edge/Brave elsewhere, same Google account: **syncs**.
- Firefox desktop ↔ Firefox for Android, same Firefox account: **syncs**.
- **Chrome desktop ↔ Firefox for Android: does NOT sync** — they're
  different sync systems entirely.

Since Firefox for Android is the realistic way to get this onto a phone
(Chrome and Safari mobile don't support extensions at all), if your desktop
browser is Chrome you have these options:
1. **Connect a private GitHub Gist** (below) — automatic, free, works across
   every browser. Recommended.
2. Also use Firefox on desktop (then both ends sync via your Firefox account).
3. Use the options page's **Export/Import JSON** to carry your list over by hand.

## Sync across any browser (GitHub Gist)

The options page has a **"Sync across any browser"** card that bridges the
vendor gap using a single private GitHub Gist as the store — no server, no
hosting, free.

1. Create a [fine-grained personal access token](https://github.com/settings/tokens?type=beta)
   with **only** "Gists → Read and write" access (no repo access, no other
   scopes). An expiry is fine; you'll just re-paste it when it lapses.
2. Paste it into the Sync card (Sync tab) on **each device** and click
   **Connect**. The first device creates the gist (named
   `blocktube-blocklist.json`, private); every other device you paste the
   *same token* into finds it and pulls the list. After connecting, the card
   shows how many channels/videos are in the gist and links to it, so you can
   confirm it uploaded before moving to the next device.

From then on it's automatic: every block/unblock pushes within a few
seconds, and each device pulls every few minutes (there's no instant
push, so a change shows up on your other devices after the next poll).
Merging is last-write-wins per entry, and unblocks are tracked with
tombstones so a stale device can't re-add something you removed — timestamps
come from GitHub's clock, not your devices', so clock skew can't corrupt a
merge. The token lives only in this browser's local storage and is never
itself synced. **Disconnect this device** stops syncing here without
touching your blocklist.

Anyone with the token can read and write your gists, so treat it like a
password; if it leaks, revoke it on GitHub and paste a fresh one.

## Install on desktop

**Chrome / Edge / Brave**
1. Go to `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Enable "Developer mode".
3. Click "Load unpacked" and select this folder.

**Firefox**
1. Go to `about:debugging#/runtime/this-firefox`.
2. Click "Load Temporary Add-on…" and select `manifest.json` in this folder.
3. Note: temporary add-ons are removed when Firefox restarts. For a
   permanent local install, package it (`web-ext build`) and self-sign, or
   submit it to addons.mozilla.org (works fine as an *unlisted* add-on — no
   public review needed, just Mozilla's automated signing).

For development there are npm scripts: `npm run lint:firefox` (web-ext lint),
`npm run run:firefox` (launch Firefox with it loaded), `npm run build:firefox`
(package a `.zip`). They need a local Firefox binary.

## Install on Firefox for Android

Stable Firefox for Android only runs extensions that came through
addons.mozilla.org's signing (no raw sideloading of an unpacked folder like
on desktop). The practical path:

1. Install the [`web-ext`](https://github.com/mozilla/web-ext) CLI (`npm i -g web-ext`).
2. From this folder: `web-ext sign --api-key=... --api-secret=...` using a free
   [AMO API key](https://addons.mozilla.org/developers/addon/api/key/) — this
   uploads the extension as an **unlisted** add-on and returns a signed `.xpi`.
3. Open the signed `.xpi`'s AMO link on your phone in Firefox for Android and
   tap install, or `adb push` the `.xpi` and open it locally.

(Mozilla's exact Android extension policy has shifted a few times — if a step
above doesn't match what you see, check the current instructions at
`extensionworkshop.com` before assuming something's broken.)

## Block videos by title keyword or length

The **Keywords** tab in the options page takes a list of words or phrases —
any video whose title contains one is removed from feeds and search (and
bounces you out if you open it directly). Tick *regex* on a row to treat it
as a regular expression. Matching is case-insensitive. This runs just after
a tile appears (a hair slower than the channel/video blocking, which hides
before paint). Keywords sync like the blocklist.

The same tab has a **Block videos by length** block: set a minimum (in
seconds) and/or a maximum (in minutes) and any video whose duration badge
falls outside that range is removed too — handy for cutting Shorts-style
clips or multi-hour streams. Leave a field blank for "no limit". These sync
with the keyword list.

## Two ways to block a channel

Every place you can block a channel from (the hover menu on a tile, and the
popup) offers both:

- **Block channel** — the harsh option. Nothing from this channel exists
  anymore: its own page redirects to Subscriptions, and every video/playlist
  of theirs is removed everywhere.
- **Block all videos (allow some later)** — the softer option. The channel's
  own page stays reachable and its non-video tiles (its channel card in
  search, "Channels" tab entries, etc.) stay visible — but every one of its
  videos is blocked except whichever ones you explicitly whitelist. Manage
  that whitelist from the options page: each channel blocked this way gets
  an expandable panel listing its allowed videos, plus a box to paste a
  video URL (or bare 11-character ID) to add another exception. You can also
  flip an already-blocked channel between the two modes from there at any
  time.

This only applies to channels — a directly-blocked video (via "Block this
video") has no such distinction, since there's nothing softer than blocking
one specific video.

### "Only block videos older than N days"

For a channel blocked with **Block all videos**, its options-page panel has
an *"Only block videos older than [N] days"* toggle. Turn it on and only that
channel's back catalogue is hidden — uploads from the last N days stay
visible (and any video IDs you've whitelisted always stay). Good for a
channel you want to keep half an eye on without its entire history in your
feed. In feeds/search/recommendations the age rule needs a tile with a
channel name and a "3 days ago"-style date; on the **channel's own page**
(Videos / Streams / Home tabs) the tiles have no byline, so BlockTube handles
that page specially — visiting a "block all videos" channel now empties its
video grid too (whitelisted videos still show; the age rule is applied there
as well). The "N days ago"-style date is read in ~15 languages; the
absolute-date fallback on a watch page ("Jan 5, 2024") is English-only.

## Never-block list

The **Never-block** tab is a hard allow-list. Anything from a channel on it
stays visible even if a title keyword, a length rule, an age rule, a
collaborator block, or a direct block would otherwise hide it — and its own
page stops redirecting. Add a channel by `@handle`, `UC…` ID, or a full
channel URL. Use it for a channel you've swept up in a broad rule but want
back, without having to unpick the rule. It syncs with everything else.
(A tile that was already removed before you allow-listed the channel comes
back on YouTube's next re-render, not instantly.)

## Managing a big blocklist

The options page has five top-level tabs — **Blocklist**, **Keywords**,
**Never-block**, **Settings**, and **Sync** — so the keyword list, allow-list,
feature toggles and the GitHub-Gist setup aren't in the way of the list. It
opens on whichever you used last.

Within **Blocklist**, **filter tabs** — All / Full-blocked channels /
Video-only channels / Blocked videos / Hidden — narrow the view, and up to
300 rows show per section (narrow further with the search box). A one-line
summary above the list breaks the blocklist down by mode and shows the total
subscriber reach it's hiding. A video-only channel's whitelist/age-rule
panel is collapsed until you click it. There's a **Clear all N blocked
videos** button that unblocks every video at once (channels untouched), and a
**Recently unblocked** list under it with a **Restore** button — so an
accidental unblock, or that mass-clear, can be undone.

**Select** (top-left of the channel controls) turns on checkboxes: tick a
few channels — or **Select all shown** — and a bar appears to **Hide**,
switch to **Video-only mode**, add to **Never-block**, or **Unblock** the
whole selection at once.

Each row has:

- **Hide** — takes the row out of the manager without unblocking it, for
  entries you've reviewed and don't want to keep scrolling past. The
  **Hidden** tab shows them again, with **Unhide**.
- **Subscriber count + @handle** (channels) — click the chip to scrape one,
  **Load sub counts** for the channels currently shown, or **Fetch all sub
  counts** for the entire blocklist. The same pass fills in each channel's
  real name and its **`@handle`**, which is **required for blocking** a
  channel imported as a `UCxxxx…` id: YouTube's feed and search tiles link
  the channel by `@handle`, so a `UC…`-only entry matches nothing until the
  handle is known. So after importing an old blocklist, **run this to
  completion** — it's offered automatically right after the import, runs
  several at a time with a Stop button, and resumes where it left off. Once
  a handle is known the row shows `@handle` instead of the raw id (id kept as
  a tooltip), and a channel already keyed by `@handle` drops its id line.
  Scraped from the channel page, no API key; hidden counts and layout
  changes just show "n/a".
- **Sort** the channel list by newest-blocked, subscriber count (either
  direction), or name. Channels with no count yet sort to the end.
- **Hide channels under N subs** (default 10,000) — a view filter, not a
  block change; channels whose count you haven't fetched yet stay visible.

Clicking the YouTube logo now goes straight to your Subscriptions feed
instead of bouncing through the (redirected) home page.

## Collab channels and playlists

- **Channel collaborations** — when a video credits more than one channel
  (YouTube's multi-channel/collab attribution), every distinct channel link
  found on the tile or watch page is checked, and blocking works from any of
  them — not just the primary uploader. The hover-block menu and the popup
  both list one "Block channel: X" entry per channel found.
- **Playlist tiles** — playlist and mix cards (`ytd-playlist-renderer`,
  `ytd-grid-playlist-renderer`, `ytd-compact-playlist-renderer`,
  `ytd-radio-renderer`, and their `ytm-*` equivalents) are swept the same way
  video tiles are, so a playlist made by a blocked channel disappears from
  feeds/search too.
- **Inside an open playlist** — individual blocked videos are removed from
  the playlist listing and from the "up next" playlist panel/queue.
- **Direct link to a blocked video or a blocked channel's playlist** —
  `declarativeNetRequest` can only match on exact video IDs or exact channel
  *page* URLs; it has no way to know "this video's uploader/collaborator is
  blocked" or "this playlist belongs to a blocked channel" from the URL
  alone (a `/watch?v=` or `/playlist?list=` URL doesn't carry channel info).
  The content script closes that gap: after the page renders its own
  metadata (on first load and after every in-app navigation), it re-checks
  the video/playlist's actual channel(s) and bounces to Subscriptions if any
  are blocked. There can be a brief flash before that check runs, unlike the
  instant network-level redirect for exact video/channel-URL matches.
  Playlist tiles specifically can also mount their channel byline a moment
  *after* the tile itself — the content script re-checks a tile whenever
  something new lands inside it, so a late-arriving byline still gets caught
  instead of the tile being marked "already checked" too early.

## Home, Shorts, and the side recommendations are gone entirely

These aren't blocklist features — they apply regardless of what
channels/videos you've blocked. Each is a **toggle** in the options page's
*"What this extension changes"* card (all on by default), so you can keep the
ones you want and turn the rest off. Toggle changes sync across your browsers
like the blocklist; some take effect on the next page refresh.

Blocking channels and videos is not toggleable — it's the point of the
extension.

- **Homepage** — `https://www.youtube.com/` (and `m.youtube.com/`) redirects
  straight to your Subscriptions feed, both for a fresh/typed visit (network-
  level `declarativeNetRequest` redirect, no flash) and for in-app navigation
  (clicking the YouTube logo, etc.).
- **Shorts** — removed everywhere: shelves on the home feed and in search,
  individual shelf tiles, and the full-screen Shorts player itself. Opening a
  Shorts URL directly, clicking a Shorts link, or scrolling onto one in the
  vertical feed all redirect to Subscriptions instead.
- **The "up next" / related list beside the video** — the whole column next
  to the player is removed (not just its contents), and the player grows into
  the freed space with no leftover right-side gap — but only up to the point
  where the player *and* the video title still fit on screen without
  scrolling (going fully edge-to-edge made the player taller than the window
  on wide monitors). The page is also stopped from scrolling sideways, which
  otherwise made the arrow keys pan the whole layout instead of seeking.
- **The end-screen "suggested videos" overlay and in-player teaser cards** —
  the grid of suggested videos that covers the player once a video finishes,
  and the small clickable cards that can pop up mid-playback, are both
  deleted outright as soon as they mount (and hidden instantly via CSS
  before that).
- **Sidebar nav clutter** — Home and Shorts are matched and removed by their
  link (`href="/"` / `href="/shorts"`), which is more durable than matching
  by tag name; "Explore", "More from YouTube", and "Report history" don't
  have one stable link each, so those are matched by their visible label
  instead. The small-print link list + copyright line at the bottom of the
  sidebar is removed too. Subscriptions and your library stay, since you
  still need those to navigate.
- **Masthead** — the Create (+) and Notifications (bell) buttons are removed
  from the top bar.
- **Voice search** — the microphone "Search with your voice" button next to
  the search bar is removed.
- **Search autocomplete** — the dropdown of suggested/trending searches that
  appears while you type in the search box is hidden.
- **Account button** — your avatar in the top-right corner is faded out; move
  the mouse to that corner and it reappears.
- **Video action buttons** — on a watch page, Share, Save, Download, Clip and
  the "⋯" more menu (where Report lives) are removed. Like/Dislike and
  Subscribe stay.
- **Channel memberships** — the "Join" button, members-only videos and
  shelves wherever they show up, and the Membership tab on channels are all
  removed.

## Search-result channel cards, empty shelves, and Shorts

- **A blocked channel's own card in search results** is now deleted like any
  other tile (previously it stayed visible and only bounced you home if you
  clicked it — search results didn't include the channel-card element types
  in the removal list yet).
- **Empty shelves** — rows like "Latest from [channel]" or a Shorts shelf can
  end up with every tile inside them removed, leaving just the header
  floating with nothing under it. Once a shelf runs dry it's removed
  entirely (after a ~1s grace period, in case YouTube was still lazily
  loading more tiles into it).
- **Shorts** are removed unconditionally now (see "Home, Shorts, and the side
  recommendations are gone entirely" above) — not just from blocked channels.

## What's actually been tested against live YouTube

There's now a real end-to-end test suite in `test/` — each file launches
Chromium with this extension loaded, drives live youtube.com, and asserts on
what the content script did. Run it with `npm test` (needs `npm install`
once for Playwright, and outbound network). `test/README.md` has the
details. It covers the blocklist, all 12 toggles, channel identity /
enrich, the age + keyword + duration filters, the never-block list, the
watch-page layout, and the options UI; `locale-age-test.mjs` checks the
"…ago" date parser in 13 languages without a browser. Not covered:
signed-in surfaces (masthead Create/Notifications, real Subscriptions),
Firefox, `m.youtube.com`.

Everything above was originally written without ever loading the extension
in a real browser. A chunk of it has since been verified against the real
site (Chromium, loaded with this extension, not signed into any account) —
that's how the bugs below were actually found, not guessed:

- **Confirmed and fixed:** the sidebar's Home/Shorts removal (YouTube's real
  Shorts link is `/shorts/`, with a trailing slash — the original code
  looked for `/shorts` and never matched), the "Explore"/"More from
  YouTube"/"Report history" removal and the sidebar footer removal, and —
  the biggest one — **a blocked channel's playlists were still showing up
  because YouTube has migrated playlist tiles (on a channel's own Playlists
  tab, and in search) to a new `yt-lockup-view-model` component that shares
  nothing with the old tags this extension was looking for.** All three are
  fixed now and re-verified live. The watch-page layout reflow (the player
  column expanding into the space the related-videos column used to take)
  were also checked visually and look right. The block button has since
  moved again, to the bottom-right corner (see "Known limitations" below) —
  that specific placement hasn't been re-verified live yet.
- **Second pass, same method:** the Shorts shelf that appears *in search
  results specifically* turned out to use yet another, different component
  (`ytm-shorts-lockup-view-model-v2` inside a `grid-shelf-view-model`
  container) than the one already handled elsewhere — fixed and re-verified:
  a real search page for a Shorts-heavy query went from multiple visible
  Shorts shelves to zero remaining Shorts tiles anywhere in the DOM. This is
  also when the CSS `:has()` instant-hide layer above was added, directly in
  response to "can this intercept before anything renders" — the underlying
  `:has()` mechanism was isolated and confirmed to work correctly on a
  synthetic test element, and the full pipeline (blocklist → generated CSS →
  hidden tile) was confirmed end-to-end on a live search results page.
  Actually proving the *specific single frame* where a real tile is
  CSS-hidden but not yet JS-removed is inherently hard to capture from the
  outside (it's a sub-16ms window); what's verified is that each half of the
  mechanism works correctly on its own.
- **Not verified:** the masthead's Create/Notifications removal (both only
  render when signed into a YouTube account, which this testing setup
  doesn't have and won't fake), Firefox, and `m.youtube.com`/mobile, and the
  "a blocked channel's video occasionally still appears in search" report —
  investigated (checked whether search sometimes renders plain videos via
  the new `yt-lockup-view-model` too — confirmed it does, and that case is
  already handled) but nothing reproduced the "occasionally" gap directly.
  If it happens again, the search query plus a screenshot or the tile's
  markup (right-click → Inspect) would let this get chased down properly
  instead of guessed at.

## Known limitations / things to tune

- Channel identity is captured from whatever link format YouTube shows in
  that specific tile (`/channel/UC…` or `/@handle`) — the two aren't always
  cross-referenced, so on rare occasions the same channel shown via a
  different link format could slip through once. Blocking from the channel's
  own page (via the popup) is the most reliable capture.
- `m.youtube.com` (what Firefox Android may show) uses different element
  names (`ytm-*`) than desktop YouTube. Selectors for those are included but
  less battle-tested — if tiles aren't being removed there, the `ytm-*`
  selectors in `content/content.js` are the first place to check.
- The playlist-owner and collab-channel scope detection (`findScopeForCurrentPage`
  in `content/content.js`) relies on YouTube's current container element names
  (`ytd-watch-metadata`, `ytd-playlist-header-renderer`, etc.) — if YouTube
  restructures those, that's the function to update.
- Sidebar nav removal (`scrubGuide`) and the masthead's Create/Notifications
  removal (`scrubMasthead`) match by link/label text rather than tag name,
  which is more durable but not bulletproof — if one of those stops working,
  or a wanted entry (like Subscriptions) vanishes instead, those two
  functions are the ones to check.
- YouTube also has a newer tile component (`yt-lockup-view-model`) that's
  gradually replacing the old tags on some surfaces — a channel's own
  Playlists tab and playlist search results use only the new one; other
  places still wrap it inside an old tag. Both are handled, but if a *new*
  surface migrates and something starts slipping through there, that's the
  mechanism (`LOCKUP_SELECTOR`/`queryTiles()` in `content/content.js`) to
  extend.
- These non-blocklist scrubs (Shorts, sidebar, masthead, side
  recommendations) only run a few times a second — throttled on purpose,
  since re-running them on every single DOM mutation made the first page
  load noticeably slower — so there can be a brief moment (well under a
  second) where one of them is still visible right as a page finishes
  loading, before the next pass catches it.
- A Shorts shelf *tile* (the small thumbnail in a feed, before you open it)
  doesn't always carry a visible `<a href="/shorts/...">` link right at
  mount time — `scrubShorts` also checks for the `ytd-reel-item-renderer` /
  `ytd-reel-shelf-renderer` tags directly so this should be rare, but if a
  Shorts thumbnail ever survives in a feed, tell me what its markup looks
  like (right-click → Inspect) and this can be tightened.
- The block button sits at the bottom-right corner of each tile now (it
  moved twice: top-right originally overlapped YouTube's own "⋮" menu,
  top-left then got visually buried under the thumbnail's mouseover video
  preview). Bottom-right lands in the metadata area regardless of whether a
  tile's thumbnail spans the full top (grid layout) or the full left side
  (compact/search layout), so it should be clear of both — but if it still
  overlaps something on a particular tile layout, `.bt-block-btn`/
  `.bt-block-menu` in `content/content.css` are the two rules to adjust.
- A soft-blocked ("all videos except whitelist") channel's playlists aren't
  covered by the whitelist mechanism — the instant-hide CSS rule for this
  mode only matches tiles that look like an actual video (carrying a
  `v=`/`/shorts/` link), so a playlist tile from that channel is left alone
  entirely, whitelisted or not. If you want a specific playlist gone too,
  block the channel fully instead.
- **`chrome.storage.sync`** capacity is roughly 480 blocked items total
  before entries fall back to local-only storage (a hard limit of the sync
  API, not this extension). This only limits the *same-vendor* account sync —
  **GitHub Gist sync carries the whole list** regardless, so a large import
  (e.g. migrating thousands of channels from the original BlockTube) still
  propagates across devices; the local-only ones just don't ride Chrome/
  Firefox account sync as well.
- The network-level instant redirect (`declarativeNetRequest`) is capped at
  ~800 blocked videos + ~3000 fully-blocked channels, applied to the most
  recently blocked entries. Past that, a blocked page still redirects — just
  via the content script after it starts rendering (a brief flash), not at
  the network layer.

## Project layout

```
manifest.json
background/background.js   storage engine, DNR rules, message routing
background/gist-sync.js    optional cross-browser sync via a private GitHub Gist
content/content.js          DOM scrubbing, hover-block button, nav interception
content/content.css
popup/                       quick-block UI for the current page
options/                      full blocklist manager, import/export, sync setup
shared/constants.js          message types + storage config shared everywhere
icons/
test/                        end-to-end suite (npm test) — real Chromium + live YouTube
package.json                 dev tooling only (Playwright, web-ext); no build step
```

## Debugging "why isn't this blocked?"

Add `?bt-debug` to any YouTube URL (or run
`localStorage.setItem("bt_debug", "1")` once). The console then logs every
removal with the reason, and `window.__blockTube` — reachable by switching
the console's JavaScript-context dropdown to **BlockTube** — gives you
`state()` and `why("<CSS selector>")`, which explains a tile: the channel
keys it carries, how each resolves against the blocklist, and the verdict.
