# Known fragility

Where this extension breaks, and what broke before. Every entry here was
observed, not predicted — read the relevant one before touching the code
it names.


- **Not covered at all: `music.youtube.com`.** `content_scripts.matches` is
  `www.youtube.com` + `m.youtube.com` only, so a blocked channel's music and
  videos are fully reachable there. Adding it is not a one-line manifest
  edit — YouTube Music's DOM shares almost nothing with the `ytd-*` tags
  `RENDERER_SELECTOR` targets.
- **Third-party embeds are opt-in** (`blockInEmbeds`, the only leaf that ships
  OFF). `content_scripts.all_frames` is `true`, but `matches` is still
  youtube.com only — so this injects into YouTube iframes, not into every
  frame on the web. The frame path in `content.js` **returns before any of the
  observers, stylesheets and timers are set up**; only a real `/embed/<id>`
  does any work, and only when the switch is on. Keep that early return first:
  the full init running in every embed on a page full of them is exactly the
  cost this design avoids. An embed can only be neutered from the inside —
  there is no content script on the host page, so the `<iframe>` element itself
  can't be removed and blanking the frame is the honest most we can do. DNR
  gets a second rule per blocked video id at `DNR_RULE_ID_BASE_EMBED` with
  `resourceTypes: ["sub_frame"]` and action **`block`**, not the redirect the
  top-level rules use: sending someone else's embedded player to our
  Subscriptions feed would be a stranger surprise than an empty frame.
- `MSG.RESOLVE_VIDEO_CHANNEL` depends on YouTube's public **oEmbed** endpoint
  (`/oembed?format=json&url=…`, no API key) staying available and returning
  `author_url`. It is only consulted for a page that shows a player but no
  channel byline (in practice `/embed/<id>`), and misses are cached, so a
  breakage degrades to "embed pages stop being guarded", not an error.
- The `contextMenus` permission is now actually used — see "Right-click to
  block". It had been declared for years with no call behind it.
- `background/gist-sync.js` assumes the GitHub REST shape (`/gists`,
  `/gists/:id`, `history[0].version`) and that the account's BlockTube gist
  is on page 1 of `/gists?per_page=100` (true right after creation; a user
  with >100 gists *and* a pre-existing BlockTube gist could make a second
  one, leaving two to reconcile — rare, and the merge still converges). The
  push debounce is a plain `setTimeout` that a suspended worker can drop;
  the `bt-sync-poll` alarm (`SYNC.POLL_PERIOD_MIN`, min ~1 in production
  Chrome) is the backstop. Live-tested only against a 401 (bad token) — a
  real multi-device gist round-trip wasn't exercised in this environment (no
  test PAT should be improvised).
- YouTube is mid-migration to a new tile component family, `yt-lockup-view-model`,
  that shares nothing with the legacy `ytd-*`/`ytm-*` custom elements. Confirmed
  live: a channel's own "Playlists" tab and playlist results in search render
  *only* `yt-lockup-view-model` (zero `ytd-playlist-renderer`); a channel's
  "Videos" tab wraps one *inside* the legacy `ytd-rich-item-renderer` as a
  transitional shim. `LOCKUP_SELECTOR` + `queryTiles()` in `content/content.js`
  handle both cases (a bare lockup is treated as its own tile; a nested one is
  skipped since its wrapper already covers it) — if more surfaces migrate,
  or the legacy tags disappear entirely, that's the pairing to revisit. This
  was the real cause of "a blocked channel's playlist still shows up", not
  the hydration-timing theory that shipped first.
- `findScopeForCurrentPage()` decides *whose page this is*, and it cannot be
  a flat "first selector that matches anything" chain — that shape is what
  left a blocked channel's **playlist pages reachable**. Two compounding
  traps, both confirmed live on `/playlist`:
  1. **YouTube leaves other page types' components mounted as empty shells**
     after an SPA navigation. A `/playlist` page still contains a childless
     `ytd-watch-metadata`, which won the old chain and duly reported "no
     channel here" — the real owner byline was never consulted.
  2. **Even within one page type the first match can be the empty one**: a
     `/playlist` page has two `yt-page-header-renderer`s and only one carries
     the byline. (That component is where the owner moved to; the legacy
     `ytd-playlist-header-renderer` / `-sidebar-primary-info-renderer` still
     render, but empty.)

  So the function restricts candidates by `location.pathname` first, then
  prefers the first candidate that actually contains a channel link, falling
  back to a bare match only if none do. Add a surface the same way — and note
  that a *wrong* answer here is a false bounce off a page the user is
  entitled to, which is why `navguard-test` asserts the home feed, search
  results, an unrelated channel's video and Subscriptions itself all stay put.
- **A watch page's related tiles name no channel at all.** Measured live: all
  20 `yt-lockup-view-model` tiles in the sidebar carried only `/watch?v=…`
  links — no `/@handle`, no `/channel/UC…`. The channel appears solely as text
  and as `aria-label="Go to channel <Name>"`, i.e. a *display name*, and two
  channels can share one; matching on it would block the wrong channel, which
  is the one outcome this codebase refuses (see "Right-click to block"). So a
  blocked channel's videos are unblockable there by key. It does not bite by
  default — `removeRelated` is on and `#secondary` is removed outright — but
  turn related videos back on and the leak is total. The only honest fix would
  be resolving each tile's videoId through the cached `RESOLVE_VIDEO_CHANNEL`
  oEmbed lookup, which is ~20 requests per watch page; not worth it unless
  someone actually runs with related videos showing.
- `RENDERER_SELECTOR`, `SHELF_SELECTOR`, and `findScopeForCurrentPage()` in
  `content/content.js` hard-code YouTube's current custom-element tag names
  (`ytd-*` desktop, `ytm-*` mobile). YouTube changes these periodically —
  when tiles stop being removed or the popup stops finding a
  channel/video, these are the first places to check. The `ytm-*` mobile
  selectors are unverified against a live device (see README).
- `scrubGuide()` matches Home/Shorts by `href` (very stable — confirmed live
  that both mini-guide and drawer link to exactly `/` and `/shorts/`, note
  the trailing slash on the latter) but everything else — `HIDDEN_NAV_LABELS`
  ("Shorts" as a backup, "Explore", "More from YouTube", "Report history")
  and `scrubMasthead()`'s Create match — by visible label/aria-label text.
  These now come from `LABELS_BY_LANG` (6 languages + English fallback — see
  "UI-language labels"), so a listed non-English UI is handled, but an
  unlisted one still falls back to the English strings and misses. More
  resilient to a redesign than tag-name matching, but not immune.
  `navLabelOf()` reads the label off the entry's *direct child*
  `<a>` (`:scope > a`, deliberately not a deeper search) — confirmed live
  that a plain descendant search grabs an icon's empty wrapper `<span>`
  before it reaches the real label text, and an unscoped `querySelector("a")`
  on a *section* wrapper wrongly finds its first child entry's anchor
  instead of reporting "no anchor here". If a wanted entry (Subscriptions,
  Library, the account menu) starts vanishing, or Explore/Report
  history/masthead buttons stop being removed, those are the mechanisms to
  re-check first — this exact class of bug shipped once already.
  `scrubMasthead()`'s Create/Notifications removal could not be verified at
  all in this environment (both only render for a signed-in account, and no
  test account exists or should be improvised here). `GUIDE_FOOTER_SIGNAL_RE`
  (matching on footer link text like "How YouTube works") is the equivalent
  fragility point for the sidebar's small-print footer removal.
- **A feed where everything is blocked will loop forever without
  `curbRunawayFeed()`.** YouTube fetches the next page of an infinite feed
  while its continuation sentinel is in the viewport, assuming what it just
  added made the page taller. Suppress every tile and the height never changes,
  so it fetches again immediately. Measured on a video-only-blocked channel's
  `/videos` tab, sitting still and never scrolling: **22 continuation requests
  in 30s** (0 with the extension off), 221k nodes added, tiles 210 → 510 → 690
  against a document height pinned at 1388px, **77% CPU and long tasks up to
  1.5s** — which is what makes the whole machine stop responding to typing. It
  does not settle; it ends when the tab dies.

  Two things that look like fixes and are not:
  1. **Removing the sentinel** — YouTube re-creates it and asks again (still 21
     requests in 30s).
  2. **Testing whether the page can scroll** — a blocked channel page still
     scrolls by the height of its masthead and header (1388px against a 1000px
     viewport), so that test passes while the feed underneath loops.

  What works is matching YouTube's actual trigger: curb when the sentinel is
  **within ~1.5 viewports** and this page view has had `CURB_MIN_SUPPRESSED`
  tiles taken away. Then remove the sentinel *and* insert the
  `<bt-blocked-notice>` — the notice's `min-height` is load-bearing, not
  decoration, because the page has to become taller than the viewport for a
  re-created sentinel to fall out of range. After the fix: 0 requests, 1% CPU,
  no long tasks.

  The count is of **removals, not surviving tiles** (`notePageSuppressed()`,
  reset per page view). A tile-based test cannot work here: the curb removes
  the tiles, so the next pass would have nothing left to count and would stop
  recognising the state it just created. `feedloop-test` guards both directions
  — the loop stopping, and an unblocked or partially-blocked feed still paging
  normally, since over-correcting here would break scrolling everywhere.
- Everything except `processRenderer()`'s blocklist removals runs on the
  ~400ms `scheduleExtrasScrub()` throttle (see Architecture) — a small
  latency window traded for page-load performance. Anything that must
  disappear *instantly* belongs in the per-mutation path, not here.
- `scrubEndScreen()` / its instant-hide CSS match player-chrome class names,
  not custom-element tags. YouTube **already redesigned this once** (Sept
  2026): the end-of-video suggestions moved from `.html5-endscreen` +
  `.ytp-videowall-still` to **`.ytp-fullscreen-grid`** full of
  **`.ytp-modern-videowall-still`** tiles (the "ytp-delhi" player revision) —
  the old names stopped matching and recommendations came back. Both name
  sets are handled now: the CSS `display:none`s the `.ytp-fullscreen-grid`
  container (player-owned, so CSS only — not `.remove()`d), the JS pass
  deletes the content pieces (legacy overlay, `.ytp-ce-element` cards,
  `.ytp-cards-teaser`, the individual `<a>` still-tiles). If suggested
  videos survive the end screen again, the videowall/grid class names are
  the thing to re-probe with a near-end seek. (Verified live to the extent
  headless allows — a seeked-near-end video never truly fires `ended`, so
  the elements and the toggle gating are confirmed, not a frame-by-frame
  appear-then-vanish.)
- `scrubShorts()`'s catch-all pass relies on finding an `a[href*="/shorts/"]`
  somewhere inside a tile/shelf when the tag name alone doesn't identify it
  as Shorts (e.g. `ytd-rich-shelf-renderer`, reused for many non-Shorts
  shelf types too). If a Shorts tile ever renders with no such link visible
  in its markup, it can survive — live-DOM confirmation would tighten this.
