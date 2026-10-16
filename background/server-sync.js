// ---------------------------------------------------------------------------
// Blocklist sync through your own server (server/xrntube-sync.py).
//
// chrome.storage.sync only bridges browsers signed into the same Google
// account, and a phone browser such as Quetta has no account sync at all. So
// every device that should share one blocklist points at a small server you
// run — the user's home server, published over HTTPS — with a user name and
// password typed into the options page once per device.
//
// Wire format — one JSON document per user on the server:
//   { v: 1,
//     channels:   { <key>: { name, ts, updated_at, mode, whitelist, … } },
//     videos:     { <id>:  { title, ts, updated_at } },
//     tombstones: { "channel:<key>" | "video:<id>": <deletedAtMs> },
//     keywords:   { list: [{ p, re }], ts, durMinSec, durMaxSec, commentLimit },
//     allowlist:  { list: { <key>: { note, ts } }, ts },
//     settings:   { <leaf>: bool } }   — the "What gets hidden" switches
//
// Channels and videos merge last-write-wins per entry on `updated_at`, with
// tombstones so an unblock on one device is not silently resurrected by a
// stale copy on another. Timestamps come from the server's `Date` header (fed
// back to background.js via host.setClockOffset) rather than the device clock,
// so skew between devices can't decide a merge. Tombstones past
// STORAGE.TOMBSTONE_TTL_MS are dropped on each cycle.
//
// Keywords, the never-block list and settings have no tombstones; they merge
// three ways against STORAGE.SYNC_BASE_KEY (see mergeItems). Item by item, so
// a keyword added on the phone and another added on the laptop between two
// syncs both survive — the whole-record last-write-wins this replaced kept
// only one of them.
//
// A push carries the version it read (If-Match): when another device wrote in
// between, the server answers 412 and the cycle simply runs again on the
// newer copy.
//
// There is no realtime channel: a change propagates on the next poll
// (SYNC.POLL_PERIOD_MIN) or the next debounced push after a local edit. The
// poll alarm also backstops the debounce timer, which a suspended service
// worker can otherwise drop.
//
// This module never touches blocklist storage directly — background.js passes
// it a `host` with the few operations it needs, and calls serverSync.init(host).
// ---------------------------------------------------------------------------
(() => {
  const { STORAGE, SYNC, KEYWORDS_KEY, ALLOWLIST_KEY, SETTINGS_KEY, resolveSettings } = self.XrnTube;

  let host = null;

  // In-memory mirror of the chrome.storage.local `bt_sync` record.
  let cfg = null;

  let pushTimer = null;
  let running = false; // exactly one cycle at a time
  let rerunQueued = false; // a trigger arrived mid-cycle → run once more after

  async function loadCfg() {
    const res = await chrome.storage.local.get(STORAGE.SYNC_KEY);
    cfg = Object.assign(
      {
        url: null, // e.g. https://myserver.example/xrntube
        user: null,
        password: null,
        lastVersion: null, // the server's ETag for what we last read or wrote
        lastPulledAt: 0,
        lastPushedAt: 0,
        lastError: null,
        clockOffset: 0
      },
      res[STORAGE.SYNC_KEY] || {}
    );
    return cfg;
  }

  async function persistCfg() {
    await chrome.storage.local.set({ [STORAGE.SYNC_KEY]: cfg });
  }

  // ---- the server --------------------------------------------------------
  const enabled = () => !!(cfg && cfg.url && cfg.user);

  function authHeader() {
    // btoa() takes Latin-1 only; encode first so any password works.
    const bytes = new TextEncoder().encode(`${cfg.user}:${cfg.password || ""}`);
    return "Basic " + btoa(String.fromCharCode(...bytes));
  }

  async function request(method, body, ifMatch, path = "/state") {
    const headers = { Authorization: authHeader() };
    if (ifMatch) headers["If-Match"] = ifMatch;
    let payload;
    if (body !== undefined) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body);
      // A few thousand channels is ~1MB of JSON; gzip it when the browser can.
      if (typeof CompressionStream === "function") {
        payload = await new Response(new Blob([payload]).stream().pipeThrough(new CompressionStream("gzip"))).blob();
        headers["Content-Encoding"] = "gzip";
      }
    }
    const r = await fetch(cfg.url.replace(/\/+$/, "") + path, { method, headers, body: payload, cache: "no-store" });

    // Trust the server's clock over the device's for merge timestamps. Kept in
    // memory here; persisted with the rest of cfg at the end of the cycle.
    const dateHeader = r.headers.get("date");
    if (dateHeader) {
      const offset = new Date(dateHeader).getTime() - Date.now();
      if (Number.isFinite(offset)) {
        cfg.clockOffset = offset;
        if (host) host.setClockOffset(offset);
      }
    }
    if (!r.ok) {
      const err = new Error(
        r.status === 401 ? "the server refused the user name or password" : `server answered ${r.status} ${r.statusText}`
      );
      err.status = r.status;
      throw err;
    }
    return r;
  }

  async function fetchRemote() {
    const r = await request("GET");
    let data = emptySnapshot();
    try {
      const parsed = await r.json();
      data = {
        v: SYNC.SCHEMA_VERSION,
        channels: parsed.channels || {},
        videos: parsed.videos || {},
        tombstones: parsed.tombstones || {},
        // null = the document doesn't carry this record at all (a fresh
        // server, or one last written by an older version). The three-way
        // merge must not read that as "every item in it was deleted".
        keywords: parsed.keywords && Array.isArray(parsed.keywords.list) ? parsed.keywords : null,
        allowlist:
          parsed.allowlist && parsed.allowlist.list && typeof parsed.allowlist.list === "object"
            ? parsed.allowlist
            : null,
        settings: parsed.settings && typeof parsed.settings === "object" ? parsed.settings : null
      };
    } catch {
      // Empty or corrupt document — treat as empty; our push heals it.
    }
    return { data, version: r.headers.get("etag") };
  }

  async function pushRemote(snapshot, version) {
    const r = await request("PUT", snapshot, version || "*");
    cfg.lastVersion = r.headers.get("etag") || cfg.lastVersion;
    cfg.lastPushedAt = host.now();
  }

  // ---- merge -----------------------------------------------------------
  function emptySnapshot() {
    return {
      v: SYNC.SCHEMA_VERSION,
      channels: {},
      videos: {},
      tombstones: {},
      keywords: { list: [], ts: 0 },
      allowlist: { list: {}, ts: 0 },
      settings: null
    };
  }

  // The keyword bounds that travel with the list. `commentLimit` is optional:
  // a record saved before it existed has none, which the options page reads as
  // the default (not as "no cap"), so it is carried only when present.
  const KW_FIELDS = ["durMinSec", "durMaxSec", "commentLimit"];
  function readKeywords(k) {
    if (!k || !Array.isArray(k.list)) return { list: [], ts: 0, durMinSec: 0, durMaxSec: 0 };
    const out = { list: k.list, ts: Number(k.ts) || 0, durMinSec: Number(k.durMinSec) || 0, durMaxSec: Number(k.durMaxSec) || 0 };
    if (k.commentLimit !== undefined) out.commentLimit = Math.max(0, Number(k.commentLimit) || 0);
    return out;
  }
  const kwId = (k) => (k.re ? "re:" : "") + k.p;
  function kwFingerprint(kw) {
    const k = kw || {};
    return stableStringify({
      list: k.list || [],
      durMinSec: k.durMinSec || 0,
      durMaxSec: k.durMaxSec || 0,
      commentLimit: k.commentLimit === undefined ? null : k.commentLimit
    });
  }

  function readAllowlist(a) {
    return a && a.list && typeof a.list === "object" ? { list: a.list, ts: Number(a.ts) || 0 } : { list: {}, ts: 0 };
  }
  function allowFingerprint(al) {
    return stableStringify((al && al.list) || {});
  }

  async function readLocalRecords() {
    const r = await chrome.storage.sync.get([KEYWORDS_KEY, ALLOWLIST_KEY, SETTINGS_KEY]);
    return {
      keywords: readKeywords(r[KEYWORDS_KEY]),
      allowlist: readAllowlist(r[ALLOWLIST_KEY]),
      settings: resolveSettings(r[SETTINGS_KEY])
    };
  }

  // ---- three-way merge for the small records ---------------------------
  //
  // Keywords, the never-block list and settings carry no tombstones, so on
  // their own two copies can't tell "deleted over there" from "added over
  // here". The base — what this device and the server agreed on at the end of
  // the last sync — tells them apart: an item in the base that is gone from
  // one side was deleted on that side; an item not in the base was added. No
  // base (this device's first sync, or the server was reset) means nothing
  // counts as deleted, and the two sides are unioned.

  async function loadBase() {
    const res = await chrome.storage.local.get(STORAGE.SYNC_BASE_KEY);
    return res[STORAGE.SYNC_BASE_KEY] || null;
  }
  async function saveBase(merged) {
    const kw = { items: merged.keywords.list.map(kwId) };
    for (const f of KW_FIELDS) if (merged.keywords[f] !== undefined) kw[f] = merged.keywords[f];
    await chrome.storage.local.set({
      [STORAGE.SYNC_BASE_KEY]: { kw, allow: Object.keys(merged.allowlist.list), settings: merged.settings }
    });
  }

  // `local` / `remote` are [id, item] pairs; `baseIds` a Set, or null for no
  // base. `pick` chooses between the two copies of an item both sides hold.
  //
  // Order follows the server, with this device's own additions in front (the
  // options page lists newest first). Keeping each device's own order instead
  // never converged: two devices holding the same keywords in a different
  // order each saw "the server differs from mine" and pushed, every cycle.
  function mergeItems(local, remote, baseIds, pick) {
    const l = new Map(local);
    const r = new Map(remote);
    const out = [];
    for (const [id, item] of l) {
      if (!r.has(id) && (!baseIds || !baseIds.has(id))) out.push([id, item]); // added here
      // (in the base and gone over there: deleted there)
    }
    for (const [id, item] of r) {
      if (l.has(id)) out.push([id, pick ? pick(l.get(id), item) : l.get(id)]);
      else if (!baseIds || !baseIds.has(id)) out.push([id, item]); // added there
      // (in the base and gone here: deleted here)
    }
    return out;
  }

  // One value: whichever side changed it since the base, this device if both
  // did. A remote that doesn't carry the value at all has no say.
  function mergeValue(l, r, b) {
    if (r === undefined) return l;
    return stableStringify(l) !== stableStringify(b) ? l : r;
  }

  function mergeKeywords(local, remote, base) {
    if (!remote) return local; // the server has none yet: ours stands
    remote = readKeywords(remote);
    const list = mergeItems(
      local.list.map((k) => [kwId(k), k]),
      remote.list.map((k) => [kwId(k), k]),
      base ? new Set(base.items) : null
    ).map(([, k]) => k);
    const out = { list, ts: Math.max(local.ts || 0, remote.ts || 0) };
    // With no base, the bounds follow the newer record, as they always did.
    const newer = (remote.ts || 0) > (local.ts || 0) ? remote : local;
    for (const f of KW_FIELDS) {
      const v = base ? mergeValue(local[f], remote[f], base[f]) : newer[f] !== undefined ? newer[f] : local[f];
      if (v !== undefined) out[f] = v;
    }
    return out;
  }

  function mergeAllowlist(local, remote, baseKeys) {
    if (!remote) return local;
    remote = readAllowlist(remote);
    const newer = (a, b) => (((b && b.ts) || 0) > ((a && a.ts) || 0) ? b : a);
    const list = mergeItems(Object.entries(local.list), Object.entries(remote.list), baseKeys ? new Set(baseKeys) : null, newer);
    return { list: Object.fromEntries(list), ts: Math.max(local.ts || 0, remote.ts || 0) };
  }

  // Settings are one shared set. On a device's first sync the server's set
  // wins whole — connecting a new device adopts the others' choices rather
  // than imposing its defaults on them; after that, switch by switch.
  function mergeSettings(local, remote, base) {
    if (!remote) return local;
    if (!base) return resolveSettings(remote);
    const out = {};
    for (const k of Object.keys(local)) out[k] = mergeValue(local[k], remote[k], base[k]);
    return out;
  }

  function entryTs(e) {
    return e ? e.updated_at || e.ts || 0 : -1;
  }

  // Merge one kind ("channel" / "video"). For each id, the newest surviving
  // entry across both sides competes with the newest tombstone across both
  // sides; the later timestamp wins, an entry taking a tie.
  function mergeKind(kind, localMap, localTombs, remoteMap, remoteTombs, outMap, outTombs) {
    const idsFromTombs = (t) =>
      Object.keys(t)
        .filter((k) => k.startsWith(kind + ":"))
        .map((k) => k.slice(kind.length + 1));

    const ids = new Set([
      ...Object.keys(localMap),
      ...Object.keys(remoteMap),
      ...idsFromTombs(localTombs),
      ...idsFromTombs(remoteTombs)
    ]);

    for (const id of ids) {
      const tombKey = kind + ":" + id;
      const lTs = entryTs(localMap[id]);
      const rTs = entryTs(remoteMap[id]);
      const liveTs = Math.max(lTs, rTs);
      const liveEntry = lTs >= rTs ? localMap[id] : remoteMap[id];
      const delTs = Math.max(localTombs[tombKey] || -1, remoteTombs[tombKey] || -1);

      if (liveTs >= 0 && liveTs >= delTs) {
        outMap[id] = liveEntry;
      } else if (delTs >= 0) {
        outTombs[tombKey] = delTs;
      }
    }
  }

  function pruneTombstones(tombs, now) {
    const cutoff = now - STORAGE.TOMBSTONE_TTL_MS;
    for (const k of Object.keys(tombs)) {
      if ((tombs[k] || 0) < cutoff) delete tombs[k];
    }
    return tombs;
  }

  // Order-independent structural stringify, so a no-op write (same entries,
  // different key order after re-chunking) isn't mistaken for a change.
  function stableStringify(x) {
    if (x === null || typeof x !== "object") return JSON.stringify(x);
    if (Array.isArray(x)) return "[" + x.map(stableStringify).join(",") + "]";
    return (
      "{" +
      Object.keys(x)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + stableStringify(x[k]))
        .join(",") +
      "}"
    );
  }
  function sameBlocklistCore(a, b) {
    const norm = (s) =>
      stableStringify({ channels: s.channels || {}, videos: s.videos || {}, tombstones: s.tombstones || {} });
    return norm(a) === norm(b);
  }
  // Full comparison incl. keywords (list + bounds, ignoring ts), the channel
  // allow-list and settings — decides whether a push is needed, so a
  // duration-only, allow-list-only or one-switch edit still pushes.
  function sameBlocklist(a, b) {
    return (
      sameBlocklistCore(a, b) &&
      kwFingerprint(a.keywords) === kwFingerprint(b.keywords) &&
      allowFingerprint(a.allowlist) === allowFingerprint(b.allowlist) &&
      stableStringify(a.settings || null) === stableStringify(b.settings || null)
    );
  }

  // The server's version, as a number ("12" from the ETag `"12"`).
  const versionNo = (etag) => Number(String(etag || "").replace(/\D/g, "")) || 0;

  // ---- one cycle: pull, merge, apply locally, push -------------------
  async function cycle() {
    if (!enabled()) return { ok: false, reason: "not-configured" };
    if (running) {
      rerunQueued = true;
      return { ok: true, deferred: true };
    }
    running = true;
    try {
      const local = await host.loadAll(); // { channels, videos }
      const localTombs = await host.getTombstones(); // { "kind:id": ts }
      const rec = await readLocalRecords();
      const localSnapshot = {
        v: SYNC.SCHEMA_VERSION,
        channels: local.channels,
        videos: local.videos,
        tombstones: { ...localTombs },
        keywords: rec.keywords,
        allowlist: rec.allowlist,
        settings: rec.settings
      };

      const { data: remote, version } = await fetchRemote();

      // A server whose version went backwards was reset or restored from a
      // backup: what we agreed with it before says nothing about what it
      // holds now, so this cycle merges as if for the first time.
      let base = await loadBase();
      if (base && cfg.lastVersion && versionNo(version) < versionNo(cfg.lastVersion)) base = null;

      const merged = emptySnapshot();
      merged.keywords = mergeKeywords(rec.keywords, remote.keywords, base && base.kw);
      merged.allowlist = mergeAllowlist(rec.allowlist, remote.allowlist, base && base.allow);
      merged.settings = mergeSettings(rec.settings, remote.settings, base && base.settings);

      const writes = {};
      if (kwFingerprint(merged.keywords) !== kwFingerprint(rec.keywords)) writes[KEYWORDS_KEY] = merged.keywords;
      if (allowFingerprint(merged.allowlist) !== allowFingerprint(rec.allowlist)) writes[ALLOWLIST_KEY] = merged.allowlist;
      if (stableStringify(merged.settings) !== stableStringify(rec.settings)) writes[SETTINGS_KEY] = merged.settings;
      if (Object.keys(writes).length) await chrome.storage.sync.set(writes).catch(() => {});

      mergeKind(
        "channel",
        local.channels,
        localTombs,
        remote.channels,
        remote.tombstones,
        merged.channels,
        merged.tombstones
      );
      mergeKind("video", local.videos, localTombs, remote.videos, remote.tombstones, merged.videos, merged.tombstones);
      pruneTombstones(merged.tombstones, host.now());

      let changedLocally = false;
      if (!sameBlocklistCore(localSnapshot, merged)) {
        await host.applyMergedState({
          channels: merged.channels,
          videos: merged.videos,
          tombstones: merged.tombstones
        });
        changedLocally = true;
      }

      let pushed = false;
      if (!sameBlocklist(remote, merged)) {
        await pushRemote(merged, version);
        pushed = true;
      } else {
        cfg.lastVersion = version || cfg.lastVersion;
      }

      // Both sides now hold `merged`: that is the next cycle's base.
      await saveBase(merged);
      cfg.lastPulledAt = host.now();
      cfg.lastError = null;
      cfg.remoteChannels = Object.keys(merged.channels).length;
      cfg.remoteVideos = Object.keys(merged.videos).length;
      await persistCfg();
      return { ok: true, changedLocally: changedLocally || Object.keys(writes).length > 0, pushed };
    } catch (err) {
      if (err && err.status === 412) {
        // Another device wrote between our read and our write: start over on
        // its copy. Nothing was lost — our edits are still in local storage.
        rerunQueued = true;
        return { ok: true, deferred: true };
      }
      cfg.lastError = String((err && err.message) || err);
      await persistCfg().catch(() => {});
      return { ok: false, reason: "error", error: cfg.lastError, status: err && err.status };
    } finally {
      running = false;
      if (rerunQueued) {
        rerunQueued = false;
        cycle();
      }
    }
  }

  // ---- public API (consumed by background.js) --------------------------
  self.XrnTube.serverSync = {
    // Called once, at background.js top level (every worker wake).
    async init(hostImpl) {
      host = hostImpl;
      await loadCfg();
      host.setClockOffset(cfg.clockOffset || 0);
      if (enabled()) cycle();
    },

    // From broadcastUpdate() after any local write — schedule a debounced push.
    onLocalChange() {
      if (!enabled()) return;
      clearTimeout(pushTimer);
      pushTimer = setTimeout(() => cycle(), SYNC.PUSH_DEBOUNCE_MS);
    },

    // Poll tick — background.js owns the alarm and forwards it here.
    onPoll() {
      if (enabled()) cycle();
    },

    // options page: connect with { url, user, password }, or pass null to
    // disconnect this device.
    async configure(conn) {
      clearTimeout(pushTimer);
      await loadCfg();
      // A different server (or none) — whatever we agreed with the old one is
      // no base for merging with the new one.
      await chrome.storage.local.remove(STORAGE.SYNC_BASE_KEY);
      if (!conn || !conn.url) {
        Object.assign(cfg, { url: null, user: null, password: null, lastVersion: null, lastError: null });
        await persistCfg();
        return { ok: true, enabled: false };
      }
      Object.assign(cfg, {
        url: String(conn.url).trim().replace(/\/+$/, ""),
        user: String(conn.user || "").trim(),
        // No password given on reconnect keeps the saved one.
        password: conn.password !== undefined ? String(conn.password) : cfg.password || "",
        lastVersion: null,
        lastError: null
      });
      await persistCfg();
      const res = await cycle();
      return { ...res, enabled: true };
    },

    async syncNow() {
      await loadCfg();
      return cycle();
    },

    // The server's earlier copies (server/xrntube-sync.py keeps them on every
    // write). Listing and fetching only — a restore goes through the options
    // page's import, which re-adds entries with fresh timestamps; writing an
    // old copy back to the server would lose to every device's newer
    // tombstones on their next sync.
    async history() {
      await loadCfg();
      if (!enabled()) return { ok: false, error: "sync is not set up on this device" };
      try {
        const r = await request("GET", undefined, null, "/history");
        const body = await r.json();
        return { ok: true, items: Array.isArray(body.items) ? body.items : [] };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err), status: err && err.status };
      }
    },

    async historyItem(name) {
      await loadCfg();
      if (!enabled()) return { ok: false, error: "sync is not set up on this device" };
      try {
        const r = await request("GET", undefined, null, "/history/" + encodeURIComponent(String(name)));
        return { ok: true, data: await r.json() };
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err), status: err && err.status };
      }
    },

    async status() {
      await loadCfg();
      return {
        enabled: enabled(),
        url: cfg.url || null,
        user: cfg.user || null,
        lastPulledAt: cfg.lastPulledAt || 0,
        lastPushedAt: cfg.lastPushedAt || 0,
        remoteChannels: cfg.remoteChannels || 0,
        remoteVideos: cfg.remoteVideos || 0,
        lastError: cfg.lastError || null
      };
    }
  };
})();
