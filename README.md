# BlockTube

A browser extension that **deletes** blocked YouTube channels and videos from
your feed, search results and recommendations. Not a greyed-out "this channel
is blocked" placeholder — the tile is removed from the page, so a blocked
channel simply stops existing for you.

Works on Chrome, Edge, Brave and Firefox 128+, including Firefox for Android.
No account, no server, no telemetry; your blocklist stays in your browser
(and, if you want it on another vendor's browser, in a private GitHub Gist
you own).

**What you can block**

- A **channel** — everything of theirs, everywhere: feeds, search, playlists,
  community posts, comments, and their own channel page.
- A **channel's videos only** — keep the channel reachable, drop its uploads,
  and whitelist individual videos or recent uploads as exceptions.
- A **single video**.
- Anything whose **title matches a keyword or regex**.
- Anything **shorter or longer** than a duration you set.

Plus an optional site cleanup — Shorts, the home feed, the related-videos
column, end-screen suggestions, sidebar clutter and more — as 35 individual
switches you can turn off one by one.

---

## Contents

- [Install](#install)
- [Blocking your first channel](#blocking-your-first-channel)
- [Two ways to block a channel](#two-ways-to-block-a-channel)
- [Keyword and length filters](#keyword-and-length-filters)
- [Never-block list](#never-block-list)
- [Managing a big blocklist](#managing-a-big-blocklist)
- [Importing from the original BlockTube](#importing-from-the-original-blocktube)
- [What gets hidden (site cleanup)](#what-gets-hidden-site-cleanup)
- [Sync between browsers](#sync-between-browsers)
- [Permissions and privacy](#permissions-and-privacy)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [For developers](#for-developers)

---

## Install

There is no build step — the extension runs from the source folder exactly as
it is in this repository.

**1. Get the files**

```bash
git clone <this-repo> blocktube
```

…or download the repository as a ZIP and unpack it somewhere permanent. The
browser loads the extension *from that folder*, so don't delete or move it
afterwards.

**2a. Chrome / Edge / Brave**

1. Open `chrome://extensions` (or `edge://extensions`, `brave://extensions`).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and select the folder you just unpacked.
4. Pin the 🚫 icon to your toolbar if you want the quick-block popup handy.

**2b. Firefox (desktop)**

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on…** and pick `manifest.json` in the folder.

Temporary add-ons vanish when Firefox restarts. For a permanent install,
package and self-sign it (`npm run build:firefox`, then submit the `.zip` to
addons.mozilla.org as an **unlisted** add-on — no public review, just
Mozilla's automated signing).

**2c. Firefox for Android**

Stable Firefox for Android only installs extensions signed through AMO, so
sideloading a folder isn't possible:

1. `npm i -g web-ext`
2. `web-ext sign --api-key=… --api-secret=…` from this folder, using a free
   [AMO API key](https://addons.mozilla.org/developers/addon/api/key/). This
   uploads it as an **unlisted** add-on and returns a signed `.xpi`.
3. Open the resulting AMO link in Firefox for Android and tap install (or
   `adb push` the `.xpi` and open it locally).

Mozilla's Android extension policy has shifted more than once — if a step
doesn't match what you see, check `extensionworkshop.com` before assuming
something is broken.

**Updating**: `git pull`, then hit **Reload** on the extension in
`chrome://extensions`. Refresh any YouTube tab you already had open — content
scripts only attach at page load.

---

## Blocking your first channel

Three ways, all equivalent:

| where | how |
|---|---|
| **On a tile** | Hover any video/playlist tile → a 🚫 button appears in its bottom-right corner → pick *Block this video*, *Block channel: X*, or *Block all videos from X* |
| **Right-click** | Right-click a video or channel link (or anywhere on a watch page) → **BlockTube: block this channel** / **block this video** |
| **Toolbar popup** | On a video or channel page, click the 🚫 toolbar icon — it lists the video and every channel it found, with both block modes per channel |

A tile that credits several channels (YouTube's collaboration attribution)
offers each one separately, so you can block the collaborator without the
uploader.

Blocked by mistake? The popup's **Manage blocklist** button opens the full
options page, where **Recently unblocked** can restore anything you removed in
the last 40 unblocks — including a mass clear.

---

## Two ways to block a channel

Everywhere a channel can be blocked, you get both:

- **Block channel** — the hard option. Their page redirects to Subscriptions,
  and every video, playlist, community post and comment of theirs is removed
  wherever it appears.
- **Block all videos (allow some later)** — the soft option. The channel's own
  page stays reachable and its channel card stays visible in search, but its
  videos are removed everywhere. Their comments stay too, since you didn't
  block *them*, you blocked their uploads.

A soft-blocked channel gets a panel in the options page with two exceptions
you can grant:

- **A whitelist** — paste a video URL or a bare 11-character ID and that one
  video always plays.
- **"Only block videos older than N days"** — hide the back catalogue, keep
  the last N days of uploads. Useful for a channel you want to keep half an
  eye on. Relative dates ("3 days ago") are understood in about 15 languages;
  a video whose age can't be read is never blocked by this rule.

You can flip a channel between the two modes at any time from the same panel.
A directly-blocked *video* has no modes — there's nothing softer than blocking
one video.

---

## Keyword and length filters

The **Keywords & length** tab holds two filters that apply to every video,
from any channel:

- **By title** — a list of words or phrases; any video whose title contains
  one is removed from feeds and search, and opening it directly bounces you
  out. Matching is case-insensitive. Tick *regex* on a row to treat it as a
  regular expression (a malformed one is ignored rather than breaking the
  page).
- **By length** — a minimum and/or maximum duration. Anything outside the
  range goes. Handy for cutting Shorts-length clips or three-hour streams.
  Leave a field blank for "no limit".

Both sync alongside the blocklist. They are applied by script rather than by
CSS (a title has to be read before it can be matched), so a matching tile can
be visible for a frame longer than a blocked channel's would be.

---

## Never-block list

The **Never block** tab is a hard override. A channel on it stays visible even
if a keyword, a length rule, an age rule, a collaborator block or a direct
block would otherwise hide it, and its own page stops redirecting. Add it by
`@handle`, `UC…` ID, or full channel URL.

Use it when a broad rule sweeps up someone you actually wanted, instead of
narrowing the rule. (A tile already removed before you allow-listed the
channel comes back on YouTube's next render, not instantly.)

---

## Managing a big blocklist

The options page (toolbar popup → **Manage blocklist**, or the extension's
Options entry) has five tabs — **Blocklist**, **Keywords & length**, **Never
block**, **What gets hidden**, **Sync** — and reopens on whichever you used
last.

The Blocklist tab's controls sit in one row:

- **Search** — filters channels and videos by name, handle or ID.
- **Show** — All / Full-blocked / Video-only / Videos / No sub count / Hidden.
- **Sort** — Biggest first (default) / Smallest first / Newest first / A–Z.
- **Select** — turns on checkboxes plus **All shown**, then acts on the whole
  selection at once: **Hide**, **Video-only**, **Never block**, **Unblock**.
- **⋯** — the once-in-a-while things: *Fetch all sub counts*, *Load counts for
  shown*, *Hide under N subs*, *Export JSON*, *Import JSON*, *Clear all
  blocked videos*.

Each row shows the name on one line and a quiet second line with the
`@handle`, the subscriber count, the block mode, and a **gone** tag if the
channel no longer exists. **Unblock** sits on the right; **⋯** opens a drawer
with **Hide** (removes the row from the manager without unblocking — the
*Hidden* filter brings it back), the mode switch, and the whitelist/age panel
for a soft-blocked channel.

**Subscriber counts** are scraped from the channel's own page, no API key.
Opening the options page quietly fetches the ones it has never tried; clicking
a chip refetches that one. A count is kept forever once known — nothing here
depends on it being current, and a channel that hides its count or has been
deleted is recorded as such instead of being retried on every visit.

That same pass fills in each channel's real name and its **`@handle`**, which
matters more than it sounds: see below.

---

## Importing from the original BlockTube

**⋯ → Import JSON** accepts both this extension's export and the original
BlockTube's export format. A few thousand channels import in well under a
second.

**Then let the sub-count sweep finish.** Old BlockTube lists are keyed by
`UCxxxx…` IDs, but modern YouTube feed and search tiles link a channel by
`@handle` — so a `UC…`-only entry matches nothing in your feed until the
handle is known. The import offers to run the sweep for you; it runs several
channels at a time, has a Stop button, and resumes where it left off. The
Blocklist tab shows a "N may not block everywhere yet · Resolve" note while
any entry is still unpaired.

---

## What gets hidden (site cleanup)

Separate from blocking, the **What gets hidden** tab turns off parts of
YouTube itself — 35 switches in 7 groups, each one a single thing removed. All
are on by default except *Block embedded videos too*. A group's master switch
flips its whole row.

| group | switches |
|---|---|
| **Shorts** | shelves and tiles · the full-screen player · the Shorts tab on channels |
| **Home page and navigation** | skip the home feed (goes to Subscriptions) · point the logo at Subscriptions |
| **Left sidebar** | Home · Shorts · Explore · More from YouTube · Report history · the small-print footer |
| **Top bar** | Create (+) · Notifications bell · voice search · search autocomplete · “Ask YouTube” AI button · account avatar until hovered |
| **Watch page** | related-videos column · end-screen suggestions · channel card in the description · Share · Save · Download · Clip · Thanks · More (…) |
| **Channel page** | Join button · membership price offers · members-only videos · Membership tab · Posts · Shows · Podcasts · Store tabs |
| **Embeds on other sites** | block embedded YouTube players on third-party sites (**off by default** — the only switch that affects sites other than YouTube) |

Removing the related-videos column also widens the player to use the freed
space, but only as far as keeping the player *and* the title on screen without
scrolling.

Blocking channels and videos is not a switch — it's the point of the
extension. Some changes need a page refresh.

---

## Sync between browsers

**Layer 1 — your browser's own sync (automatic).** The blocklist lives in
`chrome.storage.sync`, so Chrome↔Chrome (same Google account) and
Firefox↔Firefox (same Firefox account) sync with no setup. It does **not**
bridge vendors: Chrome desktop ↔ Firefox for Android will never sync this way.
It also holds roughly 480 entries before extra ones become local-only (a limit
of the sync API, flagged in the options page).

**Layer 2 — a private GitHub Gist (opt-in, closes both gaps).**

1. Create a [fine-grained personal access token](https://github.com/settings/tokens?type=beta)
   with **only** *Gists → Read and write*. No repo access needed.
2. Paste it into the **Sync** tab on each device and click **Connect**.

The first device creates a private gist (`blocktube-blocklist.json`); every
other device with the same token finds it and pulls. After that it's
automatic: a change pushes within seconds and other devices pull on a timer,
so expect a short delay rather than an instant update. Merging is
last-write-wins per entry with tombstones, so a stale device can't resurrect
something you unblocked, and timestamps come from GitHub's clock rather than
your devices'. The whole list rides the gist — including entries too numerous
for layer 1.

The token is stored locally on that device and never synced. Anyone holding it
can read and write all your gists, so treat it like a password and revoke it
on GitHub if it leaks. **Disconnect this device** stops syncing there without
touching your blocklist.

---

## Permissions and privacy

| permission | what it's for |
|---|---|
| `storage` | your blocklist, settings and keywords |
| `declarativeNetRequest` | redirecting a blocked video/channel URL at the network layer, before the page renders |
| `contextMenus` | the right-click "block this channel / video" items |
| `alarms` | the periodic gist-sync poll |
| `*://*.youtube.com/*` | the content script, and fetching a channel page to read its subscriber count and `@handle` |
| `https://api.github.com/*` | gist sync — only used once you paste a token |

Nothing is sent anywhere else. There is no analytics, no account, and no
remote config. The only outbound requests are to youtube.com (pages you were
visiting anyway, plus the channel-info scrape) and, if you opt in, to your own
GitHub gist.

---

## Troubleshooting

**"I blocked them and their videos are still in my search results."** Almost
always an unresolved identity: the entry knows one of `UC…` / `@handle` and
the tile links the other. Run **⋯ → Fetch all sub counts** to pair them up.

**"It throws me out of a video I should be allowed to watch."** Check the
channel's age rule and whitelist in its options-page panel.

**Why isn't *this* blocked?** Add `?bt-debug` to any YouTube URL (or run
`localStorage.setItem("bt_debug", "1")` once). The console then logs every
removal with its reason, and `window.__blockTube` — reachable by switching the
console's JavaScript-context dropdown to **BlockTube** — gives you `state()`
and `why("<CSS selector>")`, which explains a tile: the channel keys it
carries, how each resolves against the blocklist, and the verdict.

**Nothing at all is being removed.** Reload the extension from the browser's
extensions page and refresh the YouTube tab; content scripts only attach at
page load.

---

## Known limitations

- **`music.youtube.com` is not covered at all.** YouTube Music's DOM shares
  almost nothing with the main site, so a blocked channel is fully reachable
  there.
- **Related-videos tiles name no channel.** With the related column turned back
  on, a blocked channel's videos can appear there — those tiles carry only a
  video link and a display name, and matching on a display name would block
  the wrong channel. Left alone deliberately.
- **Mobile (`m.youtube.com`) is unverified.** Selectors for it are included but
  have never been tested against a real device.
- **Third-party embeds are opt-in**, and an embed can only be blanked from the
  inside — the `<iframe>` itself can't be removed from a page we don't run on.
- **Network-level redirects are capped** at ~800 videos and ~3000 channels
  (most recently blocked first). Past that a blocked page still redirects, just
  a moment later, via the content script.
- **The instant pre-paint hide covers the 400 most recently blocked channels**
  and 250 videos. Older entries are still blocked — they're removed a frame
  later instead of never being painted. The cap is a measured performance
  budget, not an arbitrary number.
- **YouTube redesigns things.** When a surface stops being cleaned, it's
  usually a renamed component; `docs/fragility.md` lists the ones that have
  already changed once.

---

## For developers

```
manifest.json
background/background.js    storage engine, DNR rules, message routing
background/gist-sync.js     optional cross-browser sync via a private GitHub Gist
content/content.js          pre-paint CSS, DOM scrubbing, hover UI, nav guards
content/content.css         the hover block button
popup/                      quick-block UI for the current page
options/                    blocklist manager, filters, settings, sync setup
shared/constants.js         message types + storage config shared everywhere
test/                       end-to-end suite — real Chromium against live YouTube
docs/                       architecture, blocking rules, known fragility
package.json                dev tooling only (Playwright, web-ext); no build step
```

```bash
npm run check   # syntax-check every script + parse the manifest
npm test        # full e2e suite (needs npm install once, and network)
```

Start at [docs/architecture.md](docs/architecture.md) for how the four
contexts fit together; the rest of [docs/](docs/) has the detail, and
[test/README.md](test/README.md) covers the suite.
