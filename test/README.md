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

## Known flaky assertion

`settings-test.mjs` — "removeShorts on: 0 Shorts shelves remain" occasionally
sees a late-hydrating Shorts tile on the `news+shorts` search page. It's
timing, not a regression; re-run.

## What isn't covered

No signed-in account is used or improvised, so: masthead Create/Notifications,
a real Subscriptions feed, personalized recommendations. Chromium only — no
Firefox, no `m.youtube.com` / `ytm-*`.
