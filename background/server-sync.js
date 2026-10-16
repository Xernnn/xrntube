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
//     keywords, allowlist }
//
// Merge is last-write-wins per entry on `updated_at`, with tombstones so an
// unblock on one device is not silently resurrected by a stale copy on
// another. Timestamps come from the server's `Date` header (fed back to
// background.js via host.setClockOffset) rather than the device clock, so skew
// between devices can't decide a merge. Tombstones past STORAGE.TOMBSTONE_TTL_MS
// are dropped on each cycle. A push carries the version it read (If-Match):
// when another device wrote in between, the server answers 412 and the cycle
// simply runs again on the newer copy.
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
  const { STORAGE, SYNC, KEYWORDS_KEY, ALLOWLIST_KEY } = self.XrnTube;

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

  async function request(method, body, ifMatch) {
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
    const r = await fetch(cfg.url.replace(/\/+$/, "") + "/state", { method, headers, body: payload, cache: "no-store" });

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
        keywords: parsed.keywords && Array.isArray(parsed.keywords.list) ? parsed.keywords : { list: [], ts: 0 },
        allowlist:
          parsed.allowlist && parsed.allowlist.list && typeof parsed.allowlist.list === "object"
            ? parsed.allowlist
            : { list: {}, ts: 0 }
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
      allowlist: { list: {}, ts: 0 }
    };
  }

  async function readLocalKeywords() {
    const r = await chrome.storage.sync.get(KEYWORDS_KEY);
    const k = r[KEYWORDS_KEY];
    return k && Array.isArray(k.list)
      ? { list: k.list, ts: Number(k.ts) || 0, durMinSec: Number(k.durMinSec) || 0, durMaxSec: Number(k.durMaxSec) || 0 }
      : { list: [], ts: 0, durMinSec: 0, durMaxSec: 0 };
  }
  function kwFingerprint(kw) {
    return stableStringify({
      list: (kw && kw.list) || [],
      durMinSec: (kw && kw.durMinSec) || 0,
      durMaxSec: (kw && kw.durMaxSec) || 0
    });
  }

  async function readLocalAllowlist() {
    const r = await chrome.storage.sync.get(ALLOWLIST_KEY);
    const a = r[ALLOWLIST_KEY];
    return a && a.list && typeof a.list === "object"
      ? { list: a.list, ts: Number(a.ts) || 0 }
      : { list: {}, ts: 0 };
  }
  function allowFingerprint(al) {
    return stableStringify((al && al.list) || {});
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
  // Full comparison incl. keywords (list + duration bounds, ignoring ts) and
  // the channel allow-list — decides whether a push is needed, so a
  // duration-only or allow-list-only edit still pushes.
  function sameBlocklist(a, b) {
    return (
      sameBlocklistCore(a, b) &&
      kwFingerprint(a.keywords) === kwFingerprint(b.keywords) &&
      allowFingerprint(a.allowlist) === allowFingerprint(b.allowlist)
    );
  }

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
      const localKw = await readLocalKeywords();
      const localAllow = await readLocalAllowlist();
      const localSnapshot = {
        v: SYNC.SCHEMA_VERSION,
        channels: local.channels,
        videos: local.videos,
        tombstones: { ...localTombs },
        keywords: localKw,
        allowlist: localAllow
      };

      const { data: remote, version } = await fetchRemote();

      const merged = emptySnapshot();

      // Title-keyword filters: last-write-wins on the whole list by its ts.
      const remoteKw = remote.keywords || { list: [], ts: 0 };
      merged.keywords = (remoteKw.ts || 0) > (localKw.ts || 0) ? remoteKw : localKw;
      if (merged.keywords !== localKw) {
        await chrome.storage.sync.set({ [KEYWORDS_KEY]: merged.keywords }).catch(() => {});
      }

      // Channel allow-list: same last-write-wins on the whole object by its ts.
      const remoteAllow = remote.allowlist || { list: {}, ts: 0 };
      merged.allowlist = (remoteAllow.ts || 0) > (localAllow.ts || 0) ? remoteAllow : localAllow;
      if (merged.allowlist !== localAllow) {
        await chrome.storage.sync.set({ [ALLOWLIST_KEY]: merged.allowlist }).catch(() => {});
      }
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

      cfg.lastPulledAt = host.now();
      cfg.lastError = null;
      cfg.remoteChannels = Object.keys(merged.channels).length;
      cfg.remoteVideos = Object.keys(merged.videos).length;
      await persistCfg();
      return { ok: true, changedLocally, pushed };
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
