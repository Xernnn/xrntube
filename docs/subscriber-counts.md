# Where the subscriber count comes from, and why it is fetched once

Two linked stories: how `scrapeChannelInfo()` reads a number that is
actually *that channel's*, and why the options page sweeps for it exactly
once per entry. Both are load-bearing for blocking itself — see
[blocking-rules.md](blocking-rules.md) → "Channel identity".

## Where the subscriber count comes from

**The only place on a channel page that describes that channel is its own
`pageHeaderRenderer`, and it is at the very END of the document.** Everything
before it is feed content — shelves of other people's videos and channel
cards, each carrying its own `"subscriberCountText"`. So the obvious
implementation, "fetch the channel page and regex out the first sub count",
is wrong twice over, and both failures look identical in the options page (a
blank chip):

- On a small channel it returns **someone else's number**. Measured live:
  `@mkbhd` read as "1.15M" (he has 21.3M), `@NASA` as "62.9K" (15.1M),
  `@arte` as "1.11M" (5.04M).
- On a big one the streaming reader hits its byte cap before reaching the
  header and returns **nothing at all**. Across a 27-channel sample, 10 came
  back with no count — which is what "some channels never get a sub count"
  actually was.

This is the same trap as the `externalId` one in [blocking-rules.md](blocking-rules.md) → "Channel identity", and it is why the parser
now slices the document at `"pageHeaderRenderer":{` and reads *only* inside
that block. Its shape is stable and pleasant:

```
"metadataRows":[ {"metadataParts":[{"text":{"content":"@mkbhd"}}]},
                 {"metadataParts":[{"text":{"content":"21.3M subscribers"},…},
                                   {"text":{"content":"1.8K videos"}}]} ]
```

**Which page to fetch is a measured choice, not a default.** The channel home
and `/about` are ~2.5MB with the header at the very bottom; the channel's
**search tab with a query that matches nothing**
(`/@handle/search?query=zzqqxx9182`) has no feed content, so it is a
consistent **~800KB with the header at ~765KB** — and `<link rel="canonical">`,
`<meta itemprop>`, `og:title`, `vanityChannelUrl` *and* the authoritative
`"externalId"` all land inside that window too, which they did not before.
Compressed that is ~235KB on the wire, the same as the old (wrong) 1.5MB read
of the home page, so correctness here cost no bandwidth. If a channel's search
tab yields no header (a consent wall, or a handle that redirects to a
non-channel marketing page like `@YouTubeCreators` → `/ytcreators`), the scrape
falls back to the full channel page before giving up.

Reading strictly inside the header also makes the answers *meaningfully*
distinguishable:

- Two parts in the second row (`subscribers`, `videos`) → a count.
- **One** part (just `videos`) → the channel **hides** its count →
  `subs: "hidden"`. A real answer; never retried.
- No header → nothing recorded → retried later.

The English match (`"… subscribers"`) is tried first, then a structural
fallback takes the row's first part — which is the count in every UI language.
That fallback **must** require the row to have two parts: a hidden-count
channel renders the same row with only the video count in it, and taking
part 0 unconditionally wrote `"12 videos"` into the subscriber field. (Caught
by `subs-scrape-test`, which was written before the fix and failed on it.)

Because version 1 of the scrape wrote numbers that are *wrong* rather than
merely old, `subsAttempted()` is gated on `entry.subsV >=
SUBS_SCRAPE_VERSION`, not just on `subsAt`: every entry from the old scrape
is re-fetched exactly once, then left alone forever. `IMPORT_BLOCKLIST`
carries `subsV` across so re-importing an export doesn't re-sweep counts that
are already current.

## Subscriber counts are fetched once

Opening the options page kicks off `autoFetchMissingSubs()`, which queues
every channel with **no recorded attempt** on the background sweep
(`START_SWEEP`; the background drops ids already queued). The sweep keeps
going after the page closes, pauses itself when YouTube throttles, and ends by
rebroadcasting — so the counts, `@handle`s and real names reach open tabs and
the sync server without anyone pressing a button.

The gate is `subsAttempted(entry)` (`!!entry.subsAt`), **not** "has a count":

- A cached count is kept forever — there is no staleness window. Sub counts
  drift slowly and nothing in the extension depends on them being current, so
  re-scraping thousands of channel pages on a timer buys a rounded "12.4M"
  that was already right, at the price of a long sweep and YouTube
  rate-limiting. Clicking a chip still forces a refresh for that one channel.
- A channel that *hides* its count, or has none, records `subsAt` with no
  `subs`, so it is not retried on every open forever — it just sits in the
  **No sub count** tab.
- A hard fetch failure records nothing (a lookup only writes channels whose
  scrape returned something), so genuinely transient errors are retried next
  time — and throttling (a 429, or a fetch that throws because YouTube
  redirected to Google's "unusual traffic" page) pauses the whole sweep with
  the channel still queued.
- A channel that is **gone** — deleted, terminated, or renamed so its old
  `@handle` 404s — is permanently unfetchable, and treating that as a
  transient failure is what made "some channels never get a sub count" a
  standing complaint: `scrapeChannelInfo()` returned `null` for *every* non-OK
  status, so nothing was recorded, so the auto-fetch asked again on every
  options-page open, forever, and the row sat in **No sub count** looking like
  it just hadn't loaded yet. A 404/410 now returns `{ gone: true }`;
  `applyChannelInfo()` stamps `gone: true` + `subs: "n/a"` + `subsAt`, the row
  shows a quiet **gone** tag so the blank is explained rather than merely
  blank, and the entry is never queued again. 5xx and network errors
  deliberately still record nothing — those *are* worth retrying. The flag is
  not permanent: a later successful scrape deletes it (`if (e.gone) delete
  n.gone`), covering a channel that was only temporarily unreachable and a
  handle that gets re-registered. `IMPORT_BLOCKLIST` carries `gone` across, so
  restoring a backup doesn't put every dead channel back in the queue.

  **Not every dead channel 404s.** A `/channel/UC…` that names no real channel
  serves a full **200** page with no channel header and
  `"alerts":[{"alertRenderer":{"type":"ERROR","text":…"This channel does not
  exist."}}]`. Status alone therefore misses it, and it went back in the queue
  on every open. The scrape treats *no header* **plus** an `ERROR`
  `alertRenderer` as gone — structural, because the alert text is localised,
  and requiring the missing header is what keeps it off a live channel page
  that happens to carry an error alert somewhere in its feed.
  `gone-test` guards all of it.

That combination is what makes the auto-fetch self-limiting: it does real
work on the first open after an import and nothing at all on later opens.
Because it is the ordinary bulk job, the "Fetch all sub counts" button still
doubles as Stop while it runs, and it resumes where it left off. Note that
the enrichment is worth having beyond the numbers: a `UC…`-keyed channel does
not block modern feed tiles until its `@handle` is known (see "Channel
identity").

## One identity is not a result

A lookup that comes back with the channel's header pairs its identities: a
`UC…` entry learns its `@handle`, an `@handle` entry its `UC…` id. One that
leaves the entry knowing only the format it is keyed by (`knowsOneIdentity()`
in `shared/constants.js`) is a problem, not a cosmetic gap — tiles link one
format or the other by surface, so that channel still shows wherever the
missing one is used (see [blocking-rules.md](blocking-rules.md) → "Channel
identity").

**Measured on a real list:** a fifth of its entries were `UC…`-keyed with no
`@handle`, nearly all stamped by one sweep on one day and most with no count
either — and every one sampled weeks later looked up fine, handle, count and
matching `UC…` id. The sweep had run while YouTube was throttling,
the pages it got had no channel header, and `lookupChannels()` recorded
"nothing found" as an answer. `subsAttempted()` then counted them as done
forever, and the review dialog called them "Lookup failed" and **ticked them
for deletion** — one click away from unblocking all of them.

Three changes, together:

- **Nothing found is not recorded.** A scrape with no header and no handle,
  id or count is treated like a 5xx: unrecorded, asked again next sweep. (The
  doc above already said "no header → nothing recorded"; the code didn't.) A
  gone channel is unaffected — that is decided first, by status or by the
  error alert.
- **One identity is retried.** `resolveRetryDue()` puts such an entry back
  in the options page's auto-fetch when its last lookup is `RESOLVE_RETRY_MS`
  (3 days) old, until `idTries` — counted by `applyChannelInfo()` on every
  lookup that still leaves it with one identity, cleared once it pairs —
  reaches `RESOLVE_MAX_TRIES` (3). A channel that really has no handle stops
  being asked about after that. Entries recorded before `idTries` existed
  start at 0, so the old backlog gets its retries right away.
- **The sweep drops what's no longer due.** Every device's options page
  queues the same retries, and the answers reach the other devices through
  sync. Before each batch, `runSweep()` drops ids whose entry is gone or now
  attempted-and-not-due, so two devices don't double what YouTube throttles
  on.

The review dialog splits the old "Lookup failed" group into **Only one ID
found** (says when retries are pending) and **No sub count** (cosmetic), and
pre-ticks neither. `datatools-test` covers the dialog, the retry gate (due,
out of tries, tried recently) and the unrecorded headerless page, against a
faked YouTube.

