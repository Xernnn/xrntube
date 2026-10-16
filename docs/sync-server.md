# The sync server

Every browser that should share one blocklist — the laptop, the phone — points
at one small server: `server/xrntube-sync.py`. It replaced the GitHub Gist
sync, and with it the reason the blocklist used to live in
`chrome.storage.sync` (see [architecture.md](architecture.md) → the blocklist
store).

## What it does

One JSON document per user — the same snapshot `background/server-sync.js`
builds: `{ v, channels, videos, tombstones, keywords, allowlist }`.

| request | answer |
|---|---|
| `GET /state` | 200, the document (`{}` before the first push), `ETag: "<version>"` |
| `PUT /state` + `If-Match: "<version>"` | 200 and the new `ETag`; **412** if another device wrote since that version; **428** without `If-Match` (`"*"` overwrites) |
| `GET /download/<file>` | a file from `<data>/downloads` — the packed extension, for a phone to fetch |
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

## The extension's side

`server-sync.js` keeps the merge the Gist version had — last-write-wins per
entry on `updated_at`, tombstones so an unblock isn't resurrected by a stale
copy, the server's `Date` header as the clock. Only the transport is new: a
push carries the version it read, and a **412 just re-runs the cycle** on the
newer copy (nothing is lost; local edits are still in local storage).
`serversync-test` runs the real server with two browser profiles: a block
crosses, an unblock crosses, two devices writing at once both keep their
edits, a wrong password is refused.

## Running it

```sh
python3 server/xrntube-sync.py --port 5233 \
  --data ~/xrntube-sync/data --users ~/.config/radicale/users
```

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
(`https://<host>/xrntube`), the user name, the password → **Connect**.

To hand the phone the extension: `node scripts/package.mjs --upload <ssh-host>`
copies `dist/xrntube-<version>.zip` to the server's `downloads/` (as itself and
as `xrntube.zip`), served at `https://<host>/xrntube/download/xrntube.zip`.
