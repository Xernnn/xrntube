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

Needs **outbound network** (loads youtube.com and, for the sync tests,
api.github.com). In a sandbox without it, these can't run — fall back to
asking for a live DOM sample.

## Contract

Each `*-test.mjs` is standalone: it launches its own persistent context
(`/tmp/bt-test-<pid>-<rand>`, cleaned by the OS), prints `ok: …` /
`FAIL: …` lines, and sets `process.exitCode` non-zero on any failure.
`EXT_PATH` is derived from the file's location, so the folder can move.

`locale-age-test.mjs` is the one exception — it's **pure Node, no browser**:
it slices `AGE_UNITS` + `parseAgeDays()` straight out of `content/content.js`
and checks the relative-date parser against real "…ago" strings in 13
languages. Fast, and the only test that runs offline.

## Slow by design

`navguard-test.mjs` is the longest file in the suite (~3 min): it walks every
URL shape a blocked channel and its videos are reachable by, and each case is
a real page load plus a settle window. It also waits ~7s after
`BLOCK_CHANNEL` for the background identity fetch that the `/channel/UC…`
case depends on. Don't shorten those waits to speed it up — a too-short wait
turns "the guard is broken" into "the page hadn't rendered yet", which is the
exact failure mode the file exists to catch.

## Known flaky assertion

`settings-test.mjs` — "removeShorts on: 0 Shorts shelves remain" occasionally
sees a late-hydrating Shorts tile on the `news+shorts` search page. It's
timing, not a regression; re-run.

## What isn't covered

No signed-in account is used or improvised, so: masthead Create/Notifications,
a real Subscriptions feed, personalized recommendations. Chromium only — no
Firefox, no `m.youtube.com` / `ytm-*`. See the per-file matrix below.

## Per-file coverage

Uses **synthetic data only** — never the real `blocktube_backup*.json` /
`blocktube-import.json` sitting (gitignored) in the repo root.

| file | what it checks |
|---|---|
| `settings-test`, `features-test`, `ui-hide-test` | 33 per-element toggles render/persist (32 on by default — `blockInEmbeds` is opt-in) to `bt_settings`; DNR home rule tracks `redirectHomepage`; Shorts on/off live; masthead / video-actions / voice / account / search-suggestions each remove+restore |
| `import-test`, `improve-test` | 4.7k-channel synthetic import in <0.5s, one bulk write, sync-chunk/overflow split, idempotent re-import |
| `oldformat-debug-test` | `convertOldBlockTube()` parses the original BlockTube export shape; `?bt-debug` logs the banner + every removal's reason to the page console |
| `uc-handle-test` | UC-keyed block → 0 tiles (repro), enrich → `@handle` cached → 18→0 on a fresh page **and** a live open tab via `REBROADCAST_BLOCKLIST` |
| `enrich-test` | 8 channels (subs+@handle+name) in ~1.5s, 8-wide, one write; a UC id naming no channel is recorded as `gone` and never handed a number |
| `age-test`, `locale-age-test` | `age=3d` removes week/month/year-old MKBHD tiles; on the watch page a recent video still plays under a 365-day rule **and** an older one is still bounced under a 30-day rule (read off the live grid, not hard-coded); `parseAgeDays()` (pure Node, extracted from content.js) parses "…ago" in 13 languages and rejects non-dates |
| `allowlist-test` | "Never-block" beats a full block + the pre-paint CSS + the DNR redirect; removing it re-blocks |
| `ownpage-test` | a video-only channel's own `/videos` grid 30→0; whitelisted video survives |
| `posts-playlists-test` | a blocked channel's playlists gone from its own Playlists tab + playlist search (both modes); its community posts gone from the Posts tab |
| `members-test` | Join button, members-only tiles, Membership tab all gone; toggle off restores |
| `channeltabs-test` | `cleanChannelTabs`: Shorts/Shows/Store/Posts/Podcasts tabs gone from a channel page, Home/Videos/Playlists kept, toggle off restores, Shorts tab still follows `removeShorts`; the modern header's Join button removed while Subscribe survives; membership price offers removed (span-split) while price-shaped video titles survive |
| `endscreen-test`, `layout2-test`, `player-fit-test` | modern `.ytp-fullscreen-grid` neutralised; no horizontal overflow 1200–2560px; player + title above the fold |
| `extras-test`, `ux-test` | always-on scrubs; 5 page tabs, page memory, mass-clear + tombstones |
| `subs-ui-test` | options page: subs↓ default sort, "Show all" growing past the 300-row cap, the "No sub count" filter, auto-fetch on open, and no re-fetch of a count already recorded by the current `SUBS_SCRAPE_VERSION` |
| `popup-test` | popup counters + its off-YouTube state + "Manage blocklist"; and the contract its buttons rest on — `GET_PAGE_TARGET` returns one row per real channel, never the same channel under both identity formats (the `withAliases` split) |
| `bulkactions-test` | the bulk-select bar end to end: Hide / Video-only / Never-block / Unblock across a selection, and that bulk Unblock stays undoable |
| `duration-test` | the duration half of the keyword filter (shorter-than / longer-than bounds read off the real time badge, not "4K"/"New"), regex keywords, and that a malformed regex doesn't take the page down |
| `contextmenu-test` | pure Node: `ctxTargetFrom()` + its regexes lifted out of background.js — every video/channel URL shape resolves, `/c/` `/user/` home and search resolve to *nothing*, link beats page URL, menus scoped to youtube.com |
| `embeds-test` | `blockInEmbeds`: a youtube.com/embed iframe on a third-party page is untouched by default, blanked once opted in, and an unblocked channel's embed still plays |
| `comments-test` | a blocked channel's comment threads go while everyone else's stay, a comment that only *mentions* them survives, and video-only mode keeps their comments; the author to block is read off the live page rather than hard-coded |
| `feedloop-test` | the runaway-feed curb: a fully-blocked feed stops fetching and stays small, while an unblocked and a partially-blocked feed both still page normally on scroll |
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
const EXT_PATH = "/home/sonn/Documents/Projects/BlockTubeXrn";
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
verified this way. Cross-browser (Firefox) and mobile (`m.youtube.com`,
`ytm-*` selectors) are also unverified by this method; it only launches
Chromium.

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
