# The sync server

Every browser that should share one blocklist — the laptop, the phone — points
at one small server: `server/xrntube-sync.py`. It replaced the GitHub Gist
sync, and with it the reason the blocklist used to live in
`chrome.storage.sync` (see [architecture.md](architecture.md) → the blocklist
store).

## What it does

One JSON document per user — the same snapshot `background/server-sync.js`
builds: `{ v, channels, videos, tombstones, keywords, allowlist, settings }`.

| request | answer |
|---|---|
| `GET /state` | 200, the document (`{}` before the first push), `ETag: "<version>"` |
| `GET /state?since=<version>` | **304**, no body, while the document is still at that version; otherwise as above. A query, not `If-None-Match`, so a server older than this ignores it, where a header would have failed the CORS preflight |
| `PUT /state` + `If-Match: "<version>"` | 200 and the new `ETag`; **412** if another device wrote since that version; **428** without `If-Match` (`"*"` overwrites) |
| `GET /history` | the earlier copies kept, newest first: `{ items: [{ name, version, updated, channels, videos, keywords, allowlist }] }` |
| `GET /history/<name>` | one of them, as `GET /state` would have returned it then |
| `GET /download/<file>` | a file from `<data>/downloads` — the packed extension, for a phone to fetch |
| `GET /update/<file>` | **no login**: `updates.xml` or a `.crx` from `<data>/update` — what a browser's own extension updater polls (see below) |
| `GET /health` | `ok`, no login (for monitoring) |

Every path also works under the mount prefix (`/xrntube/state`), so it doesn't
matter whether the proxy in front strips it.

- **Login**: HTTP Basic against an htpasswd file of bcrypt hashes — Radicale's
  file works as-is, so a home server's calendar password can be the sync
  password. 2 s pause after a wrong password; a right one is cached for 10
  minutes so a phone-class CPU doesn't run bcrypt on every sync.
- **CORS**: any origin, `Authorization` / `If-Match` allowed, `ETag` exposed.
  The extension sends no cookies, so it needs no host permission for the
  server's address — which therefore never appears in the manifest or the repo.
- **gzip** both ways: the extension compresses its PUT (`CompressionStream`);
  the server compresses responses when asked. A few thousand channels is ~1MB
  of JSON.
- **Writes** are atomic (temp file + rename), one at a time under a lock.
- **History**: every write first keeps the copy it replaces, gzipped, as
  `<data>/users/<user>/history/<written-at>-v<version>.json.gz`, with the
  counts in `index.json` beside them so listing decompresses nothing. Kept:
  the newest `--keep-recent` (40), plus the newest of each of the last
  `--keep-days` (30) days — a few MB at a few thousand channels. A failed
  archive (full disk) is logged and the write goes ahead: history must never
  stop sync. This is what undoes a "Delete everything", which every device
  applies within a cycle.

## The extension's side

`server-sync.js` merges channels and videos last-write-wins per entry on
`updated_at`, with tombstones so an unblock isn't resurrected by a stale copy,
and the server's `Date` header as the clock. Keywords, the never-block list
and the settings merge three ways, item by item, against what the device and
the server last agreed on (`bt_sync_base`; see
[architecture.md](architecture.md) → `background/server-sync.js`). A push
carries the version it read, and a **412 just re-runs the cycle** on the newer
copy (nothing is lost; local edits are still in local storage). A version that
went *backwards* — the server reset, or `state.json` restored by hand — makes
the next cycle merge as a first sync (union, nothing counts as deleted).

**Restoring** (options → Sync → *Restore an earlier copy…*) lists
`GET /history`, fetches the chosen copy and hands it to the import preview.
That re-adds what the copy has and the list doesn't, with fresh timestamps,
so it wins over the tombstones the other devices hold; nothing added since is
removed. Don't restore by copying an old file over `state.json`: every device
holds newer tombstones for what you're trying to bring back, and the next
sync deletes it again.

**Idle polls cost nothing.** The document is the whole list (a few hundred
KB even gzipped) and each device polls every 3 minutes, so a device that
still holds exactly what it last agreed with the server — a hash of it,
`agreedFp` in `bt_sync` — pulls with `?since=<that version>` and gets a 304
unless another device has written since. The whole document is still pulled
every 6 hours (`SYNC.FULL_PULL_MS`), and a poll that arrives while a pull is
running, or within a minute of one, doesn't pull again: before both, a real
list cost ~150MB a day through the server, every poll fetching it twice.

`serversync-test` runs the real server with two browser profiles: a block
crosses, an unblock crosses, two devices writing at once both keep their
edits, settings / keywords / never-block entries changed on each device all
survive and deletions cross, idle syncing pushes nothing and pulls only
304s, a poll beside a running pull adds none, and a "delete
everything" is undone from history through the options page.

## Running it

```sh
python3 server/xrntube-sync.py --port 5233 \
  --data ~/xrntube-sync/data --users ~/.config/radicale/users
# optional: --keep-recent 40 --keep-days 30
```

Updating it is replacing the one file and restarting the process; the data
directory needs nothing (history starts with the next write). An extension
older than the server ignores `/history` and the `settings` field; a server
older than the extension answers 404 to *Restore an earlier copy…*, which the
options page reports as "this server keeps no history".

Put HTTPS in front of it (it listens on 127.0.0.1 only). With **Tailscale
Funnel**, mount it next to whatever else the host serves:

```sh
tailscale funnel --bg --set-path /xrntube http://127.0.0.1:5233
```

**Use `tailscale funnel`, never `tailscale serve`, to add the path.** `serve`
rewrites the port's config as tailnet-only and switches Funnel off for the
whole address — everything else that address serves goes off the public
internet with it. That happened once, to a calendar; `tailscale funnel status`
must say "Funnel on" afterwards.

Then on each device: options → **Sync** → the address including the mount
(`https://<host>/xrntube`), the user name, the password → **Connect**. The
extension refuses a plain `http://` address unless it is `localhost` or
`127.0.0.1` (Basic auth would show the password to the network), and sends
the saved password only to the address and user it was saved for.

## Updates

The phone runs the extension from a signed `.crx` whose manifest has an
`update_url` of `https://<host>/xrntube/update/updates.xml`; the browser polls
that every few hours (sooner from options → Sync → **Check now**) and
installs whatever newer version it names. That poll carries no login — a
browser's extension updater can't send one — so `/update/` is the one public
path, and it serves only `*.xml` and `*.crx` files: the extension's own code,
the same for every user. No blocklist ever goes there.

`npm run release` (`scripts/package.mjs --release`) publishes a version:

1. reads `~/.config/xrntube/release.json` — `{ "server": "https://<host>/xrntube",
   "ssh": "<ssh-host>" }`, where `"ssh"` may be a list tried in order (the
   tailnet, then the LAN), the first that answers being used — and the
   signing key `~/.config/xrntube/xrntube.pem` (made on the first release;
   neither is in the repo);
2. asks the server which version is live and, if it isn't older than
   `manifest.json`'s, bumps `manifest.json`'s last number past it — a browser
   only takes a higher version;
3. signs `dist/xrntube-<version>.crx` (the zip plus that `update_url`) and
   writes `dist/updates.xml`;
4. over ssh, puts the `.crx` (as itself and as `xrntube.crx`, the link a new
   install starts from) into `<data>/update/`, then `updates.xml`, each moved
   into place whole, and removes older `.crx` files;
5. reads `updates.xml` back through the public address to confirm.

**The key is the extension's identity.** Its ID is derived from the key, and
a browser only accepts an update signed by the key it installed. Lose it and
every device has to install a new `.crx` under a new ID — whose storage starts
empty until sync refills it, and whose Sync login has to be typed again.

The zip (`npm run package`, or `--upload <ssh-host>` to put it in
`downloads/`, served at `https://<host>/xrntube/download/xrntube.zip`) has no
`update_url` — the Chrome Web Store refuses one — and a browser loads it
unpacked, so it never updates.
