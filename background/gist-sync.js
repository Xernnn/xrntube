// ---------------------------------------------------------------------------
// Cross-browser blocklist sync, with no server to run.
//
// chrome.storage.sync only bridges browsers signed into the *same vendor's*
// account (Chrome<->Chrome via Google, Firefox<->Firefox via a Firefox
// Account) — it cannot carry a blocklist from Chrome on the desktop to Firefox
// on a phone. This module adds a second transport that can: a single private
// GitHub Gist, written to with a fine-grained personal access token the user
// pastes into the options page once per device. GitHub is the entire backend —
// nothing here is hosted, and it is free.
//
// Wire format — one JSON file (SYNC.GIST_FILENAME) inside the gist:
//   { v: 1,
//     channels:   { <key>: { name, ts, updated_at, mode, whitelist } },
//     videos:     { <id>:  { title, ts, updated_at } },
//     tombstones: { "channel:<key>" | "video:<id>": <deletedAtMs> } }
//
// Merge is last-write-wins per entry on `updated_at`, with tombstones so an
// unblock on one device is not silently resurrected by a stale copy on
// another. Timestamps come from GitHub's response `Date` header (fed back to
// background.js via host.setClockOffset) rather than the device clock, so skew
// between devices can't decide a merge. Tombstones past STORAGE.TOMBSTONE_TTL_MS
// are dropped on each cycle.
//
// There is no realtime channel: a change propagates on the next poll
// (SYNC.POLL_PERIOD_MIN) or the next debounced push after a local edit. The
// poll alarm also backstops the debounce timer, which a suspended service
// worker / event page can otherwise drop.
//
// This module never touches blocklist storage directly — background.js passes
// it a `host` with the few operations it needs. Load order (see manifest
// background.scripts and background.js's importScripts): constants.js, then
// this file, then background.js, which calls gistSync.init(host).
// ---------------------------------------------------------------------------
(() => {
  const { STORAGE, SYNC, KEYWORDS_KEY } = self.BlockTube;
  const API = "https://api.github.com";

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
        token: null,
        gistId: null,
        lastVersion: null,
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

  // ---- GitHub REST helper -------------------------------------------------
  async function gh(path, opts = {}) {
    const headers = {
      Accept: "application/vnd.github+json",
      Authorization: "Bearer " + cfg.token,
      "X-GitHub-Api-Version": "2022-11-28"
    };
    if (opts.body) headers["Content-Type"] = "application/json";

    const r = await fetch(API + path, { ...opts, headers });

    // Trust GitHub's clock over the device's for merge timestamps. Kept in
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
      const body = await r.text().catch(() => "");
      const err = new Error(`GitHub ${r.status} ${r.statusText}${body ? " — " + body.slice(0, 200) : ""}`);
      err.status = r.status;
      throw err;
    }
    return r.status === 204 ? null : r.json();
  }

  // ---- gist discovery / creation ----------------------------------------
  async function ensureGistId(initialSnapshot) {
    if (cfg.gistId) return cfg.gistId;

    // A device that has synced before will find the gist the first device
    // created. Gists come back newest-first, so a freshly made one is on
    // page 1 (a user with >100 gists and an old BlockTube gist is the only
    // gap here — they'd re-create one, and the next cycle would then have two
    // to reconcile; rare enough to leave).
    const mine = await gh("/gists?per_page=100");
    const hit = (mine || []).find((g) => g.files && g.files[SYNC.GIST_FILENAME]);
    if (hit) {
      cfg.gistId = hit.id;
      return hit.id;
    }

    const created = await gh("/gists", {
      method: "POST",
      body: JSON.stringify({
        description: SYNC.GIST_DESCRIPTION,
        public: false,
        files: { [SYNC.GIST_FILENAME]: { content: pretty(initialSnapshot) } }
      })
    });
    cfg.gistId = created.id;
    cfg.lastVersion = versionOf(created);
    // Creating the gist WITH the snapshot is itself the first push — otherwise
    // the status line reads "last pushed: never" after a successful connect.
    cfg.lastPushedAt = host.now();
    return created.id;
  }

  async function fetchRemote() {
    const gist = await gh(`/gists/${cfg.gistId}`);
    const file = gist.files && gist.files[SYNC.GIST_FILENAME];
    let data = emptySnapshot();
    if (file) {
      let content = file.content;
      // GitHub truncates large file bodies in the gist response; fetch the
      // raw blob in that case.
      if (file.truncated && file.raw_url) {
        content = await fetch(file.raw_url).then((res) => res.text());
      }
      try {
        const parsed = JSON.parse(content);
        data = {
          v: SYNC.SCHEMA_VERSION,
          channels: parsed.channels || {},
          videos: parsed.videos || {},
          tombstones: parsed.tombstones || {},
          keywords: parsed.keywords && Array.isArray(parsed.keywords.list) ? parsed.keywords : { list: [], ts: 0 }
        };
      } catch {
        // Corrupt or hand-edited file — treat as empty; our push heals it.
      }
    }
    return { data, version: versionOf(gist) };
  }

  async function pushRemote(snapshot, fallbackVersion) {
    const updated = await gh(`/gists/${cfg.gistId}`, {
      method: "PATCH",
      body: JSON.stringify({
        files: { [SYNC.GIST_FILENAME]: { content: pretty(snapshot) } }
      })
    });
    cfg.lastVersion = versionOf(updated) || fallbackVersion || cfg.lastVersion;
    cfg.lastPushedAt = host.now();
  }

  function versionOf(gist) {
    return (gist && gist.history && gist.history[0] && gist.history[0].version) || null;
  }

  // ---- merge -----------------------------------------------------------
  function emptySnapshot() {
    return { v: SYNC.SCHEMA_VERSION, channels: {}, videos: {}, tombstones: {}, keywords: { list: [], ts: 0 } };
  }

  async function readLocalKeywords() {
    const r = await chrome.storage.sync.get(KEYWORDS_KEY);
    const k = r[KEYWORDS_KEY];
    return k && Array.isArray(k.list) ? { list: k.list, ts: Number(k.ts) || 0 } : { list: [], ts: 0 };
  }

  function entryTs(e) {
    return e ? e.updated_at || e.ts || 0 : -1;
  }

  function stripRuntime(entry) {
    if (!entry || typeof entry !== "object") return entry;
    const { localOnly, ...rest } = entry; // localOnly is a per-device fact, never synced
    return rest;
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
        outMap[id] = stripRuntime(liveEntry);
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

  function pretty(snapshot) {
    return JSON.stringify(snapshot, null, 2);
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
  // Full comparison incl. keywords — decides whether a push is needed.
  function sameBlocklist(a, b) {
    return sameBlocklistCore(a, b) && stableStringify((a.keywords && a.keywords.list) || []) === stableStringify((b.keywords && b.keywords.list) || []);
  }

  function mapValues(obj, fn) {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) out[k] = fn(v);
    return out;
  }

  // ---- one cycle: pull, merge, apply locally, push -------------------
  async function cycle(reason) {
    if (!cfg || !cfg.token) return { ok: false, reason: "not-configured" };
    if (running) {
      rerunQueued = true;
      return { ok: true, deferred: true };
    }
    running = true;
    try {
      const local = await host.loadAll(); // { channels, videos }
      const localTombs = await host.getTombstones(); // { "kind:id": ts }
      const localKw = await readLocalKeywords();
      const localSnapshot = {
        v: SYNC.SCHEMA_VERSION,
        channels: mapValues(local.channels, stripRuntime),
        videos: mapValues(local.videos, stripRuntime),
        tombstones: { ...localTombs },
        keywords: localKw
      };

      await ensureGistId(localSnapshot);
      const { data: remote, version } = await fetchRemote();

      const merged = emptySnapshot();

      // Title-keyword filters: last-write-wins on the whole list by its ts.
      const remoteKw = remote.keywords || { list: [], ts: 0 };
      merged.keywords = (remoteKw.ts || 0) > (localKw.ts || 0) ? remoteKw : localKw;
      if (merged.keywords !== localKw) {
        await chrome.storage.sync.set({ [KEYWORDS_KEY]: merged.keywords }).catch(() => {});
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
      cfg.lastError = String((err && err.message) || err);
      await persistCfg().catch(() => {});
      return { ok: false, reason: "error", error: cfg.lastError, status: err && err.status };
    } finally {
      running = false;
      if (rerunQueued) {
        rerunQueued = false;
        cycle("rerun");
      }
    }
  }

  // ---- public API (consumed by background.js) --------------------------
  self.BlockTube.gistSync = {
    // Called once, at background.js top level (every worker wake).
    async init(hostImpl) {
      host = hostImpl;
      await loadCfg();
      host.setClockOffset(cfg.clockOffset || 0);
      if (cfg.token) cycle("init");
    },

    // From broadcastUpdate() after any local write — schedule a debounced push.
    onLocalChange() {
      if (!cfg || !cfg.token) return;
      clearTimeout(pushTimer);
      pushTimer = setTimeout(() => cycle("local-change"), SYNC.PUSH_DEBOUNCE_MS);
    },

    // Poll tick — background.js owns the alarm and forwards it here.
    onPoll() {
      if (cfg && cfg.token) cycle("poll");
    },

    // options page: connect with a token, or pass null to disconnect here.
    async configure(token) {
      clearTimeout(pushTimer);
      await loadCfg();
      if (!token) {
        Object.assign(cfg, { token: null, gistId: null, lastVersion: null, lastError: null });
        await persistCfg();
        return { ok: true, enabled: false };
      }
      cfg.token = String(token).trim();
      cfg.lastError = null;
      await persistCfg();
      const res = await cycle("configure");
      return { ...res, enabled: true };
    },

    async syncNow() {
      await loadCfg();
      return cycle("manual");
    },

    async status() {
      await loadCfg();
      return {
        enabled: !!cfg.token,
        gistId: cfg.gistId || null,
        gistUrl: cfg.gistId ? "https://gist.github.com/" + cfg.gistId : null,
        lastPulledAt: cfg.lastPulledAt || 0,
        lastPushedAt: cfg.lastPushedAt || 0,
        remoteChannels: cfg.remoteChannels || 0,
        remoteVideos: cfg.remoteVideos || 0,
        lastError: cfg.lastError || null
      };
    }
  };
})();
