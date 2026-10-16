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
- `background/server-sync.js`'s push debounce is a plain `setTimeout` that a
  suspended worker can drop; the `bt-sync-poll` alarm (`SYNC.POLL_PERIOD_MIN`,
  min ~1 in production Chrome) is the backstop. The protocol is our own
  (docs/sync-server.md), so nothing upstream can move under it — the fragile
  part is the hosting: on Tailscale, adding a path with `tailscale serve`
  instead of `tailscale funnel` silently takes the whole address off the
  public internet.
- **YouTube throttles channel lookups.** A few hundred fast ones (16 in
  parallel, as the sweep once ran) got a machine's `/channel/UC…` requests
  redirected to Google's "unusual traffic" page for an hour or more; the
  extension may not follow that redirect, so the fetch throws. That throw is
  treated as throttling (pause, keep the channel queued), never as a result.
  If lookups stop landing, `curl -sI` a `/channel/UC…` URL and look for
  `google.com/sorry`.
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
- `RENDERER_SELECTOR`, `CHANNEL_CARD_TAGS`, `BYLINE_SEL`, `SHELF_SELECTOR`,
  `SHELF_HEADER_SEL` and `findScopeForCurrentPage()` in `content/content.js`
  hard-code YouTube's current custom-element tag names (`ytd-*` desktop,
  `ytm-*` mobile) and a handful of ids/classes. YouTube changes these
  periodically — when tiles stop being removed or the popup stops finding a
  channel/video, these are the first places to check. The `ytm-*` mobile
  selectors are unverified against a live device (see README).
- **`content/page-hook.js`'s `RULES` table hard-codes YouTube's JSON field
  paths**, which churn at least as fast as the tag names — upstream
  BlockTube's equivalent carries the scars (two candidate paths for
  `lockupViewModel`'s channel id, a `metadataRows[1]` index). When layer 0
  stops removing things, `?bt-debug` prints `window.__btDataLayer`: a healthy
  search page shows `responses` and `candidates` both climbing. `candidates`
  at 0 means the rule table matched no renderers — YouTube renamed something.
  `candidates` climbing with `removed` at 0 means the renderers matched but
  their byline paths didn't.
- **Layer 0 failing is invisible from the outside.** The DOM scrub catches
  whatever it misses, so the only symptom is that tiles flash before
  disappearing again. `datalayer-live-test` exists precisely because every
  other test in the suite would still pass with layer 0 completely dead —
  but that runs here, not on the machine where YouTube renames a field next
  month. So `noteLayer0Miss()` in content.js counts the tiles the DOM scrub
  removes on a surface layer 0 claims to cover and `console.warn`s once past
  `LAYER0_WARN_AT` (10). It waits `LAYER0_GRACE_MS` (10s) first, because
  layer 0 races YouTube for the first paint and deliberately loses sometimes;
  only what arrives afterwards, through the fetches it definitely hooks,
  counts as evidence. Measured: 0 warnings with the rule table healthy, one
  warning with it neutered. The same counts reach the popup's health line
  (`GET_PAGE_HEALTH`), because a phone has no console to read the warning in:
  "⚠ N tiles got past the early filter" there is this check firing. And
  `npm run test:canary` (a weekly systemd timer once installed) runs
  `datalayer-live-test` and four other selector-heavy files on this machine,
  with a desktop notification when they fail.
- **The logo's click target is a JSON field.** `logoToSubscriptions` works by
  swapping `topbar.desktopTopbarRenderer.logo.topbarLogoRenderer.endpoint`
  (desktop) and `topbar.mobileTopbarRenderer.topbarLogo.topbarLogoRenderer
  .endpoint` (m.youtube.com) in `ytInitialData` for a `FEsubscriptions`
  browse endpoint — the anchor's href is not what a click follows, and the
  mobile logo is a `<button>` with no href at all. If YouTube moves either
  path, the logo quietly goes back to "home, then a reload into
  Subscriptions" (the nav guard's fallback) with nothing failing; the
  "no document load" assertions in `settings-test` and `mobile-test` are what
  notice. A late switch on desktop patches the rendered
  `ytd-topbar-logo-renderer`'s `data` instead; mobile has no such property.
- **The tag list is not the whole surface, and the gaps cluster on search and
  channel pages.** Nine renderer families reached `RENDERER_SELECTOR` late
  precisely because they appear nowhere else: `ytd-universal-watch-card-renderer`
  and its `ytd-watch-card-compact-video-renderer` rows (search's big
  channel card), `ytd-video-card-renderer`, `ytd-movie-renderer` /
  `ytd-compact-movie-renderer`, `ytd-channel-featured-video-renderer` and
  `ytd-channel-video-player-renderer` (a channel's trailer), and the
  related-channel rails `ytd-mini-channel-renderer` /
  `ytd-compact-channel-recommendation-card-renderer`. Upstream BlockTube's
  `filterRules` map (`src/scripts/inject.js`) is the best available
  cross-check for what else exists — it names every renderer it filters, on
  every surface, in one place. Diff against it before assuming a surface is
  covered.
- **`BYLINE_SEL` failing open is deliberate.** `tileChannels()` falls back to
  scanning the whole tile when the byline scopes name no channel, so a tag
  rename degrades to the old over-broad behaviour rather than to *no
  blocking*. The cost is that the false positive it exists to prevent (a
  description `@mention` read as the uploader) comes back silently. If tiles
  start disappearing for no reason, check whether YouTube renamed a byline
  container before looking anywhere else.
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

  **A search page slips past all of that**, which is why there is a second
  brake. The results page is tall on its own — masthead, filter chips, a
  channel card, a shelf — so its sentinel can sit further than 1.5 viewports
  down while YouTube still prefetches, and every removal we make quietly
  leaves room for the next batch. Geometry can't see it. `noteJudgedRound()`
  counts **rounds** instead: layer 0 describes each response before it
  renders, so one judged batch is one fetch, and three in a row that carried
  videos (≥ `EXHAUST_MIN_VIDEOS`) with none surviving sets `feedExhausted`.
  One surviving video resets the count — that is the over-correction guard,
  and it is the assertion to keep if these thresholds are ever tuned. The
  flag then does two things: `curbRunawayFeed()` stops waiting for geometry,
  and the hook strips `continuationItemRenderer` / `continuations` out of
  every further response, because a sentinel removed from the DOM is simply
  re-created from the next one. Thresholds and reset behaviour are pinned in
  `datalayer-test` (offline, lifted from content.js); `feedloop-test` checks
  the live outcome and reports which brake stopped the page.
- **YouTube keeps the pages you came from in the DOM, hidden.** Desktop parks
  them in `ytd-page-manager` with `[hidden]`; the page you were on before is
  usually *earlier* in document order than the one on screen. So a
  document-wide `querySelector` for "the sentinel" or "the feed list" quietly
  returns the hidden page's: arriving at a search from a channel's Videos
  tab, the curb measured the channel grid's sentinel, removed it, and put the
  stop notice inside the hidden channel page — the search stopped with
  nothing on screen. Anything that means "the feed" has to filter to rendered
  elements (`activeSentinels()` / `activeFeedList()`), and anything it
  removes has to stay inside that page, because the hidden ones are what Back
  restores. `feedloop-test` case 5 is this path.
- **m.youtube.com never fires `yt-navigate-start` / `yt-navigate-finish`.**
  It fires `state-navigatestart` / `state-navigateend`. Per-page state that
  only resets on the `yt-` events never resets on a phone: an exhausted
  search kept the hook cutting every continuation on every page after it
  until a reload. The phone's feed lists are different elements too
  (`lazy-list`, `.rich-grid-renderer-contents`) — a desktop-only selector
  list for "where the notice goes" found nothing there, and the feed stopped
  blank (`feedloop-test` case 8).
- **A lockup buries its byline three levels below where the scan stops.**
  `collectChannelRefs()` walks `MAX_SCAN_DEPTH = 10` levels into each
  BYLINE_FIELDS subtree, and a `lockupViewModel`'s channel sits at
  `metadata.lockupMetadataViewModel.metadata.contentMetadataViewModel
  .metadataRows[0].metadataParts[0].text.commandRuns[0].onTap
  .innertubeCommand.browseEndpoint.browseId` — thirteen. A `videoRenderer`'s
  `shortBylineText` is shallow, so the symptom is lopsided and easy to
  misread: a blocked channel's ordinary videos vanish from search while its
  **playlist cards stay**, and if the entry carries an age rule nothing
  downstream can remove them either (a playlist has no date). The rule table's
  `bylinePaths` starts the walk at the metadata rows instead; raising the
  global depth cap would have worked too and is the wrong trade — a deeper
  blanket scan is how a description `@mention` becomes an uploader.
  `datalayer-test` pins it with a fixture at the real depth (a shallower one
  passes with or without the fix, which is worse than no test).
- **A tile's own title will date it if you let it.** The age rule reads from
  `AGE_SCOPE_SEL` — `yt-content-metadata-view-model`, `#metadata-line`,
  `ytd-video-meta-block`, and a Shorts subhead — and only falls back to the
  whole tile (minus the title) when a tile has none of them. Reading
  `el.textContent` outright is the tile-sized version of the `document.body`
  bug: live, "Apple Silicon Explained in 56 seconds" was the single short to
  survive a 2-day rule on a channel's Shorts tab, and "24 hours with the
  iPhone" would do the same to an ordinary video. If YouTube renames the
  metadata component, age rules quietly start reading titles again — the
  offline cases in `tilescope-test` are what catch that.
- **The watch page's related column names no channel in the DOM.** Measured
  live: a rail of 26 `yt-lockup-view-model`s, two anchors each, both
  `/watch?v=…`, and the uploader rendered as plain text — so `tileChannels()`
  finds nothing, no channel block of any kind can touch a related video, and
  the hover menu can only offer "Block this video". Reading the name and
  matching it against the blocklist is exactly the "never guess a channel"
  trap, so the fix is upstream: `page-hook.js` hooks `/youtubei/v1/next`,
  where the byline's `browseEndpoint` still exists. **This makes layer 0
  load-bearing on the watch page** — the one place a miss there is a blocking
  failure rather than a latency regression. The first rail arrives with
  `ytInitialData`; every in-app hop between videos fetches a fresh one —
  from `/next` until YouTube moved that hop to **`/youtubei/v1/get_watch`**,
  which bundles `[{ playerResponse }, { watchNextResponse }]`. Unhooked, it
  let every blocked channel's related tile through after a click (4 of 4,
  live); `streamWatchParts()` now passes the player part straight through and
  filters only the watch-next one, so playback keeps its head start (buffering
  the bundle cost +0.9s click→playing). If blocked channels start reappearing
  in the sidebar, check the network panel for which endpoint carries the rail
  now, that it is in `HOOKED`, and that `lockupViewModel`'s byline paths still
  resolve, before looking anywhere in the DOM layer.
- **The relative date has a new shape, and a date that doesn't parse
  disables age rules silently.** YouTube moved tiles to "3d ago", "2w ago",
  "7y ago" (one letter, no space) alongside "3 days ago" and "4 wk ago" — even
  mixed on one page. `parseAgeDays()` read none of the compact ones, every
  tile counted as undated, and "unknown age means recent" kept them all: a
  1-day rule blocked nothing. If an age rule stops working, look at a tile's
  metadata line first.
- **Auto-generated chapters are told apart only in the JSON.** Creator and
  AI chapters render as the same elements; the watch-next response keys the
  player-bar markers `AUTO_CHAPTERS` vs `DESCRIPTION_CHAPTERS` and names the
  panel `engagement-panel-macro-markers-auto-chapters` vs
  `…-description-chapters`, and every other surface (description cards, the
  panel-header chip, the player-bar button) is a command pointing at that
  panel. If `hideAutoChapters` stops working, look for those two names in a
  fresh watch response first; the one CSS backstop (the panel's `target-id`)
  covers only the side panel.
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
