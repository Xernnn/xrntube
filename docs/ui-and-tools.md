# Peripheral features

The locale layer, right-click blocking, debug mode, and the undo log.

## UI-language labels (`LABELS_BY_LANG` / `L` in content.js)

Most of YouTube's chrome is matched by tag name / href / stable id — all
locale-proof. The handful matched by visible text — the watch-page action
buttons, masthead Create / voice search, the "Join" / "Members only"
wording, the guide's Explore / "More from YouTube" / "Report history" — read
from `LABELS_BY_LANG[UI_LANG]` (detected from `<html lang>` then
`navigator.language`), with the English strings always merged in and English
the fallback for an unlisted language. Six languages ship (en, vi, es, pt,
fr, de); adding one is a data edit. `ariaSel()` interpolates the label lists
into the static CSS (`cleanMasthead` / `hideVoiceSearch` / `hideVideoActions`
/ `hideAskYouTube` selectors); the JS scrubs (`scrubVideoActions`,
`scrubGuide`, `scrubMasthead`, `scrubMembersOnly`) build `Set`s / regexes
from them.

`askAi` is the one label list that is deliberately **English-only**. It backs
`hideAskYouTube` (the AI chat button beside the search box, which ships as
both "Ask YouTube" and a bare "Ask"), but that rule's real hook is
`.you-chat-entrypoint-button` — YouTube's own semantic class for the control,
which needs no translation. The labels exist only as a fallback for that
class being renamed, so guessing translations for them would add risk without
adding coverage. Note also that the button's *other* classes are the generic
`ytSpecButtonShapeNext*` set every button on the site carries: matching those
would hide half the chrome. Its neighbour `hideVideoSummaries` (the AI
summary card in a search result) needs no labels at all: the card's
`has-video-summary` attribute and its `video-summary-content-view-model`
child are both structural, and the visible "Summary" heading is localised, so
matching it would be the worse hook.
`parseAgeDays()` is **separate and fully language-independent**: `AGE_UNITS`
is a `[unit-spellings-across-~15-languages, days]` table, anchored by the
preceding `<number>` so a short token can't match inside a word
(`locale-age-test.mjs` guards it).

## Right-click to block

`background.js` registers two `chrome.contextMenus` items on youtube.com
(`documentUrlPatterns`), created in `onInstalled` via `setUpContextMenus()`:
"block this channel" and "block this video".

A menu item cannot inspect what you right-clicked *before* it is shown, so
both always appear and `ctxTargetFrom(info)` works out the target on click
from `info.linkUrl || info.srcUrl || info.pageUrl` — the link under the
cursor deliberately wins over the page, so right-clicking a tile on a watch
page blocks the tile and not what you are watching. It understands the same
URL shapes the nav guard does. **`/c/…` and `/user/…` name neither identity
format and are reported as unresolvable rather than guessed at** — blocking
the wrong channel is far worse than doing nothing.

"Block this channel" on a *video* link has no channel in the URL, so it
falls back to `resolveVideoChannel()` — the same cached oEmbed lookup the
`/embed/` guard uses. Blocks are stored with an empty name and
`enrichChannelIdentity()` fills in the real name and the other identity
format afterwards, exactly as a popup block does.

Feedback goes through `MSG.SHOW_TOAST` to the content script (a
`<bt-toast>` with inline styles, so no stylesheet — ours or YouTube's — can
affect it, and it matches none of our own scrub selectors). That is
deliberate: the alternative, `chrome.notifications`, would add an
install-time permission prompt for the sake of a one-line confirmation. A
toast is also the only way to report the unresolvable cases above, since the
thing you right-clicked is often not visibly affected.

`contextmenu-test` lifts `ctxTargetFrom()` and its regexes straight out of
`background.js` and runs them in pure Node — a native context menu can't be
opened from Playwright, but the part that can actually be wrong is working
out *what* was clicked.

## Hover-menu Undo

A block from a tile's 🚫 menu (`injectBlockButton()` → `blockAndRemove()`)
removes the tile at once and then calls `showToast(label, { label: "Undo",
run })` — the same `<bt-toast>` banner the right-click block uses, which
stays click-through except for its one button. Undo **awaits the block's own
message first**: the background handles messages concurrently, so an unblock
sent before the block's write lands finds nothing to remove and the block
then completes on its own. The tile itself does not come back until YouTube
renders that list again; the second toast says so.

## Debug mode

`?bt-debug` in the URL or `localStorage.bt_debug === "1"` turns on `DEBUG` in
`content.js`. `dbg()` then logs every removal with its `blockReason()` string
to the page console (visible under the content script's context), and
`window.__xrnTube` (isolated world — reach it via the console's JS-context
dropdown) exposes `state()`, `why('<selector>' | element)` (runs
`extractInfo` + reports each channel key's index resolution + the
`blockReason` verdict), and `enable()` / `disable()`.

Without debug mode, the popup's **health line** is the one diagnostic on
every tab, phone included: how many tiles this page view lost before they
appeared (layer 0) and just after (the DOM scrub), or a ⚠ when page-hook.js
never answered or `noteLayer0Miss()` crossed its threshold. See
[architecture.md](architecture.md) → `popup/`.

## Recently-removed undo log

`chrome.storage.local` key `bt_recent_unblocks` (not synced) — newest-first,
capped at `RECENT_UNBLOCK_MAX` (40) records **and** `RECENT_UNBLOCK_MAX_ENTRIES`
(20,000) entries across them, always keeping the newest record whole however
big — that's the one an Undo toast points at. Three record shapes:

- `{ t: "one", kind, id, entry }` — `removeEntry()` (a row's Delete, the
  popup's Unblock). The full entry, so a restore keeps
  mode/whitelist/handle/age rule.
- `{ t: "bulk", kind: "mixed", channels, videos, keywords?, allowlist?, count }`
  — `DELETE_DATA` (bulk Delete, every delete-all, the danger zone).
- `{ t: "bulk", kind, entries, count }` — written by older versions'
  "clear all videos"; still restorable.

Every record's `ts` is its id: strictly increasing, returned to the caller as
`undoTs`. `RESTORE_UNBLOCK { ts }` (or the older `{ index }`) merges the
record back in **one** write, skipping anything blocked again since, unions
keywords and the never-block list back in, and drops the record.
`GET_RECENT_UNBLOCKS` / `CLEAR_RECENT_UNBLOCKS` round it out. Shown as the
**Recently removed** `<details>` at the bottom of the options Blocklist tab;
the same restore is what a removal toast's **Undo** does.
