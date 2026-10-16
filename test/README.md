# test/

End-to-end tests that drive a **real Chromium with the unpacked extension
loaded, against live youtube.com**. There is no unit-test layer — YouTube's
DOM is the thing under test, so the tests load real pages and assert on what
the content script did to them, and talk to the background service worker via
`chrome.runtime.sendMessage` from the extension's own options page.

## Running

```bash
npm install            # once — pulls playwright
npx playwright install chromium   # once — ~180MB, cached in ~/.cache/ms-playwright

npm test                       # run every *-test.mjs, print a summary
node test/run.mjs settings age # run only files whose name contains these
node test/settings-test.mjs    # run one directly
```

Needs **outbound network** (loads youtube.com). `npm run test:fast` runs the
files that don't (~20s). A failing file is run once more before it counts —
the summary marks "passed on 2nd try" — and `RETRY=0` turns that off. After
a day of runs YouTube may throttle this machine (`/channel/UC…` redirects to
Google's "unusual traffic" page): `enrich`, `gone`, `sweep` and `subs-scrape`
then fail on lookups reported as throttled. Wait it out.

## Contract

Each `*-test.mjs` is standalone: it launches its own persistent context
(`/tmp/bt-test-<pid>-<rand>`, cleaned by the OS), prints `ok: …` /
`FAIL: …` lines, and sets `process.exitCode` non-zero on any failure.
`EXT_PATH` is derived from the file's location, so the folder can move.

Four files don't follow that shape, and all four **run offline**:

- `locale-age-test.mjs` and `contextmenu-test.mjs` are **pure Node, no
  browser** — they slice `AGE_UNITS` + `parseAgeDays()` out of
  `shared/block-logic.js` and `ctxTargetFrom()` out of `background/background.js`
  respectively, and exercise them directly.
- `datalayer-test.mjs` needs a browser but **not YouTube and not the
  extension**: it loads `shared/constants.js`, `shared/block-logic.js` and
  `content/page-hook.js` into a page served by a Playwright route, plays the
  part of content.js using content.js's own lifted `judgeHookItem()`, and
  drives the hook through its real `ytInitialData` interception with
  synthetic response fixtures.
- `tilescope-test.mjs` needs a browser (it wants a real selector engine) but
  **not YouTube**: it lifts `tileChannels()` out of `content/content.js` and
  runs it against synthetic trees on `about:blank`, with no extension loaded.
  Those trees use YouTube's real tag names, which is safe *only* because the
  page isn't YouTube. On a YouTube page, YouTube's own components upgrade an
  element like `ytd-video-renderer` and wipe its children, so fixtures there
  use an unregistered name (`bt-test-tile`) or a plain `div`.

Lifting the function out of the shipped file, rather than copying it, is what
stops these drifting: rename or reshape the original and the test throws
instead of quietly passing.

## Slow by design

`navguard-test.mjs` is the longest file in the suite (~3 min): it walks every
URL shape a blocked channel and its videos are reachable by, and each case is
a real page load plus a settle window. It also waits ~7s after
`BLOCK_CHANNEL` for the background identity fetch that the `/channel/UC…`
case depends on. Don't shorten those waits to speed it up — a too-short wait
turns "the guard is broken" into "the page hadn't rendered yet", which is the
exact failure mode the file exists to catch.

## Known flaky assertions

`settings-test.mjs` — "removeShorts on: 0 Shorts shelves remain" occasionally
sees a late-hydrating Shorts tile on the `news+shorts` search page. It's
timing, not a regression; re-run.

`feedloop-test.mjs` — the two "must still page normally" assertions (cases 2
and 3) need YouTube to actually fire a continuation inside the scroll window,
and it sometimes serves enough on the first page not to bother: passing runs
have seen as few as 1 request. Observed failing once in a four-file sequence
and passing on the same sequence immediately after. Re-run before believing
it, and check *which* assertion failed — the curb's own assertions (0 further
fetches, sentinel gone, notice present) failing would be a real regression.

## What isn't covered

No signed-in account is used or improvised, so: masthead Create/Notifications,
a real Subscriptions feed, personalized recommendations. Chromium only.
`m.youtube.com` is covered by `mobile-test` (phone emulation) only for
search, channel pages, the watch page's popup target and tap-to-block. See the
per-file matrix below.

## Per-file coverage

Uses **synthetic data only** — never a real blocklist export (those are
personal data, and gitignored).

| file | what it checks |
|---|---|
| `settings-test`, `features-test`, `ui-hide-test` | 39 per-element toggles render/persist (38 on by default — `blockInEmbeds` is opt-in) to `bt_settings`; DNR home rule tracks `redirectHomepage`; Shorts on/off live; masthead / video-actions / voice / account / search-suggestions each remove+restore; the “Ask YouTube” AI button matched against the real markup YouTube ships for it (signed-in only, so the rule is applied to a synthetic copy rather than waited for on the page); the AI video-summary card hidden while a chapters card in the same element stays |
| `import-test`, `improve-test` | 4.7k-channel synthetic import in <0.5s, one write, the whole list in one local key with nothing in sync storage, idempotent re-import; an install still on the v1 layout (sync chunks + local overflow) migrates on the first load after a worker restart, old keys removed, other sync keys untouched |
| `oldformat-debug-test` | `convertOldBlockTube()` parses the original BlockTube export shape — names with parentheses or a line break, channel/video links, ids with a trailing `// note`, newline-joined string fields, title filters as keywords (regex too), `vidLength` as the length rule — and reports exactly the lines it can't import (`channelName`, `comment`, junk, a bad regex) while staying quiet about the do-nothing JS template; `?bt-debug` logs the banner + every removal's reason to the page console |
| `datatools-test` | the data tools, **no network needed**: import matching a channel by its *other* identity (no duplicate, missing fields filled in), the bulk `ids` forms of `SET_CHANNEL_MODE` / `SET_ENTRY_HIDDEN` / `ALLOW_CHANNEL`, `DELETE_DATA` (listed entries, tombstones, keywords + never-block) and `RESTORE_UNBLOCK {ts}` restoring the right record when another landed on top, a full backup → *Delete everything* (typed confirmation) → import round trip through the UI, a row's Delete + toast Undo, what `parseTargets()` reads out of pasted text, the age rule saving as you go, and the lookup-failure cleanup (gone + failed pre-selected, hidden-count opt-in, never a not-yet-looked-up channel; exact deletion; Undo), and two entries for one channel folding into one once an import pairs their identities (stricter mode, newer count, tombstone for the folded key) |
| `serversync-test` | sync through the real `server/xrntube-sync.py` on 127.0.0.1, **no network needed** (needs `python3` + `bcrypt`): two browser profiles — a wrong password refused readably, A pushes and B pulls channels and keywords, an unblock crosses as a tombstone, both writing at once keep both edits (the 412 path), one versioned document on disk |
| `sweep-test` | the background sub-count sweep: it finishes after the page that started it closes, a 429 (faked by routing youtube.com) pauses it with the channel still queued and unrecorded, Stop empties the queue |
| `mobile-test` | m.youtube.com in phone emulation (Pixel 7 UA, touch): a blocked channel leaves mobile search and its page redirects, the popup's target on a mobile watch page names the channel and title, a rich-grid cell (`ytm-rich-item-renderer` > tile) gets one 🚫, not one per tag; a 🚫 scrolled under the sticky watch-page player is not drawn over it; the 🚫 button shows without hover and tapping it → Block channel works |
| `uc-handle-test` | UC-keyed block → 0 tiles (repro), enrich → `@handle` cached → 18→0 on a fresh page **and** a live open tab via `REBROADCAST_BLOCKLIST` |
| `enrich-test` | 8 channels (subs+@handle+name), one write; a UC id naming no channel is recorded as `gone` and never handed a number |
| `age-test`, `locale-age-test` | `age=3d` removes week/month/year-old MKBHD tiles; on the watch page a recent video still plays under a 365-day rule **and** an older one is still bounced under a 30-day rule (read off the live grid, not hard-coded); `parseAgeDays()` (pure Node, extracted from shared/block-logic.js) parses "…ago" in 13 languages plus YouTube's compact "3d ago" / "2w ago" / "7y ago", and rejects non-dates ("6.7M" is a view count, not 7 minutes) |
| `allowlist-test` | "Never-block" beats a full block + the pre-paint CSS + the DNR redirect; removing it re-blocks |
| `ownpage-test` | a video-only channel's own `/videos` grid 30→0; whitelisted video survives; the same grid reached by a legacy `/c/<name>` URL (which names neither identity format) still resolves to the channel via its canonical metadata; and an age rule reaching the channel's **Shorts** tab (Shorts toggle turned off first, or it would pass for the wrong reason) with no empty grid wrappers left behind |
| `commentui-test` | the comment section's shape rather than its contents: two-column layout actually lays threads across two columns (not just `column-count` in the CSS), `commentLimit` caps the thread list, the continuation sentinel is removed so it stops paging in more, the notice explains why, and both switch off independently |
| `datalayer-test` | layer 0's **filter**, offline: a blocked channel's renderer removed and its wrapper spliced out, a description `@mention` left alone, `UC…`-keyed and `@handle`-keyed entries both matching one `browseEndpoint`, both block modes, the allow-list, blocked video ids, keyword + duration bounds, a shelf taken by its header's owner (FULL only), a rich grid's wrapper pruned, and an empty blocklist leaving the response byte-identical; plus the paging brakes — an exhausted surface losing its continuation while a normal response keeps it, and `noteJudgedRound()`'s own thresholds (lifted from content.js: three empty responses stop it, one survivor resets it, a small batch counts for nothing, a watch page never counts at all); and the age rule against Shorts — a dateless Short and a 3-week-old video go while today's upload stays, a plain video-only block still takes Shorts, and a whitelisted Short survives; a playlist lockup taken by `contentType` with its byline at the real thirteen-level depth, which is what the fixture exists to prove; the `hideAutoChapters` strip (every surface of generated chapters goes, a creator's chapters stay byte-identical, off means off); and `/get_watch` served in 7-byte chunks — the player part streams through byte-identical, the watch-next part loses a blocked related tile and its auto chapters |
| `datalayer-live-test` | layer 0's **wiring**, live: the `world: "MAIN"` script actually loads, installs both hooks, leaks no `XrnTube` global, neither world throws on startup, and a real `/youtubei/v1/search` continuation gets renderers described and removed. Exists because the DOM scrub covers for a dead layer 0 — every other test passes without it |
| `tilescope-test` | which channels a tile *belongs* to: `tileChannels()` lifted out of content.js and run against synthetic trees on `about:blank` — a search result's description `@mention` is not its uploader, byline collaborators all count, an unhydrated or unknown tile shape falls back to the whole tile, and search's watch card is attributed to its header channel rather than to its first video row; plus what `extractInfo()` makes of a tile — a watch card carrying a “play all” link is neither a video nor a playlist, while a real playlist tile still is, and a Shorts tile is flagged as a Short |
| `posts-playlists-test` | a blocked channel's playlists gone from its own Playlists tab + playlist search (both modes); its community posts gone from the Posts tab; and search's channel watch card — a channel card carrying a "play all" link — kept under a video-only block with its video rows emptied, gone under a full one |
| `members-test` | Join button, members-only tiles, Membership tab all gone; toggle off restores |
| `channeltabs-test` | `cleanChannelTabs`: Shorts/Shows/Store/Posts/Podcasts tabs gone from a channel page, Home/Videos/Playlists kept, toggle off restores, Shorts tab still follows `removeShorts`; the modern header's Join button removed while Subscribe survives; membership price offers removed (span-split) while price-shaped video titles survive |
| `endscreen-test`, `layout2-test`, `player-fit-test` | modern `.ytp-fullscreen-grid` neutralised; no horizontal overflow 1200–2560px; player + title above the fold |
| `extras-test`, `ux-test` | always-on scrubs; 6 page tabs, page memory, mass-clear through the confirmation dialog + tombstones |
| `subs-ui-test` | options page: subs↓ default sort, "Show all" growing past the 300-row cap, the "No sub count" filter, auto-fetch on open, and no re-fetch of a count already recorded by the current `SUBS_SCRAPE_VERSION` |
| `popup-test` | popup counters + its off-YouTube state + "Manage blocklist" (it also has Unblock for what's already blocked and "Backup & import"); and the contract its buttons rest on — `GET_PAGE_TARGET` returns one row per real channel, never the same channel under both identity formats (the `withAliases` split) |
| `bulkactions-test` | the bulk-select bar end to end: Hide / Video-only / Never-block / Delete across a selection (the last two through `#modal-confirm`), and that a bulk Delete is ONE undo record that restores the whole selection |
| `duration-test` | the duration half of the keyword filter (shorter-than / longer-than bounds read off the real time badge, not "4K"/"New"), regex keywords, and that a malformed regex doesn't take the page down |
| `contextmenu-test` | pure Node: `ctxTargetFrom()` + its regexes lifted out of background.js — every video/channel URL shape resolves, `/c/` `/user/` home and search resolve to *nothing*, link beats page URL, menus scoped to youtube.com |
| `embeds-test` | `blockInEmbeds`: a youtube.com/embed iframe on a third-party page is untouched by default, blanked once opted in, and an unblocked channel's embed still plays |
| `comments-test` | a blocked channel's comment threads go while everyone else's stay, a comment that only *mentions* them survives, and video-only mode keeps their comments; the author to block is read off the live page rather than hard-coded |
| `feedloop-test` | the runaway-feed curb: a fully-blocked feed stops fetching and stays small, a search with nothing left to show stops too (and says so), while an unblocked and a partially-blocked feed both still page normally on scroll |
| `subs-scrape-test` | pure Node: the sub count is read from the channel's own header and not from an embedded card, a hidden count reads as "hidden", a non-English header still yields the count and not the video count, and live — the same channel via `@handle` and via `UC…` reports the same number |
| `gone-test` | a channel that is gone — by 404 and by the 200-with-an-error-alert shape a nonexistent `/channel/UC…` actually returns: recorded gone once (so it is not retried on every open), `subs: "n/a"`, a **gone** tag in the row, a live channel in the same sweep unaffected, the flag carried through import and cleared by a later successful scrape |
| `navguard-test` | can a blocked channel still be *reached*? every channel URL shape (`/@h`, `/channel/UC…`, `/c/…`) and video URL shape (`?v=`, `&list=`, `/live/`, `/embed/`); Back after a bounce; blocking while watching; auto-resolved UC id; plus the must-still-work cases (soft mode, allow-list, unrelated channel) |

## Driving live YouTube by hand

There's no *product* test harness, but a real Chromium instance with this
extension loaded and pointed at the live site can be driven from the shell
via Playwright — this has been done successfully in this environment and is
how the `yt-lockup-view-model` finding in [docs/fragility.md](../docs/fragility.md)
was actually caught, not guessed. It needs outbound network access, which is not guaranteed in every
sandbox this repo might be worked in — try it, and fall back to
asking the user for a live DOM sample if it's unavailable.

```bash
cd /tmp && mkdir pw-test && cd pw-test && npm init -y
npm install playwright@latest
npx playwright install chromium   # ~180MB download, cached under ~/.cache/ms-playwright after
```

Then, loading the unpacked extension requires `headless: "new"` (old
headless mode can't load extensions at all) plus `--no-sandbox` (there's
usually no permission to run `playwright install-deps`, i.e. no real Chrome
sandbox available, in these environments):

```js
import { chromium } from "playwright";
const EXT_PATH = "/absolute/path/to/xrntube"; // this repo
const ctx = await chromium.launchPersistentContext("/tmp/pw-test/profile", {
  headless: false, // overridden by --headless=new below; extensions require this combo
  args: [
    `--disable-extensions-except=${EXT_PATH}`,
    `--load-extension=${EXT_PATH}`,
    "--headless=new",
    "--no-sandbox",
  ],
});
const page = ctx.pages()[0] ?? await ctx.newPage();
await page.goto("https://www.youtube.com/...");
// ctx.serviceWorkers() finds background.js's service worker (confirms it started
// without errors); page.on("pageerror", ...) surfaces content-script exceptions.
```

To exercise the blocklist itself (rather than just watching the DOM get
scrubbed), open the extension's own popup/options page as a normal
Playwright page — those origins get full `chrome.runtime` access, unlike a
page-world `page.evaluate()` on youtube.com itself (that's the content
script's *isolated* world, which Playwright can't target directly):

```js
const extPage = await ctx.newPage();
await extPage.goto(`chrome-extension://${extensionId}/popup/popup.html`);
await extPage.evaluate(() => chrome.runtime.sendMessage({ type: "BLOCK_CHANNEL", id: "@handle", name: "..." }));
```

Caveats hit in practice: no logged-in test account exists or should be
improvised here (don't attempt to automate a real Google login), so
anything gated on being signed in — the masthead's Create/Notifications
buttons, a real subscriptions feed, personalized recommendations — can't be
verified this way. Mobile is emulated (`mobile-test`: a phone's user agent,
viewport and touch), not run on a real phone browser.

**Pitfall when unit-testing a CSS selector in isolation**: don't
`document.createElement()` a real YouTube tag name (`ytd-video-renderer`,
etc.) on a live youtube.com page to build a synthetic test fixture — it gets
silently upgraded by YouTube's own registered custom element definition the
instant it's connected, and that component's own logic can rewrite or wipe
the children you just appended before you get to assert anything, making
the test fail for reasons that have nothing to do with the selector being
tested. Use a fake, unregistered tag name (`bt-test-tile`, plain `div`,
whatever) to test a selector's *logic* in isolation, then separately verify
the real thing end-to-end (block something for real, load a real page,
check what's left) — that's how the `:has()` instant-hide layer
(see [docs/architecture.md](../docs/architecture.md)) was actually confirmed.
