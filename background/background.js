// The MV3 service worker. constants.js and server-sync.js are plain scripts
// sharing `self`, so they're loaded first.
importScripts("../shared/constants.js", "./server-sync.js");

const {
  MSG,
  STORAGE,
  CHANNEL_MODE,
  SYNC,
  SETTINGS_KEY,
  ALLOWLIST_KEY,
  KEYWORDS_KEY,
  SUBS_SCRAPE_VERSION
} = self.XrnTube;

// A cross-device clock: server-sync.js feeds the sync server's Date header back
// through syncHost.setClockOffset so last-write-wins merges aren't corrupted by
// device clock skew. Everything that stamps `updated_at` / a tombstone time
// goes through syncedNow(); with no sync configured this is just Date.now().
let clockOffset = 0;
function syncedNow() {
  return Date.now() + clockOffset;
}

// ---------- the blocklist store (chrome.storage.local) ----------
// Every blocked channel and video, under one local key, read and written
// whole. Keeping devices in step is the sync server's job (server-sync.js), so
// the blocklist no longer rides chrome.storage.sync — whose 8KB-per-item and
// 512-item limits forced 50-entry chunks with a local-only overflow, and were
// behind both storage bugs of October 2026. ~1MB for 5,000 channels, which
// chrome.storage.local writes in milliseconds; `unlimitedStorage` (manifest)
// lifts its 10MB ceiling.
//
// Every write goes through updateStore(), one at a time: two writers that each
// read the whole list and wrote it back could otherwise drop one another's
// change (a block landing while a sub-count lookup saves, say).
const BLOCKLIST_KEY = STORAGE.BLOCKLIST_KEY;
let migrated = null;

async function loadAll() {
  await (migrated || (migrated = migrateFromSyncChunks()));
  const r = await chrome.storage.local.get(BLOCKLIST_KEY);
  const bl = r[BLOCKLIST_KEY] || {};
  return { channels: bl.channels || {}, videos: bl.videos || {} };
}

let storeQueue = Promise.resolve();
// Runs `change(state)` on a fresh copy of the store, then saves it — unless
// `change` returns false. Resolves to the state, with what `change` returned
// as `.result`.
function updateStore(change) {
  const run = storeQueue.then(async () => {
    const state = await loadAll();
    const result = await change(state);
    if (result !== false) {
      await chrome.storage.local.set({ [BLOCKLIST_KEY]: { channels: state.channels, videos: state.videos } });
    }
    state.result = result;
    return state;
  });
  storeQueue = run.catch(() => {});
  return run;
}

// Replace the whole list — the sync merge, which computes it whole.
const writeFullState = (channels, videos) =>
  updateStore((s) => {
    s.channels = channels;
    s.videos = videos;
  });

// Up to v1, the blocklist lived in chrome.storage.sync as `bt_meta` plus
// `bt_ch_<n>` / `bt_vid_<n>` chunks, with a local `bt_overflow` for what didn't
// fit. Fold it all into the new key once. The old keys are removed only after
// the new one is written, so an interruption loses nothing.
async function migrateFromSyncChunks() {
  const [sync, local] = await Promise.all([
    chrome.storage.sync.get(null),
    chrome.storage.local.get([BLOCKLIST_KEY, "bt_overflow"])
  ]);
  const oldKeys = Object.keys(sync).filter((k) => k === "bt_meta" || /^bt_(ch|vid)_\d+$/.test(k));
  const overflow = local.bt_overflow;
  if (!oldKeys.length && !overflow) return;
  const bl = local[BLOCKLIST_KEY] || { channels: {}, videos: {} };
  const take = (into, from) => {
    for (const [id, e] of Object.entries(from || {})) if (!into[id]) into[id] = e;
  };
  const meta = sync.bt_meta || {};
  for (let i = 0; i < (meta.channelChunkCount || 0); i++) take(bl.channels, sync["bt_ch_" + i]);
  for (let i = 0; i < (meta.videoChunkCount || 0); i++) take(bl.videos, sync["bt_vid_" + i]);
  if (overflow) {
    take(bl.channels, overflow.channels);
    take(bl.videos, overflow.videos);
  }
  await chrome.storage.local.set({ [BLOCKLIST_KEY]: bl });
  if (oldKeys.length) await chrome.storage.sync.remove(oldKeys);
  await chrome.storage.local.remove("bt_overflow");
}

async function addEntry(kind, id, label, extra) {
  const bucket = kind === "channel" ? "channels" : "videos";
  const state = await updateStore((s) => {
    if (s[bucket][id]) return false; // already blocked
    const now = syncedNow();
    s[bucket][id] = {
      [kind === "channel" ? "name" : "title"]: label || "",
      ts: now,
      updated_at: now, // bumped on every mutation; drives last-write-wins in server-sync.js
      ...(extra || {})
    };
  });
  // Re-blocking supersedes any earlier unblock — drop its tombstone so the
  // sync merge doesn't treat this entry as deleted on the next cycle.
  if (state.result !== false) await clearTombstone(kind, id);
  return state;
}

async function removeEntry(kind, id) {
  const bucket = kind === "channel" ? "channels" : "videos";
  let removed;
  const state = await updateStore((s) => {
    removed = s[bucket][id]; // snapshot for the undo log
    if (!removed) return false;
    delete s[bucket][id];
  });
  // Record the deletion so the sync merge propagates it instead of another
  // device's stale copy re-adding the entry.
  await writeTombstone(kind, id);
  state.undoTs = removed ? await pushRecentUnblock({ t: "one", kind, id, entry: removed }) : null;
  return state;
}

// ---------- recently-unblocked undo log (chrome.storage.local, not synced) ----------
// A local safety net so an accidental unblock / the "clear all videos" button
// can be reversed. Newest first, capped; each record holds the full entry so a
// restore keeps its mode / whitelist / handle / age rule.
const RECENT_UNBLOCK_KEY = "bt_recent_unblocks";
const RECENT_UNBLOCK_MAX = 40;
// A "delete all" record holds every entry it removed, so 40 of them could be
// 200,000 entries. Cap the log by entries too, keeping at least the newest
// record whole however big it is — that is the one an Undo toast points at.
const RECENT_UNBLOCK_MAX_ENTRIES = 20000;

async function getRecentUnblocks() {
  const res = await chrome.storage.local.get(RECENT_UNBLOCK_KEY);
  return Array.isArray(res[RECENT_UNBLOCK_KEY]) ? res[RECENT_UNBLOCK_KEY] : [];
}

function recordSize(rec) {
  if (rec.t !== "bulk") return 1;
  return (
    Object.keys(rec.entries || {}).length +
    Object.keys(rec.channels || {}).length +
    Object.keys(rec.videos || {}).length +
    ((rec.keywords && rec.keywords.length) || 0) +
    Object.keys(rec.allowlist || {}).length
  );
}

// Returns the record's `ts`, which doubles as its id: strictly increasing, so
// two removals in the same millisecond still get distinct handles.
async function pushRecentUnblock(record) {
  const log = await getRecentUnblocks();
  const ts = Math.max(syncedNow(), log.length ? (log[0].ts || 0) + 1 : 0);
  log.unshift({ ...record, ts });
  let kept = 0;
  let total = 0;
  for (const rec of log.slice(0, RECENT_UNBLOCK_MAX)) {
    total += recordSize(rec);
    if (kept && total > RECENT_UNBLOCK_MAX_ENTRIES) break;
    kept++;
  }
  await chrome.storage.local.set({ [RECENT_UNBLOCK_KEY]: log.slice(0, kept) });
  return ts;
}

// Re-add every entry in a log record, then drop the record. Returns the fresh
// state. `ref` is { ts } (preferred — stable) or { index }.
//
// Everything goes back in one write. An entry that has since been blocked
// again keeps its current copy.
async function restoreRecentUnblock(ref) {
  const log = await getRecentUnblocks();
  const index =
    ref && ref.ts != null ? log.findIndex((r) => r.ts === Number(ref.ts)) : Number(ref && ref.index);
  const rec = log[index];
  if (!rec) return loadAll();

  const add = { channel: {}, video: {} };
  if (rec.t === "bulk") {
    // Two shapes: { kind, entries } (one kind), and the DELETE_DATA shape
    // { channels, videos, keywords, allowlist }.
    if (rec.entries) Object.assign(add[rec.kind === "channel" ? "channel" : "video"], rec.entries);
    Object.assign(add.channel, rec.channels || {});
    Object.assign(add.video, rec.videos || {});
  } else {
    add[rec.kind === "channel" ? "channel" : "video"][rec.id] = rec.entry || {};
  }

  const now = syncedNow();
  const revived = [];
  await updateStore((s) => {
    for (const [kind, map, target] of [["channel", add.channel, s.channels], ["video", add.video, s.videos]]) {
      for (const [id, entry] of Object.entries(map)) {
        if (target[id]) continue;
        target[id] = { ...entry, updated_at: now };
        revived.push(kind + ":" + id);
      }
    }
    if (!revived.length) return false;
  });
  if (revived.length) {
    const tombs = await getTombstones();
    for (const k of revived) delete tombs[k];
    await setTombstones(tombs);
  }

  if (rec.keywords && rec.keywords.length) {
    const cur = await getKeywordsRecord();
    const list = cur.list.slice();
    for (const k of rec.keywords) {
      if (!list.some((x) => x.p === k.p && !!x.re === !!k.re)) list.push(k);
    }
    await chrome.storage.sync.set({ [KEYWORDS_KEY]: { ...cur, list, ts: Date.now() } }).catch(() => {});
  }
  if (rec.allowlist && Object.keys(rec.allowlist).length) {
    const cur = await getAllowlist();
    await chrome.storage.sync
      .set({ [ALLOWLIST_KEY]: { list: { ...rec.allowlist, ...cur.list }, ts: Date.now() } })
      .catch(() => {});
  }

  log.splice(index, 1);
  await chrome.storage.local.set({ [RECENT_UNBLOCK_KEY]: log });
  return loadAll();
}

// The title-keyword record, as the options page writes it (see KEYWORDS_KEY).
async function getKeywordsRecord() {
  const res = await chrome.storage.sync.get(KEYWORDS_KEY);
  const k = res[KEYWORDS_KEY];
  return k && Array.isArray(k.list) ? { ...k, list: k.list } : { list: [], ts: 0 };
}

// DELETE_DATA: remove a set of channels / videos (or all of either), and
// optionally every title keyword and never-block entry, as ONE undo record.
// One store write and one tombstone write whatever the size, and it still
// propagates through sync like a single unblock does.
async function deleteData(req) {
  const pick = (map, ids) => {
    if (ids === "all") return Object.keys(map);
    return Array.isArray(ids) ? ids.filter((id) => map[id]) : [];
  };
  const record = { t: "bulk", kind: "mixed", channels: {}, videos: {}, count: 0 };
  let chIds = [];
  let vidIds = [];
  await updateStore((s) => {
    chIds = pick(s.channels, req.channels);
    vidIds = pick(s.videos, req.videos);
    if (!chIds.length && !vidIds.length) return false;
    for (const id of chIds) {
      record.channels[id] = s.channels[id];
      delete s.channels[id];
    }
    for (const id of vidIds) {
      record.videos[id] = s.videos[id];
      delete s.videos[id];
    }
  });
  if (chIds.length || vidIds.length) {
    const now = syncedNow();
    const tombs = await getTombstones();
    for (const id of chIds) tombs["channel:" + id] = now;
    for (const id of vidIds) tombs["video:" + id] = now;
    await setTombstones(tombs);
  }

  let keywordCount = 0;
  if (req.keywords) {
    const cur = await getKeywordsRecord();
    keywordCount = cur.list.length;
    if (keywordCount) {
      record.keywords = cur.list;
      await chrome.storage.sync.set({ [KEYWORDS_KEY]: { ...cur, list: [], ts: Date.now() } }).catch(() => {});
    }
  }
  let allowCount = 0;
  if (req.allowlist) {
    const cur = await getAllowlist();
    allowCount = Object.keys(cur.list).length;
    if (allowCount) {
      record.allowlist = cur.list;
      await chrome.storage.sync.set({ [ALLOWLIST_KEY]: { list: {}, ts: Date.now() } }).catch(() => {});
    }
  }

  record.count = chIds.length + vidIds.length + keywordCount + allowCount;
  const undoTs = record.count ? await pushRecentUnblock(record) : null;
  const fresh = await loadAll();
  fresh.undoTs = undoTs;
  fresh.removed = { channels: chIds.length, videos: vidIds.length, keywords: keywordCount, allowlist: allowCount };
  return fresh;
}

// Applies `mutate(entry) -> entry` to existing entries — flipping
// CHANNEL_MODE, editing the per-channel whitelist, the `hidden` flag and the
// age rule, none of which add or remove an entry. One write however many ids,
// and every mutation bumps updated_at so the sync merge sees this device's
// copy as the newer one.
function mutateEntries(kind, ids, mutate) {
  const bucket = kind === "channel" ? "channels" : "videos";
  return updateStore((s) => {
    const now = syncedNow();
    let n = 0;
    for (const id of ids) {
      if (!s[bucket][id]) continue;
      s[bucket][id] = { ...mutate(s[bucket][id]), updated_at: now };
      n++;
    }
    if (!n) return false;
  });
}

const mutateChannelEntry = (id, mutate) => mutateEntries("channel", [id], mutate);

// One id or many — every bulk-capable message accepts either `id` or `ids`.
const idsOf = (msg) => (Array.isArray(msg.ids) ? msg.ids : msg.id != null ? [msg.id] : []);

// ---------- tombstones (chrome.storage.local) ----------
// A deletion has to outlive the entry itself so the sync merge in server-sync.js
// can tell "this device never had it" from "this device deleted it" — otherwise
// another device's stale copy silently re-adds an unblocked channel/video.

async function getTombstones() {
  const res = await chrome.storage.local.get(STORAGE.TOMBSTONE_KEY);
  return res[STORAGE.TOMBSTONE_KEY] || {};
}

function pruneTombstones(tombs) {
  const cutoff = syncedNow() - STORAGE.TOMBSTONE_TTL_MS;
  for (const k of Object.keys(tombs)) {
    if ((tombs[k] || 0) < cutoff) delete tombs[k];
  }
  return tombs;
}

async function setTombstones(tombs) {
  await chrome.storage.local.set({ [STORAGE.TOMBSTONE_KEY]: pruneTombstones({ ...(tombs || {}) }) });
}

async function writeTombstone(kind, id) {
  const tombs = await getTombstones();
  tombs[kind + ":" + id] = syncedNow();
  await setTombstones(tombs);
}

async function clearTombstone(kind, id) {
  const tombs = await getTombstones();
  if (tombs[kind + ":" + id] !== undefined) {
    delete tombs[kind + ":" + id];
    await setTombstones(tombs);
  }
}

// ---------- declarativeNetRequest: instant redirect on direct navigation ----------
// Scrubbing feeds/search happens in the content script (DOM removal). But if you
// click an old link or type a blocked video/channel URL directly, DNR redirects
// the network request before YouTube ever renders it — no flash of content.

const DNR_RULE_ID_BASE_VIDEO = 100000;
// Sits between the video base (+ DNR_MAX_VIDEO_RULES) and the channel base, so
// the three ranges can never overlap. Only populated when `blockInEmbeds` is on.
const DNR_RULE_ID_BASE_EMBED = 300000;
const DNR_RULE_ID_BASE_CHANNEL = 500000;
const DNR_RULE_ID_HOME = 900001;
const DNR_RULE_ID_SHORTS = 900002;

// DNR is only the no-flash optimisation for *direct* navigation to a blocked
// URL — content.js's checkCurrentPageAndRedirect() / yt-navigate-start guards
// still cover every blocked entry (with a brief flash). Chrome caps dynamic
// rules (historically 5000 total) and regex-filtered rules (1000), and a
// 5000-entry blocklist would blow both, making updateDynamicRules reject and
// take the whole write down with it. So cap the rule set well under those
// limits and give the instant redirect to the most recently blocked entries.
const DNR_MAX_VIDEO_RULES = 800; // each uses regexFilter — stay under the 1000 regex cap (+ home rule)
const DNR_MAX_CHANNEL_RULES = 3000; // urlFilter, not regex; keeps total < 4000

// Where blocked content — and now the homepage and Shorts entirely — get
// redirected to at the network layer, before YouTube renders anything. One
// definition, in shared/constants.js, shared with content.js's own redirect.
const { SAFE_LANDING_URL } = self.XrnTube;

async function getSettings() {
  const res = await chrome.storage.sync.get({ [SETTINGS_KEY]: null });
  // resolveSettings expands the legacy coarse keys an older version wrote, so
  // an upgrade doesn't quietly switch a disabled DNR rule back on.
  return self.XrnTube.resolveSettings(res[SETTINGS_KEY]);
}

// { list: { [channelKey]: {note?, ts} }, ts } — channels that must never be
// blocked. `@handle` keys are stored lowercased so a DOM link and a stored
// key compare regardless of case.
async function getAllowlist() {
  const res = await chrome.storage.sync.get(ALLOWLIST_KEY);
  const a = res[ALLOWLIST_KEY];
  return a && a.list && typeof a.list === "object" ? { list: a.list, ts: Number(a.ts) || 0 } : { list: {}, ts: 0 };
}
function normAllowKey(key) {
  const k = String(key || "").trim();
  if (!k) return null;
  if (k.startsWith("@")) return k.toLowerCase();
  const m = k.match(/(UC[\w-]{22})/);
  return m ? m[1] : k;
}
// `keys` is one key or an array — a bulk never-block is still ONE write.
async function setAllowed(keys, on, note) {
  const norms = [].concat(keys).map(normAllowKey).filter(Boolean);
  if (!norms.length) return { list: {}, ts: 0 };
  const cur = await getAllowlist();
  const list = { ...cur.list };
  for (const norm of norms) {
    if (on) list[norm] = { note: note || "", ts: Date.now() };
    else delete list[norm];
  }
  const next = { list, ts: Date.now() };
  await chrome.storage.sync.set({ [ALLOWLIST_KEY]: next }).catch(() => {});
  return next;
}

async function rebuildDnrRules(state) {
  const settings = await getSettings();
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map((r) => r.id);

  // Newest-blocked first, then cap — those are the entries a user is most
  // likely to navigate straight to right now.
  const byTsDesc = (a, b) => (b[1].ts || 0) - (a[1].ts || 0);

  const videoIds = Object.entries(state.videos)
    .sort(byTsDesc)
    .slice(0, DNR_MAX_VIDEO_RULES)
    .map(([id]) => id);
  // EXCEPT_WHITELIST channels deliberately keep their own channel page
  // reachable (see CHANNEL_MODE in shared/constants.js) — only a FULL block
  // gets the network-level page redirect. Individual videos from a
  // soft-blocked channel can't be targeted here (this rule only has the
  // channel's URL, not a list of its video IDs); content.js's
  // checkCurrentPageAndRedirect() closes that gap after the page renders.
  const allow = (await getAllowlist()).list;
  const isAllowed = (key) => !!allow[normAllowKey(key)];
  // A channel has two URL identities (/channel/UC… and /@handle) and an entry
  // is keyed by only one of them. Emit a rule for BOTH whenever the other one
  // is known, or navigating by the un-keyed form walks straight past DNR.
  const toPath = (k) => (k.startsWith("@") ? "/" + k : "/channel/" + k);
  const blockedEntries = Object.entries(state.channels)
    .filter(([key, entry]) => entry.mode !== CHANNEL_MODE.EXCEPT_WHITELIST && !isAllowed(key))
    .sort(byTsDesc);
  // Primary keys first, alternates only with the budget left over: under the
  // cap, every blocked channel keeping the rule for the identity it is keyed
  // by matters more than any one channel being covered twice.
  const seenPaths = new Set();
  const primary = [];
  const alternate = [];
  for (const [key, entry] of blockedEntries) {
    const p = toPath(key);
    if (!seenPaths.has(p)) {
      seenPaths.add(p);
      primary.push(p);
    }
    const alt = key.startsWith("@") ? entry.ucid : entry.handle;
    if (alt && !isAllowed(alt)) {
      const ap = toPath(alt);
      if (!seenPaths.has(ap)) {
        seenPaths.add(ap);
        alternate.push(ap);
      }
    }
  }
  const fullyBlockedChannelPaths = primary
    .slice(0, DNR_MAX_CHANNEL_RULES)
    .concat(alternate.slice(0, Math.max(0, DNR_MAX_CHANNEL_RULES - primary.length)));

  const addRules = [];

  videoIds.forEach((id, i) => {
    addRules.push({
      id: DNR_RULE_ID_BASE_VIDEO + i,
      priority: 1,
      action: { type: "redirect", redirect: { url: SAFE_LANDING_URL } },
      condition: {
        // The same video is reachable as ?v=<id>, /shorts/<id>, /live/<id>,
        // /embed/<id> and /v/<id> — matching only "?v=" left the other four
        // shapes playing a blocked video at the network layer.
        regexFilter: "([?&]v=|/(?:shorts|live|embed|v)/)" + id + "([&?/]|$)",
        resourceTypes: ["main_frame"]
      }
    });
  });

  // With the embeds switch on, a blocked video id is stopped inside an
  // <iframe> too. Sub-frames get `block`, not the redirect the top-level rules
  // use: navigating someone else's embedded player to our Subscriptions feed
  // would be a stranger surprise than an empty frame.
  if (settings.blockInEmbeds) {
    videoIds.forEach((id, i) => {
      addRules.push({
        id: DNR_RULE_ID_BASE_EMBED + i,
        priority: 2,
        action: { type: "block" },
        condition: {
          regexFilter: "([?&]v=|/(?:shorts|live|embed|v)/)" + id + "([&?/]|$)",
          resourceTypes: ["sub_frame"]
        }
      });
    });
  }

  fullyBlockedChannelPaths.forEach((path, i) => {
    addRules.push({
      id: DNR_RULE_ID_BASE_CHANNEL + i,
      priority: 1,
      action: { type: "redirect", redirect: { url: SAFE_LANDING_URL } },
      condition: {
        urlFilter: "youtube.com" + path,
        resourceTypes: ["main_frame"]
      }
    });
  });

  // Home and Shorts as destinations — network-level redirect, toggle-gated
  // (content.js's checkCurrentPageAndRedirect() still covers the SPA case).
  if (settings.redirectHomepage) {
    addRules.push({
      id: DNR_RULE_ID_HOME,
      priority: 1,
      action: { type: "redirect", redirect: { url: SAFE_LANDING_URL } },
      condition: {
        regexFilter: "^https://(www\\.|m\\.)?youtube\\.com/(\\?[^#]*)?$",
        resourceTypes: ["main_frame"]
      }
    });
  }
  if (settings.shortsPlayer) {
    addRules.push({
      id: DNR_RULE_ID_SHORTS,
      priority: 1,
      action: { type: "redirect", redirect: { url: SAFE_LANDING_URL } },
      condition: {
        urlFilter: "||youtube.com/shorts/",
        resourceTypes: ["main_frame"]
      }
    });
  }

  try {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  } catch (err) {
    // Never let a DNR failure abort a blocklist write — content.js still
    // enforces everything. Fall back to clearing rules so at least the ones
    // that would apply aren't stale.
    console.warn("XrnTube: updateDynamicRules failed, clearing dynamic rules", err);
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds }).catch(() => {});
  }
}

// ---------- scrape a channel's public page (subs + @handle + name) ----------
// No API key: fetch a page belonging to the channel (host permission covers
// youtube.com) and read its own header out of the embedded JSON. Returns
// { subs, handle, name, ucid } (any may be null), { rateLimited: true } on a
// 429, { gone: true } on a 404/410, or null on any other failure.
//
// WHICH page matters, and so does WHERE in it we read.
//
// The channel's own `pageHeaderRenderer` — the only block on the page that
// describes *this* channel — sits at the very END of the document (~2.5MB in
// on a big channel). Everything before it is feed content: shelves of other
// people's videos and channel cards, each carrying its own
// "subscriberCountText". Reading the first sub count in the document therefore
// reported a STRANGER's number, and the streaming reader stopped at 1.5MB, so
// on a large channel it reported nothing at all. Measured across 27 real
// channels: 10 came back with no count and several of the rest were wrong —
// @mkbhd read as "1.15M" (a shelf card's), @NASA as "62.9K". This is the same
// trap as the ucid parse below, and it is why the sub counts have to come from
// the page header or not at all.
//
// The channel's **search tab with a query that matches nothing** is the
// cheapest page that still carries that header: no feed content, so it is a
// consistent ~800KB with the header at ~765KB, against 2.5MB for the channel
// home or /about. Gzipped that is ~235KB on the wire — the same as the old
// (wrong) 1.5MB read of the home page, so being right here cost no bandwidth —
// and the authoritative `externalId` now lands inside the window too.
const CHANNEL_PROBE_QUERY = "/search?query=zzqqxx9182";
const CHANNEL_HEAD_KEY = '"pageHeaderRenderer":{';
const CHANNEL_HEAD_TAIL = 12000; // enough to cover metadataRows after the key
const CHANNEL_MAX_BYTES = 3000000;

async function fetchChannelPage(path) {
  let html = "";
  try {
    const res = await fetch("https://www.youtube.com" + path, {
      headers: { "Accept-Language": "en-US,en;q=0.9" }
    });
    if (res.status === 429) return { rateLimited: true };
    // A channel that is deleted, terminated, or renamed (its old handle now
    // 404s) is *permanently* unfetchable. Returning null for it — as every
    // non-OK response used to — records nothing, so the auto-fetch retried it
    // on every options-page open forever and it sat in "No sub count"
    // indefinitely. Say so instead, so the attempt gets recorded once.
    // 5xx and network errors stay unrecorded on purpose: those are worth
    // retrying. A 400 is not — YouTube rejecting the path itself means this
    // key will never resolve, and leaving it unrecorded kept it in the
    // "may not block everywhere" note forever, with Resolve unable to clear it.
    if (res.status === 404 || res.status === 410 || res.status === 400) return { gone: true };
    if (!res.ok || !res.body) return res.ok ? { html: "" } : null;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (let i = 0; i < 900; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
      if (html.length > CHANNEL_MAX_BYTES) break;
      const at = html.indexOf(CHANNEL_HEAD_KEY);
      if (at >= 0 && html.length > at + CHANNEL_HEAD_TAIL) break;
    }
    reader.cancel().catch(() => {});
  } catch {
    // A fetch that throws before any body arrived is, in practice, YouTube
    // redirecting to Google's "unusual traffic" page — a host this extension
    // may not follow — or the network being down. Either way the right move
    // is to slow down, not to record the channel or skip it.
    return html ? { html } : { rateLimited: true };
  }
  return { html };
}

async function scrapeChannelInfo(key) {
  const base = key.startsWith("@") ? "/" + key : "/channel/" + key;
  const page = await fetchChannelPage(base + CHANNEL_PROBE_QUERY);
  if (!page || page.rateLimited || page.gone) return page;
  let info = parseChannelHtml(page.html);
  let html = page.html;
  // No header in the cheap page (search disabled for this channel, a consent
  // wall, a truncated response): pay for the full channel page rather than
  // record a blank.
  if (!info.headed) {
    const full = await fetchChannelPage(base);
    if (full && (full.rateLimited || full.gone)) return full;
    if (full && full.html) {
      html = full.html;
      const alt = parseChannelHtml(full.html);
      if (alt.headed || alt.subs || alt.ucid) info = alt;
    }
  }
  // Gone, but disguised as a 200. A `/channel/UC…` that names no real channel
  // does NOT 404 — it serves a full page carrying
  // `"alerts":[{"alertRenderer":{"type":"ERROR","text":…"This channel does not
  // exist."}}]` and no channel header at all. Without this it looked like a
  // transient failure and went back in the fetch queue on every options-page
  // open, which is the loop `gone` exists to end. The alert text is localised,
  // so the match is on the structure; requiring *no header* is what keeps it
  // off a live channel page that happens to carry an error alert somewhere.
  if (!info.headed && /"alertRenderer":\{"type":"ERROR"/.test(html)) return { gone: true };
  return verifyChannelInfo(key, info);
}

// Last line of defence for the identity fields. We asked for ONE specific
// channel, so whichever identity the page reports for the format we requested
// by must be the one we requested — if /@foo comes back claiming to be
// "@bar", the parse latched onto some other channel embedded in the page and
// the UC id next to it is not "@foo"'s either. Drop both rather than write a
// stranger's id onto the entry: a wrong ucid/handle cross-indexes the
// blocklist and generates a DNR redirect against an innocent channel. `subs`
// and `name` are cosmetic and survive.
function verifyChannelInfo(key, info) {
  if (!info || info.rateLimited) return info;
  const asked = String(key || "");
  const mismatch = asked.startsWith("@")
    ? info.handle && info.handle.toLowerCase() !== asked.toLowerCase()
    : info.ucid && info.ucid !== asked;
  if (mismatch) {
    console.debug("[XrnTube] identity mismatch for", asked, "— discarding scraped handle/ucid");
    return { ...info, handle: null, ucid: null };
  }
  return info;
}

function parseChannelHtml(html) {
  // The channel's own header. Everything read from inside it describes THIS
  // channel; everything outside it may describe anyone whose video or channel
  // card the page happens to embed.
  const headAt = html.indexOf(CHANNEL_HEAD_KEY);
  const head = headAt >= 0 ? html.slice(headAt, headAt + CHANNEL_HEAD_TAIL) : "";

  // metadataRows is [ [@handle], [ "21.3M subscribers", "1.8K videos" ] ].
  // A channel that hides its count simply has no subscribers part — that is a
  // real answer ("hidden"), not a failure, and must not be retried forever.
  const rowsM = head.match(/"metadataRows":\[(.*?)\],"delimiter"/s);
  const rows = rowsM ? rowsM[1] : "";
  const parts = [...rows.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
  let subs = null;
  const subsPart = parts.find((t) => /\d/.test(t) && /subscriber/i.test(t));
  if (subsPart) {
    subs = subsPart.replace(/\s*subscribers?\s*$/i, "").replace(/\s+/g, "");
  } else if (rows) {
    // Not English (Accept-Language is only a request, not a promise). The row
    // is [<subscribers>, <videos>] in every language, so take its first part —
    // but ONLY when it really has two, because a channel that hides its count
    // renders the same row with the video count alone, and reading that as a
    // sub count writes "12 videos" into the number field.
    const second = rows.split('"metadataParts"')[2] || "";
    const cells = [...second.matchAll(/"content":"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
    const t = cells.length >= 2 ? cells[0] : null;
    if (t && /\d/.test(t) && !/^@/.test(t)) subs = t.replace(/\s+/g, " ").trim();
  }
  if (!subs && rows) subs = "hidden";

  // Ordered most- to least-authoritative, and page-identity sources only.
  // "canonicalBaseUrl" is LAST because it is not unique to this page: every
  // video/shelf item in the response carries its own, so on a page whose first
  // shelf item is someone else's video it names the WRONG channel.
  const headHandle = head.match(/"content":"(@[A-Za-z0-9._-]+)"/);
  const handleM =
    headHandle ||
    html.match(/"vanityChannelUrl":"https?:\/\/[^"]*\/(@[A-Za-z0-9._-]+)"/i) ||
    html.match(/<link[^>]+rel="canonical"[^>]+href="https:\/\/www\.youtube\.com\/(@[A-Za-z0-9._-]+)"/i) ||
    html.match(/"canonicalBaseUrl":"\/(@[A-Za-z0-9._-]+)"/i);
  const handle = handleM ? handleM[1] : null;

  const nameM =
    head.match(/"pageTitle":"((?:[^"\\]|\\.)*)"/) ||
    html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) ||
    html.match(/<meta[^>]+name="title"[^>]+content="([^"]+)"/i);
  const name = nameM
    ? nameM[1]
        .replace(/\\u0026/g, "&")
        .replace(/\\"/g, '"')
        .replace(/&amp;/g, "&")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .trim()
    : null;

  // The canonical UC… id — lets an @handle-keyed entry also match tiles /
  // navigation that use /channel/UC….
  //
  // ORDER MATTERS, and only page-identity sources are safe here. The bare
  // `"channelId"` and `/channel/UC…` matches that used to lead this list are
  // NOT unique to the page: a channel page embeds shelves of other people's
  // videos, each carrying its own channelId, so the old order recorded a
  // STRANGER's UC id. That id then went into blockedByUcid and into a DNR
  // redirect rule, silently blocking an innocent channel.
  // <link rel="canonical"> and <meta itemprop> both describe only this page.
  const ucM =
    html.match(/<link[^>]+rel="canonical"[^>]+href="https?:\/\/[^"]*\/channel\/(UC[A-Za-z0-9_-]{22})"/i) ||
    html.match(/<meta[^>]+itemprop="(?:identifier|channelId)"[^>]+content="(UC[A-Za-z0-9_-]{22})"/i) ||
    html.match(/"externalId":"(UC[A-Za-z0-9_-]{22})"/);
  const ucid = ucM ? ucM[1] : null;

  return { subs, handle, name, ucid, headed: !!head };
}

// Which channel does this video belong to? /embed/<id> renders a working
// player with no channel byline, no canonical link and no ytInitialData the
// content script can read, so the DOM simply cannot answer this — without a
// lookup, a blocked channel's video plays fine under /embed/. oEmbed is a
// small public JSON endpoint (no API key) that returns author_url.
// Bounded in-memory cache; a service-worker restart just re-fetches.
const videoChannelCache = new Map(); // videoId -> "@handle" | "UC…" | null
const VIDEO_CHANNEL_CACHE_MAX = 500;
async function resolveVideoChannel(videoId) {
  if (!/^[\w-]{11}$/.test(videoId || "")) return null;
  if (videoChannelCache.has(videoId)) return videoChannelCache.get(videoId);
  let key = null;
  try {
    const res = await fetch(
      "https://www.youtube.com/oembed?format=json&url=" +
        encodeURIComponent("https://www.youtube.com/watch?v=" + videoId)
    );
    // 401/404 = private, deleted or age-restricted. Nothing to resolve; cache
    // the miss so a page that keeps re-checking doesn't keep re-fetching.
    if (res.ok) {
      const data = await res.json();
      const m = String(data.author_url || "").match(/\/(channel\/UC[\w-]{22}|@[\w.-]+)/);
      if (m) key = m[1].startsWith("channel/") ? m[1].slice("channel/".length) : m[1];
    }
  } catch (e) {
    return null; // offline — don't cache a network failure as "no channel"
  }
  if (videoChannelCache.size >= VIDEO_CHANNEL_CACHE_MAX) {
    videoChannelCache.delete(videoChannelCache.keys().next().value);
  }
  videoChannelCache.set(videoId, key);
  return key;
}

// A channel is keyed by whichever identity the DOM link the user blocked from
// happened to carry — but feed tiles link @handles while imports and channel
// URLs carry UC ids, and DNR needs both. Resolve the other half right when a
// channel is blocked (fire-and-forget: the block itself must not wait on the
// network), then rebroadcast so open tabs and the DNR rules pick it up.
// Without this, blocking a channel from its /@handle page leaves
// youtube.com/channel/UC… reachable until the next "fetch sub counts" sweep.
async function enrichChannelIdentity(key) {
  try {
    const info = await scrapeChannelInfo(key);
    if (!info || info.rateLimited) return;
    if (!info.handle && !info.ucid && info.subs == null && !info.name) return;
    await applyChannelInfo({ [key]: info });
    await broadcastUpdate(await loadAll());
  } catch (e) {
    // Offline / blocked fetch — the entry still blocks by the key it has.
    console.debug("[XrnTube] identity enrich failed", e);
  }
}

// Two entries can be one channel — blocked once as "@foo" and once as
// "UC…" — and that only shows once a lookup (or an import) has paired the
// identities. Fold each such group into its earliest entry: the stricter mode
// wins, video-only exceptions combine, and whatever the survivor lacks comes
// from the rest. Mutates `channels`; returns the keys folded away, which need
// tombstones so other devices drop them too.
function foldDuplicateChannels(channels) {
  const norm = (k) => (k && k[0] === "@" ? k.toLowerCase() : k);
  const parent = new Map();
  const find = (k) => (parent.get(k) === k ? k : (parent.set(k, find(parent.get(k))), parent.get(k)));
  const owner = new Map(); // identity -> a key that answers to it
  for (const [key, e] of Object.entries(channels)) {
    parent.set(key, key);
    for (const id of [key, e.handle, e.ucid].filter(Boolean).map(norm)) {
      if (owner.has(id)) parent.set(find(key), find(owner.get(id)));
      else owner.set(id, key);
    }
  }
  const groups = new Map();
  for (const key of parent.keys()) {
    const root = find(key);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root).push(key);
  }
  const folded = [];
  const now = syncedNow();
  for (const keys of groups.values()) {
    if (keys.length < 2) continue;
    keys.sort((a, b) => (channels[a].ts || 0) - (channels[b].ts || 0) || (a < b ? -1 : 1));
    const [keep, ...rest] = keys;
    const m = { ...channels[keep] };
    for (const k of rest) {
      const o = channels[k];
      const soft = (e) => e.mode === CHANNEL_MODE.EXCEPT_WHITELIST;
      if (soft(m) && soft(o)) {
        m.whitelist = { ...(o.whitelist || {}), ...(m.whitelist || {}) };
        if (!(m.blockOlderThanDays > 0) && o.blockOlderThanDays > 0) m.blockOlderThanDays = o.blockOlderThanDays;
      } else if (soft(m)) {
        m.mode = CHANNEL_MODE.FULL; // a full block anywhere is a full block
        delete m.blockOlderThanDays;
      }
      if (!m.name || m.name === keep) m.name = o.name || m.name;
      if (!keep.startsWith("@") && !m.handle) m.handle = k.startsWith("@") ? k : o.handle;
      if (!keep.startsWith("UC") && !m.ucid) m.ucid = k.startsWith("UC") ? k : o.ucid;
      if ((o.subsAt || 0) > (m.subsAt || 0) && o.subs) Object.assign(m, { subs: o.subs, subsAt: o.subsAt, subsV: o.subsV });
      if (m.gone && !o.gone) delete m.gone;
      delete channels[k];
      folded.push(k);
    }
    for (const f of ["handle", "ucid"]) if (!m[f]) delete m[f];
    m.updated_at = now;
    channels[keep] = m;
  }
  return folded;
}

async function tombstoneAll(kind, keys) {
  if (!keys.length) return;
  const tombs = await getTombstones();
  const now = syncedNow();
  for (const k of keys) tombs[kind + ":" + k] = now;
  await setTombstones(tombs);
}

// Merge a { id: {subs, handle, name, ucid} } map into the blocklist in one
// write. `name` only replaces a name that's empty or just the id/handle;
// `handle` never overwrites an existing one.
async function applyChannelInfo(map) {
  const ids = Object.keys(map);
  if (!ids.length) return 0;
  const now = syncedNow();

  const patch = (id, e) => {
    const info = map[id];
    const n = { ...e, subsAt: now, updated_at: now, subsV: SUBS_SCRAPE_VERSION };
    // Permanently unfetchable: stamp it so the auto-fetch stops asking and the
    // row can say "gone" rather than looking like it just hasn't loaded.
    if (info.gone) {
      n.gone = true;
      n.subs = "n/a";
      return n;
    }
    if (e.gone) delete n.gone; // it came back
    if (info.subs != null) n.subs = info.subs;
    if (info.handle && !e.handle) n.handle = info.handle;
    // Store the UC id on @handle-keyed entries (for a UC-keyed entry the key
    // already is the UC id, so no point duplicating it).
    if (info.ucid && !e.ucid && !id.startsWith("UC")) n.ucid = info.ucid;
    if (info.name && (!e.name || e.name === id || e.name === e.handle || e.name === info.handle)) {
      n.name = info.name;
    }
    return n;
  };

  let folded = [];
  await updateStore((s) => {
    let n = 0;
    for (const id of ids) {
      if (!s.channels[id]) continue;
      s.channels[id] = patch(id, s.channels[id]);
      n++;
    }
    if (!n) return false;
    // A lookup is what pairs a channel's two identities.
    folded = foldDuplicateChannels(s.channels);
  });
  await tombstoneAll("channel", folded);
  return ids.length;
}

// ---------- broadcast fresh blocklist to every open YouTube tab ----------
// `fromSync` is set when the write came from the sync merge itself — skip
// re-notifying server-sync.js in that case, or every pull would schedule another
// push (harmless, since the next cycle finds nothing to do, but wasteful).
async function broadcastUpdate(state, { fromSync = false } = {}) {
  const payload = {
    type: MSG.BLOCKLIST_UPDATED,
    channels: state.channels,
    videos: state.videos,
    allowlist: (await getAllowlist()).list
  };
  const tabs = await chrome.tabs.query({ url: ["*://www.youtube.com/*", "*://m.youtube.com/*"] });
  for (const tab of tabs) {
    chrome.tabs.sendMessage(tab.id, payload).catch(() => {});
  }
  await rebuildDnrRules(state);
  if (!fromSync && self.XrnTube.serverSync) self.XrnTube.serverSync.onLocalChange();
}

// ---------- looking channels up, gently ----------
// Each lookup is one or two channel-page fetches from youtube.com. Fired 16 at
// a time (as it used to be), a few hundred of them in a row got this machine
// answered with Google's "unusual traffic" page. So: a few lanes, a pause
// between requests, and the first sign of throttling (a 429, or a fetch that
// fails outright — see fetchChannelPage) stops the run and hands the rest back
// to be tried later. A channel is never recorded, or dropped, on a throttle.
const LOOKUP_LANES = 3;
const LOOKUP_SPACING_MS = 300; // per lane, plus up to as much again of jitter
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function lookupChannels(ids) {
  const results = {};
  const left = [];
  let next = 0;
  let throttled = false;
  const lane = async () => {
    while (!throttled && next < ids.length) {
      const id = ids[next++];
      const info = await scrapeChannelInfo(id).catch(() => null);
      if (info && info.rateLimited) {
        throttled = true;
        left.push(id);
        break;
      }
      // null (a 5xx and the like) is left unrecorded: the next sweep asks again.
      if (info) results[id] = info;
      await sleep(LOOKUP_SPACING_MS * (1 + Math.random()));
    }
  };
  await Promise.all(Array.from({ length: Math.min(LOOKUP_LANES, ids.length) }, lane));
  left.push(...ids.slice(next));
  return { results, throttled, left };
}

// ---------- the sweep: a big lookup that outlives the options page ----------
// "Fetch all sub counts", the auto-fetch on opening the options page, an
// import's follow-up: all of them queue channels here instead of looping in
// the page, so closing the page no longer stops the work. The queue and the
// counters live in chrome.storage.local, which is also how the options page
// shows progress; an alarm brings a suspended worker back to finish it.
// Throttling pauses the whole queue with a growing delay (30s up to 15min).
const SWEEP_KEY = "bt_sweep";
const SWEEP_ALARM = "bt-sweep";
const SWEEP_BATCH = 24; // channels per storage write
let sweep = null; // in-memory copy of SWEEP_KEY
let sweepLoop = null;

async function loadSweep() {
  if (!sweep) {
    const r = await chrome.storage.local.get(SWEEP_KEY);
    sweep = r[SWEEP_KEY] || { queue: [], total: 0, done: 0, got: 0, missed: 0, label: "" };
  }
  return sweep;
}
const saveSweep = () => chrome.storage.local.set({ [SWEEP_KEY]: sweep });

// What the options page needs: everything but the queue itself.
function sweepStatus(s) {
  const { queue, ...rest } = s;
  return { ...rest, queued: queue.length };
}

async function startSweep(ids, label) {
  const s = await loadSweep();
  if (!s.queue.length) {
    Object.assign(s, { total: 0, done: 0, got: 0, missed: 0, label: label || "", stopped: false, finishedAt: 0 });
  }
  const queued = new Set(s.queue);
  const fresh = [...new Set(ids)].filter((id) => !queued.has(id));
  s.queue.push(...fresh);
  s.total += fresh.length;
  await saveSweep();
  kickSweep();
  return s;
}

async function stopSweep() {
  const s = await loadSweep();
  s.queue = [];
  s.stopped = true;
  s.pauseUntil = 0;
  await saveSweep();
  chrome.alarms.clear(SWEEP_ALARM);
  return s;
}

function kickSweep() {
  if (!sweepLoop) sweepLoop = runSweep().finally(() => (sweepLoop = null));
}

async function runSweep() {
  const s = await loadSweep();
  let sinceBroadcast = 0;
  while (s.queue.length) {
    const wait = (s.pauseUntil || 0) - Date.now();
    if (wait > 0) {
      // A long pause belongs to the alarm, so a suspended worker comes back.
      chrome.alarms.create(SWEEP_ALARM, { when: s.pauseUntil });
      if (wait > 25000) return;
      await sleep(wait);
      continue;
    }
    chrome.alarms.create(SWEEP_ALARM, { delayInMinutes: 1 }); // watchdog while working
    const batch = s.queue.slice(0, SWEEP_BATCH);
    const { results, throttled, left } = await lookupChannels(batch);
    await applyChannelInfo(results);
    const handled = new Set(batch.filter((id) => !left.includes(id)));
    // The queue may have been stopped or added to meanwhile.
    s.queue = s.queue.filter((id) => !handled.has(id));
    s.done += handled.size;
    s.got += Object.keys(results).length;
    s.missed += handled.size - Object.keys(results).length;
    if (throttled) {
      s.backoffMs = Math.min(Math.max((s.backoffMs || 0) * 2, 30000), 15 * 60000);
      s.pauseUntil = Date.now() + s.backoffMs;
    } else {
      s.backoffMs = 0;
    }
    await saveSweep();
    // Open tabs start matching by the new @handles as they arrive, not only at the end.
    if ((sinceBroadcast += handled.size) >= 200) {
      sinceBroadcast = 0;
      await broadcastUpdate(await loadAll());
    }
  }
  chrome.alarms.clear(SWEEP_ALARM);
  if (!s.finishedAt) {
    s.finishedAt = Date.now();
    s.pauseUntil = 0;
    s.backoffMs = 0;
    await saveSweep();
    await broadcastUpdate(await loadAll());
  }
}

// ---------- message handling ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    switch (msg.type) {
      case MSG.GET_BLOCKLIST: {
        const state = await loadAll();
        sendResponse({ channels: state.channels, videos: state.videos, allowlist: (await getAllowlist()).list });
        break;
      }
      case MSG.ALLOW_CHANNEL:
      case MSG.DISALLOW_CHANNEL: {
        await setAllowed(idsOf(msg), msg.type === MSG.ALLOW_CHANNEL, msg.note);
        await broadcastUpdate(await loadAll());
        sendResponse({ ok: true });
        break;
      }
      case MSG.BLOCK_CHANNEL: {
        const mode = msg.mode === CHANNEL_MODE.EXCEPT_WHITELIST ? CHANNEL_MODE.EXCEPT_WHITELIST : CHANNEL_MODE.FULL;
        const state = await addEntry("channel", msg.id, msg.name, { mode, whitelist: {} });
        await broadcastUpdate(state);
        sendResponse({ ok: true });
        enrichChannelIdentity(msg.id);
        break;
      }
      case MSG.SET_CHANNEL_MODE: {
        const mode = msg.mode === CHANNEL_MODE.EXCEPT_WHITELIST ? CHANNEL_MODE.EXCEPT_WHITELIST : CHANNEL_MODE.FULL;
        const state = await mutateEntries("channel", idsOf(msg), (entry) => ({ ...entry, mode }));
        await broadcastUpdate(state);
        sendResponse({ ok: true });
        break;
      }
      case MSG.WHITELIST_CHANNEL_VIDEO: {
        const state = await mutateChannelEntry(msg.id, (entry) => ({
          ...entry,
          whitelist: { ...(entry.whitelist || {}), [msg.videoId]: msg.title || "" }
        }));
        await broadcastUpdate(state);
        sendResponse({ ok: true });
        break;
      }
      case MSG.UNWHITELIST_CHANNEL_VIDEO: {
        const state = await mutateChannelEntry(msg.id, (entry) => {
          const whitelist = { ...(entry.whitelist || {}) };
          delete whitelist[msg.videoId];
          return { ...entry, whitelist };
        });
        await broadcastUpdate(state);
        sendResponse({ ok: true });
        break;
      }
      case MSG.SET_ENTRY_HIDDEN: {
        // Pure options-UI flag — the entry stays blocked. No need to re-scrub
        // tabs, but broadcastUpdate keeps the flag flowing to the sync server / other
        // devices and refreshes any open options page via storage.onChanged.
        const kind = msg.kind === "video" ? "video" : "channel";
        const state = await mutateEntries(kind, idsOf(msg), (entry) => ({ ...entry, hidden: !!msg.hidden }));
        await broadcastUpdate(state);
        sendResponse({ ok: true });
        break;
      }
      case MSG.SET_CHANNEL_AGE_RULE: {
        const days = Math.max(0, Math.floor(Number(msg.days) || 0));
        const state = await mutateChannelEntry(msg.id, (entry) => ({
          ...entry,
          blockOlderThanDays: days
        }));
        await broadcastUpdate(state);
        sendResponse({ ok: true, days });
        break;
      }
      case MSG.FETCH_CHANNEL_SUBS: {
        // Single channel (per-row chip). No broadcastUpdate — sub count /
        // handle / name are cosmetic (content scripts and DNR don't need
        // them), and the options page repaints from storage.onChanged. Doing
        // a full broadcast + DNR rebuild per fetch is what made a big sweep
        // crawl.
        const info = await scrapeChannelInfo(msg.id);
        if (info && info.rateLimited) {
          sendResponse({ ok: false, rateLimited: true });
          break;
        }
        if (info && (info.subs != null || info.handle || info.name)) {
          await applyChannelInfo({ [msg.id]: info });
          sendResponse({ ok: true, subs: info.subs || null, handle: info.handle || null });
        } else {
          sendResponse({ ok: false });
        }
        break;
      }
      case MSG.BULK_FETCH_CHANNEL_INFO: {
        // A small lookup the caller waits for (tests, mostly). Anything big
        // goes through START_SWEEP, which survives the caller going away.
        const ids = Array.isArray(msg.ids) ? msg.ids.slice(0, 80) : [];
        const { results, throttled } = await lookupChannels(ids);
        const written = await applyChannelInfo(results);
        sendResponse({ ok: true, got: Object.keys(results).length, written, rateLimited: throttled });
        break;
      }
      case MSG.START_SWEEP: {
        const s = await startSweep(Array.isArray(msg.ids) ? msg.ids : [], msg.label);
        sendResponse({ ok: true, sweep: sweepStatus(s) });
        break;
      }
      case MSG.STOP_SWEEP: {
        sendResponse({ ok: true, sweep: sweepStatus(await stopSweep()) });
        break;
      }
      case MSG.GET_SWEEP: {
        sendResponse({ ok: true, sweep: sweepStatus(await loadSweep()) });
        break;
      }
      case MSG.BLOCK_VIDEO: {
        const state = await addEntry("video", msg.id, msg.title);
        await broadcastUpdate(state);
        sendResponse({ ok: true });
        break;
      }
      case MSG.UNBLOCK_CHANNEL: {
        const state = await removeEntry("channel", msg.id);
        await broadcastUpdate(state);
        sendResponse({ ok: true, undoTs: state.undoTs });
        break;
      }
      case MSG.UNBLOCK_VIDEO: {
        const state = await removeEntry("video", msg.id);
        await broadcastUpdate(state);
        sendResponse({ ok: true, undoTs: state.undoTs });
        break;
      }
      case MSG.DELETE_DATA: {
        const state = await deleteData(msg);
        await broadcastUpdate(state);
        sendResponse({ ok: true, undoTs: state.undoTs, removed: state.removed });
        break;
      }
      case MSG.IMPORT_BLOCKLIST: {
        // Merge everything in one store update — not addEntry per entry,
        // which on a few-thousand-channel file is a few thousand writes.
        const now = syncedNow();
        const clearedTombs = [];
        const added = { channels: 0, videos: 0 };
        let enriched = 0;
        let duplicates = 0;
        let allowAdded = 0;
        let folded = [];
        await updateStore(async (state) => {
          const { channels, videos } = state;

          // Every identity an existing entry answers to — its key, its scraped
          // @handle, its scraped UC id — so an import naming a channel by the
          // OTHER format lands on the entry that's already there instead of
          // creating a second one. Handles compare lowercased, as everywhere.
          const idKey = (k) => (String(k).startsWith("@") ? String(k).toLowerCase() : String(k));
          const owner = new Map();
          const indexEntry = (key, e) => {
            owner.set(idKey(key), key);
            if (e && e.handle) owner.set(idKey(e.handle), key);
            if (e && e.ucid) owner.set(idKey(e.ucid), key);
          };
          for (const [key, e] of Object.entries(channels)) indexEntry(key, e);

          for (const [id, entry] of Object.entries(msg.channels || {})) {
            if (!entry || typeof entry !== "object") continue;
            const existingKey = owner.get(idKey(id)) || (entry.handle && owner.get(idKey(entry.handle))) ||
              (entry.ucid && owner.get(idKey(entry.ucid)));
            if (existingKey) {
              // Already blocked: its mode, whitelist and age rule stay as they
              // are, but anything it doesn't know yet — the sub count, the
              // other identity, a real name — comes in from the file. Skipping
              // the entry outright is what made re-importing a backup unable to
              // restore sub counts onto a list that already had the channels.
              const cur = channels[existingKey];
              const next = { ...cur };
              if (entry.subs && !cur.subs) {
                next.subs = String(entry.subs);
                next.subsAt = Number(entry.subsAt) || now;
                if (Number(entry.subsV) > 0) next.subsV = Number(entry.subsV);
              }
              const otherHandle = id.startsWith("@") ? id : entry.handle;
              const otherUcid = id.startsWith("UC") ? id : entry.ucid;
              if (otherHandle && !existingKey.startsWith("@") && !cur.handle) next.handle = String(otherHandle);
              if (otherUcid && !existingKey.startsWith("UC") && !cur.ucid) next.ucid = String(otherUcid);
              if (entry.name && (!cur.name || cur.name === existingKey || cur.name === cur.handle)) {
                next.name = String(entry.name);
              }
              if (JSON.stringify(next) !== JSON.stringify(cur)) {
                next.updated_at = now;
                channels[existingKey] = next;
                indexEntry(existingKey, next);
                enriched++;
              } else {
                duplicates++;
              }
              continue;
            }
            // Preserve mode/whitelist from an exported blocklist — otherwise a
            // re-imported EXCEPT_WHITELIST channel would silently revert to a
            // full block and lose its exceptions.
            added.channels++;
            channels[id] = {
              name: entry.name || "",
              ts: Number(entry.ts) || now,
              updated_at: now,
              mode: entry.mode === CHANNEL_MODE.EXCEPT_WHITELIST ? CHANNEL_MODE.EXCEPT_WHITELIST : CHANNEL_MODE.FULL,
              whitelist: entry.whitelist && typeof entry.whitelist === "object" ? entry.whitelist : {}
            };
            // Carry across the optional per-entry extras if the export had them.
            if (entry.hidden) channels[id].hidden = true;
            if (Number(entry.blockOlderThanDays) > 0) {
              channels[id].blockOlderThanDays = Math.floor(Number(entry.blockOlderThanDays));
            }
            if (entry.subs) channels[id].subs = String(entry.subs);
            // The lookup's stamp travels with the entry even when the lookup
            // found no number — otherwise every failed lookup in a backup came
            // back as "never tried" and was fetched again on each restore.
            // `subsV` says which scrape produced it; without it a re-imported
            // export looks like it predates the current scrape and the whole
            // list gets swept again for counts it already has.
            if (Number(entry.subsAt) > 0 || entry.subs) channels[id].subsAt = Number(entry.subsAt) || now;
            if (channels[id].subsAt && Number(entry.subsV) > 0) channels[id].subsV = Number(entry.subsV);
            if (entry.handle) channels[id].handle = String(entry.handle);
            if (entry.ucid) channels[id].ucid = String(entry.ucid);
            // A channel the export already knew was gone stays gone — otherwise
            // re-importing a backup puts every dead channel back in the
            // auto-fetch queue, which is the loop the flag exists to end. A
            // later successful scrape clears it (see applyChannelInfo).
            if (entry.gone) channels[id].gone = true;
            // ...and the same channel named twice in one file, once per format,
            // is one entry.
            indexEntry(id, channels[id]);
            clearedTombs.push("channel:" + id);
          }
          for (const [id, entry] of Object.entries(msg.videos || {})) {
            if (!entry || typeof entry !== "object") continue;
            if (videos[id]) {
              if (entry.title && !videos[id].title) {
                videos[id] = { ...videos[id], title: String(entry.title), updated_at: now };
                enriched++;
              } else {
                duplicates++;
              }
              continue;
            }
            added.videos++;
            videos[id] = { title: entry.title || "", ts: Number(entry.ts) || now, updated_at: now };
            if (entry.hidden) videos[id].hidden = true;
            clearedTombs.push("video:" + id);
          }

          // A backup's never-block list, merged in one write.
          if (msg.allowlist && typeof msg.allowlist === "object") {
            const cur = await getAllowlist();
            const list = { ...cur.list };
            for (const [key, v] of Object.entries(msg.allowlist)) {
              const norm = normAllowKey(key);
              if (!norm || list[norm]) continue;
              list[norm] = { note: (v && v.note) || "", ts: Number(v && v.ts) || Date.now() };
              allowAdded++;
            }
            if (allowAdded) await chrome.storage.sync.set({ [ALLOWLIST_KEY]: { list, ts: Date.now() } }).catch(() => {});
          }
          folded = foldDuplicateChannels(channels);
        });
        await tombstoneAll("channel", folded);
        if (clearedTombs.length) {
          const tombs = await getTombstones();
          let touched = false;
          for (const k of clearedTombs) {
            if (tombs[k] !== undefined) {
              delete tombs[k];
              touched = true;
            }
          }
          if (touched) await setTombstones(tombs);
        }

        const fresh = await loadAll();
        await broadcastUpdate(fresh);
        sendResponse({
          ok: true,
          // totals after the merge
          channels: Object.keys(fresh.channels).length,
          videos: Object.keys(fresh.videos).length,
          // what this file changed
          added,
          enriched,
          duplicates,
          allowAdded,
          folded: folded.length
        });
        break;
      }
      case MSG.RESOLVE_VIDEO_CHANNEL: {
        sendResponse({ ok: true, channelKey: await resolveVideoChannel(msg.videoId) });
        break;
      }
      case MSG.REBROADCAST_BLOCKLIST: {
        await broadcastUpdate(await loadAll());
        sendResponse({ ok: true });
        break;
      }
      case MSG.GET_RECENT_UNBLOCKS: {
        sendResponse({ ok: true, log: await getRecentUnblocks() });
        break;
      }
      case MSG.RESTORE_UNBLOCK: {
        const state = await restoreRecentUnblock(msg.ts != null ? { ts: msg.ts } : { index: msg.index });
        await broadcastUpdate(state);
        sendResponse({ ok: true });
        break;
      }
      case MSG.CLEAR_RECENT_UNBLOCKS: {
        await chrome.storage.local.set({ [RECENT_UNBLOCK_KEY]: [] });
        sendResponse({ ok: true });
        break;
      }
      case MSG.GET_SYNC_STATUS: {
        sendResponse(await self.XrnTube.serverSync.status());
        break;
      }
      case MSG.SET_SYNC_CONFIG: {
        // msg.conn: { url, user, password } to connect, or null to disconnect.
        sendResponse(await self.XrnTube.serverSync.configure(msg.conn || null));
        break;
      }
      case MSG.SYNC_NOW: {
        sendResponse(await self.XrnTube.serverSync.syncNow());
        break;
      }
      case MSG.SYNC_HISTORY: {
        sendResponse(await self.XrnTube.serverSync.history());
        break;
      }
      case MSG.SYNC_HISTORY_GET: {
        sendResponse(await self.XrnTube.serverSync.historyItem(msg.name));
        break;
      }
      default:
        break;
    }
  })();
  return true; // keep the message channel open for the async response
});

// Rebuild DNR rules on browser/extension startup since dynamic rules don't
// automatically re-derive themselves from storage.
chrome.runtime.onStartup.addListener(async () => {
  const state = await loadAll();
  await rebuildDnrRules(state);
  self.XrnTube.serverSync.onPoll();
});
chrome.runtime.onInstalled.addListener(async () => {
  const state = await loadAll();
  await rebuildDnrRules(state);
  setUpContextMenus();
});

// ---------- right-click to block ----------
// The `contextMenus` permission had been declared for years without a single
// call behind it. This is what it was for: block straight from a link (or the
// page you're on) without opening the popup.
//
// Menu items can't inspect what you right-clicked before they're shown, so
// both items always appear on youtube.com and the click handler works out what
// the URL actually is. A click that resolves to nothing reports back rather
// than failing silently — feedback goes through the content script's toast, so
// this needs no `notifications` permission.
const CTX_BLOCK_CHANNEL = "bt-block-channel";
const CTX_BLOCK_VIDEO = "bt-block-video";

function setUpContextMenus() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    const common = { contexts: ["link", "page", "video"], documentUrlPatterns: ["*://*.youtube.com/*"] };
    chrome.contextMenus.create({ id: CTX_BLOCK_CHANNEL, title: "XrnTube: block this channel", ...common });
    chrome.contextMenus.create({ id: CTX_BLOCK_VIDEO, title: "XrnTube: block this video", ...common });
    void chrome.runtime.lastError; // creating over an existing id is not fatal
  });
}

// Same URL shapes the nav guard covers (see content.js) — a link can be any of
// them, and /c/ and /user/ name neither identity so they can't be keyed.
const CTX_VIDEO_RE = /(?:[?&]v=|\/(?:shorts|live|embed|v)\/)([\w-]{11})/;
const CTX_CHANNEL_RE = /youtube\.com\/(channel\/UC[\w-]{22}|@[\w.-]+)/;

function ctxTargetFrom(info) {
  const url = info.linkUrl || info.srcUrl || info.pageUrl || "";
  const v = url.match(CTX_VIDEO_RE);
  const c = url.match(CTX_CHANNEL_RE);
  const key = c ? (c[1].startsWith("channel/") ? c[1].slice("channel/".length) : c[1]) : null;
  return { url, videoId: v ? v[1] : null, channelKey: key };
}

async function toast(tabId, text) {
  if (tabId == null) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: MSG.SHOW_TOAST, text });
  } catch {
    // no content script in that tab (not a YouTube page, or not loaded yet)
  }
}

if (chrome.contextMenus) {
  chrome.contextMenus.onClicked.addListener(async (info, tab) => {
    const tabId = tab && tab.id;
    const { videoId, channelKey } = ctxTargetFrom(info);

    if (info.menuItemId === CTX_BLOCK_VIDEO) {
      if (!videoId) return toast(tabId, "XrnTube: no video in that link.");
      const state = await addEntry("video", videoId, "");
      await broadcastUpdate(state);
      return toast(tabId, "Video blocked.");
    }

    if (info.menuItemId !== CTX_BLOCK_CHANNEL) return;
    // A channel link names the channel outright. A video link doesn't, so fall
    // back to the same oEmbed lookup the /embed/ guard uses.
    let key = channelKey;
    if (!key && videoId) key = await resolveVideoChannel(videoId);
    if (!key) return toast(tabId, "XrnTube: couldn't work out which channel that is.");
    const state = await addEntry("channel", key, "", { mode: CHANNEL_MODE.FULL, whitelist: {} });
    await broadcastUpdate(state);
    // Fills in the real name and the other identity format, as a popup block does.
    enrichChannelIdentity(key);
    toast(tabId, `Blocked ${key}.`);
  });
}

// ---------- sync through your own server (background/server-sync.js) ----------
// server-sync.js never touches blocklist storage itself — it goes through this
// host object. applyMergedState() is the merge's write path: replace the list
// and the tombstones, then broadcast with fromSync so it doesn't loop back into
// a push.
const syncHost = {
  loadAll: async () => {
    const s = await loadAll();
    return { channels: s.channels, videos: s.videos };
  },
  getTombstones,
  now: syncedNow,
  setClockOffset: (ms) => {
    if (Number.isFinite(ms)) clockOffset = ms;
  },
  applyMergedState: async ({ channels, videos, tombstones }) => {
    await writeFullState(channels, videos);
    await setTombstones(tombstones);
    const state = await loadAll();
    await broadcastUpdate(state, { fromSync: true });
  }
};

self.XrnTube.serverSync.init(syncHost);

// Periodic pull. Alarm registration is top-level and synchronous (MV3-safe);
// the debounced push in server-sync.js can be lost if the worker sleeps, and
// this is its backstop.
chrome.alarms.create(SYNC.POLL_ALARM, { periodInMinutes: SYNC.POLL_PERIOD_MIN });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC.POLL_ALARM) self.XrnTube.serverSync.onPoll();
  if (alarm.name === SWEEP_ALARM) kickSweep();
});
// Whatever woke the worker, an unfinished sweep carries on.
loadSweep().then((s) => {
  if (s.queue.length) kickSweep();
});

// The homepage/Shorts network redirects are toggle-gated in rebuildDnrRules,
// so a settings change has to rebuild the DNR rule set. (content.js watches
// bt_settings itself for its own behaviours.)
//
// Settings, keywords and the never-block list are written straight to
// chrome.storage.sync by whichever page edits them, never through
// broadcastUpdate(), so this is where the server sync hears about them. A
// change the sync cycle itself wrote lands here too; the cycle it schedules
// finds nothing to push.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "sync") return;
  if (changes[SETTINGS_KEY] || changes[KEYWORDS_KEY] || changes[ALLOWLIST_KEY]) {
    self.XrnTube.serverSync.onLocalChange();
  }
  if (changes[SETTINGS_KEY]) {
    await rebuildDnrRules(await loadAll());
  }
});
