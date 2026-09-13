// Chrome runs this file as an MV3 service worker, where importScripts() exists.
// Firefox runs it as a classic background script listed in manifest
// background.scripts, where importScripts() is undefined and constants.js +
// gist-sync.js are loaded as earlier entries in that same list instead.
if (typeof importScripts === "function") {
  importScripts("../shared/constants.js", "./gist-sync.js");
}

const { MSG, STORAGE, CHANNEL_MODE, SYNC, SETTINGS_KEY, DEFAULT_SETTINGS, ALLOWLIST_KEY } = self.BlockTube;

// A cross-device clock: gist-sync.js feeds GitHub's response Date header back
// through syncHost.setClockOffset so last-write-wins merges aren't corrupted by
// device clock skew. Everything that stamps `updated_at` / a tombstone time
// goes through syncedNow(); with no sync configured this is just Date.now().
let clockOffset = 0;
function syncedNow() {
  return Date.now() + clockOffset;
}

// ---------- Chunked chrome.storage.sync engine ----------
// Each blocked channel/video is a small object stored inside one of several
// "chunk" objects so no single storage item ever approaches the 8KB/item cap.
// If the sync quota (512 items / 100KB) is ever exhausted, new entries spill
// into chrome.storage.local instead (still blocked locally, just not synced).

function chunkKey(kind, i) {
  return (kind === "channel" ? STORAGE.CHANNEL_CHUNK_PREFIX : STORAGE.VIDEO_CHUNK_PREFIX) + i;
}

async function getMeta() {
  const res = await chrome.storage.sync.get(STORAGE.META_KEY);
  return res[STORAGE.META_KEY] || { channelChunkCount: 0, videoChunkCount: 0 };
}

async function getOverflow() {
  const res = await chrome.storage.local.get(STORAGE.LOCAL_OVERFLOW_KEY);
  return res[STORAGE.LOCAL_OVERFLOW_KEY] || { channels: {}, videos: {} };
}

async function loadChunks(kind, count) {
  if (count === 0) return [];
  const keys = Array.from({ length: count }, (_, i) => chunkKey(kind, i));
  const res = await chrome.storage.sync.get(keys);
  return keys.map((k) => res[k] || {});
}

// Returns { channels: {id: {name, ts, localOnly}}, videos: {id: {title, ts, localOnly}}, meta }
async function loadAll() {
  const meta = await getMeta();
  const [channelChunks, videoChunks, overflow] = await Promise.all([
    loadChunks("channel", meta.channelChunkCount),
    loadChunks("video", meta.videoChunkCount),
    getOverflow()
  ]);

  const channels = Object.assign({}, ...channelChunks);
  const videos = Object.assign({}, ...videoChunks);

  for (const [id, entry] of Object.entries(overflow.channels)) {
    channels[id] = { ...entry, localOnly: true };
  }
  for (const [id, entry] of Object.entries(overflow.videos)) {
    videos[id] = { ...entry, localOnly: true };
  }

  return { channels, videos, meta, channelChunks, videoChunks, overflow };
}

function totalSyncItems(channelChunks, videoChunks) {
  return (
    channelChunks.reduce((n, c) => n + Object.keys(c).length, 0) +
    videoChunks.reduce((n, c) => n + Object.keys(c).length, 0)
  );
}

async function addEntry(kind, id, label, extra) {
  const state = await loadAll();
  const map = kind === "channel" ? state.channels : state.videos;
  if (map[id]) return state; // already blocked

  // Re-blocking supersedes any earlier unblock — drop its tombstone so the
  // gist merge doesn't treat this entry as deleted on the next cycle.
  await clearTombstone(kind, id);

  const now = syncedNow();
  const entry = {
    [kind === "channel" ? "name" : "title"]: label || "",
    ts: now,
    updated_at: now, // bumped on every mutation; drives last-write-wins in gist-sync.js
    ...(extra || {})
  };
  const chunks = kind === "channel" ? state.channelChunks : state.videoChunks;
  const chunkCountKey = kind === "channel" ? "channelChunkCount" : "videoChunkCount";
  const syncCount = totalSyncItems(state.channelChunks, state.videoChunks);

  const tryLocalOverflow = async () => {
    const overflowBucket = kind === "channel" ? "channels" : "videos";
    state.overflow[overflowBucket][id] = entry;
    await chrome.storage.local.set({ [STORAGE.LOCAL_OVERFLOW_KEY]: state.overflow });
  };

  if (syncCount >= STORAGE.MAX_SYNC_ITEMS) {
    await tryLocalOverflow();
    return loadAll();
  }

  let targetIndex = chunks.findIndex((c) => Object.keys(c).length < STORAGE.CHUNK_SIZE);
  const meta = { ...state.meta };
  if (targetIndex === -1) {
    targetIndex = chunks.length;
    meta[chunkCountKey] = targetIndex + 1;
  }
  const updatedChunk = { ...(chunks[targetIndex] || {}), [id]: entry };

  try {
    await chrome.storage.sync.set({
      [chunkKey(kind, targetIndex)]: updatedChunk,
      [STORAGE.META_KEY]: meta
    });
  } catch (err) {
    console.warn("BlockTube: sync quota hit, falling back to local-only storage", err);
    await tryLocalOverflow();
  }

  return loadAll();
}

async function removeEntry(kind, id) {
  const state = await loadAll();
  const bucket = kind === "channel" ? "channels" : "videos";
  const removed = state[bucket][id]; // snapshot for the undo log
  const chunks = kind === "channel" ? state.channelChunks : state.videoChunks;

  for (let i = 0; i < chunks.length; i++) {
    if (id in chunks[i]) {
      const updated = { ...chunks[i] };
      delete updated[id];
      await chrome.storage.sync.set({ [chunkKey(kind, i)]: updated });
      break;
    }
  }

  if (state.overflow[bucket][id]) {
    const updated = { ...state.overflow };
    delete updated[bucket][id];
    await chrome.storage.local.set({ [STORAGE.LOCAL_OVERFLOW_KEY]: updated });
  }

  // Record the deletion so the gist merge propagates it instead of another
  // device's stale copy re-adding the entry.
  await writeTombstone(kind, id);
  if (removed) await pushRecentUnblock({ t: "one", kind, id, entry: stripRuntimeEntry(removed) });

  return loadAll();
}

// ---------- recently-unblocked undo log (chrome.storage.local, not synced) ----------
// A local safety net so an accidental unblock / the "clear all videos" button
// can be reversed. Newest first, capped; each record holds the full entry so a
// restore keeps its mode / whitelist / handle / age rule.
const RECENT_UNBLOCK_KEY = "bt_recent_unblocks";
const RECENT_UNBLOCK_MAX = 40;

function stripRuntimeEntry(e) {
  const { localOnly, ...rest } = e || {};
  return rest;
}

async function getRecentUnblocks() {
  const res = await chrome.storage.local.get(RECENT_UNBLOCK_KEY);
  return Array.isArray(res[RECENT_UNBLOCK_KEY]) ? res[RECENT_UNBLOCK_KEY] : [];
}

async function pushRecentUnblock(record) {
  const log = await getRecentUnblocks();
  log.unshift({ ...record, ts: syncedNow() });
  await chrome.storage.local.set({ [RECENT_UNBLOCK_KEY]: log.slice(0, RECENT_UNBLOCK_MAX) });
}

// Re-add every entry in a log record, then drop the record. Returns the fresh state.
async function restoreRecentUnblock(index) {
  const log = await getRecentUnblocks();
  const rec = log[index];
  if (!rec) return loadAll();
  const readd = async (kind, id, entry) => {
    const e = entry || {};
    await addEntry(kind, id, e.name || e.title || "", {
      mode: e.mode,
      whitelist: e.whitelist,
      handle: e.handle,
      ucid: e.ucid,
      subs: e.subs,
      subsAt: e.subsAt,
      blockOlderThanDays: e.blockOlderThanDays,
      hidden: e.hidden
    });
  };
  if (rec.t === "bulk") {
    for (const [id, entry] of Object.entries(rec.entries || {})) await readd(rec.kind, id, entry);
  } else {
    await readd(rec.kind, rec.id, rec.entry);
  }
  log.splice(index, 1);
  await chrome.storage.local.set({ [RECENT_UNBLOCK_KEY]: log });
  return loadAll();
}

// Applies `mutate(entry) -> entry` to one existing entry, in place wherever it
// currently lives (a sync chunk, or the local overflow bucket) — used for
// flipping CHANNEL_MODE, editing the per-channel whitelist, the `hidden` flag,
// the age rule, and the cached sub count, none of which add/remove an entry so
// addEntry/removeEntry don't fit.
async function mutateEntry(kind, id, mutate) {
  // Every mutation also bumps updated_at so the gist merge sees this device's
  // copy as the newer one.
  const stamp = (entry) => ({ ...mutate(entry), updated_at: syncedNow() });
  const state = await loadAll();
  const bucket = kind === "channel" ? "channels" : "videos";
  if (state.overflow[bucket][id]) {
    const updated = { ...state.overflow };
    updated[bucket] = { ...updated[bucket], [id]: stamp(updated[bucket][id]) };
    await chrome.storage.local.set({ [STORAGE.LOCAL_OVERFLOW_KEY]: updated });
    return loadAll();
  }
  const chunks = kind === "channel" ? state.channelChunks : state.videoChunks;
  for (let i = 0; i < chunks.length; i++) {
    if (id in chunks[i]) {
      const updated = { ...chunks[i], [id]: stamp(chunks[i][id]) };
      await chrome.storage.sync.set({ [chunkKey(kind, i)]: updated });
      break;
    }
  }
  return loadAll();
}

// Back-compat alias for the many channel-only call sites.
const mutateChannelEntry = (id, mutate) => mutateEntry("channel", id, mutate);

// ---------- tombstones (chrome.storage.local) ----------
// A deletion has to outlive the entry itself so the gist merge in gist-sync.js
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

// ---------- full-state rewrite (used by the gist merge) ----------
// addEntry/removeEntry each touch one entry; a sync merge can change many at
// once, so gist-sync.js hands the merged maps here to be re-chunked from
// scratch. Entries past MAX_SYNC_ITEMS (oldest first by ts) spill to the local
// overflow bucket, exactly like addEntry's incremental path.

function chunkMapToArray(map) {
  const ids = Object.keys(map);
  const chunks = [];
  for (let i = 0; i < ids.length; i += STORAGE.CHUNK_SIZE) {
    const chunk = {};
    for (const id of ids.slice(i, i + STORAGE.CHUNK_SIZE)) chunk[id] = map[id];
    chunks.push(chunk);
  }
  return chunks;
}

async function writeFullState(channels, videos) {
  const stripLocal = (e) => {
    const { localOnly, ...rest } = e || {};
    return rest;
  };

  const ranked = [
    ...Object.keys(channels).map((id) => ({ kind: "channel", id })),
    ...Object.keys(videos).map((id) => ({ kind: "video", id }))
  ].sort((a, b) => {
    const ea = a.kind === "channel" ? channels[a.id] : videos[a.id];
    const eb = b.kind === "channel" ? channels[b.id] : videos[b.id];
    return (ea.ts || 0) - (eb.ts || 0);
  });
  const inSync = new Set(ranked.slice(0, STORAGE.MAX_SYNC_ITEMS).map((x) => x.kind + ":" + x.id));

  const syncChannels = {};
  const syncVideos = {};
  const overflow = { channels: {}, videos: {} };
  for (const [id, e] of Object.entries(channels)) {
    (inSync.has("channel:" + id) ? syncChannels : overflow.channels)[id] = stripLocal(e);
  }
  for (const [id, e] of Object.entries(videos)) {
    (inSync.has("video:" + id) ? syncVideos : overflow.videos)[id] = stripLocal(e);
  }

  const channelChunks = chunkMapToArray(syncChannels);
  const videoChunks = chunkMapToArray(syncVideos);
  const meta = { channelChunkCount: channelChunks.length, videoChunkCount: videoChunks.length };

  const prevMeta = await getMeta();
  const staleKeys = [];
  for (let i = channelChunks.length; i < prevMeta.channelChunkCount; i++) staleKeys.push(chunkKey("channel", i));
  for (let i = videoChunks.length; i < prevMeta.videoChunkCount; i++) staleKeys.push(chunkKey("video", i));

  const writes = { [STORAGE.META_KEY]: meta };
  channelChunks.forEach((c, i) => (writes[chunkKey("channel", i)] = c));
  videoChunks.forEach((c, i) => (writes[chunkKey("video", i)] = c));

  if (staleKeys.length) await chrome.storage.sync.remove(staleKeys).catch(() => {});

  try {
    // One bulk write in the common case.
    await chrome.storage.sync.set(writes);
  } catch (err) {
    // The bulk write is all-or-nothing, so one oversized chunk (long
    // multi-byte names can push a 50-entry chunk past the 8KB/item cap) would
    // strand the entire sync side in local-only. Retry in order and, at the
    // first chunk that won't fit, spill it and everything after it to overflow
    // — keeping bt_ch_0..N / bt_vid_0..N contiguous, which loadChunks assumes.
    // Still bounded (a handful of writes), unlike addEntry-per-entry.
    console.warn("BlockTube: bulk sync write failed, retrying per chunk", err);

    const writeInOrder = async (kind, chunks, overflowBucket) => {
      let kept = 0;
      let spilling = false;
      for (let i = 0; i < chunks.length; i++) {
        if (!spilling) {
          try {
            await chrome.storage.sync.set({ [chunkKey(kind, i)]: chunks[i] });
            kept = i + 1;
            continue;
          } catch {
            spilling = true;
          }
        }
        Object.assign(overflowBucket, chunks[i]);
        await chrome.storage.sync.remove(chunkKey(kind, i)).catch(() => {});
      }
      return kept;
    };

    const keptCh = await writeInOrder("channel", channelChunks, overflow.channels);
    const keptVid = await writeInOrder("video", videoChunks, overflow.videos);
    await chrome.storage.sync
      .set({ [STORAGE.META_KEY]: { channelChunkCount: keptCh, videoChunkCount: keptVid } })
      .catch(() => {});
  }
  await chrome.storage.local.set({ [STORAGE.LOCAL_OVERFLOW_KEY]: overflow });
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
// redirected to at the network layer, before YouTube renders anything.
const SAFE_LANDING_URL = "https://www.youtube.com/feed/subscriptions";

async function getSettings() {
  const res = await chrome.storage.sync.get({ [SETTINGS_KEY]: null });
  // resolveSettings expands the legacy coarse keys an older version wrote, so
  // an upgrade doesn't quietly switch a disabled DNR rule back on.
  return self.BlockTube.resolveSettings(res[SETTINGS_KEY]);
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
async function setAllowed(key, on, note) {
  const norm = normAllowKey(key);
  if (!norm) return { list: {}, ts: 0 };
  const cur = await getAllowlist();
  const list = { ...cur.list };
  if (on) list[norm] = { note: note || "", ts: Date.now() };
  else delete list[norm];
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
    console.warn("BlockTube: updateDynamicRules failed, clearing dynamic rules", err);
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds }).catch(() => {});
  }
}

// ---------- scrape a channel's public page (subs + @handle + name) ----------
// No API key: fetch the channel's own page (host permission covers youtube.com)
// and regex the pieces out of the embedded JSON / meta tags. Best-effort —
// YouTube can change this markup, some regions serve a consent wall, and
// channels can hide the sub count. Streamed and stopped early: the bits we
// want are near the top of `ytInitialData`, so we don't download the whole
// ~1MB page. Returns { subs, handle, name } (any may be null), { rateLimited:
// true } on a 429, or null on any other failure.
async function scrapeChannelInfo(key) {
  const path = key.startsWith("@") ? "/" + key : "/channel/" + key;
  let html = "";
  try {
    const res = await fetch("https://www.youtube.com" + path, {
      headers: { "Accept-Language": "en-US,en;q=0.9" }
    });
    if (res.status === 429) return { rateLimited: true };
    if (!res.ok || !res.body) return res.ok ? { subs: null, handle: null, name: null } : null;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    for (let i = 0; i < 500; i++) {
      const { done, value } = await reader.read();
      if (done) break;
      html += dec.decode(value, { stream: true });
      // stop once the page has both the sub count and channel identity in view
      if (
        html.length > 1500000 ||
        (/"subscriberCountText"/.test(html) && /(vanityChannelUrl|canonicalBaseUrl|og:title)/.test(html))
      ) {
        break;
      }
    }
    reader.cancel().catch(() => {});
  } catch {
    return html ? verifyChannelInfo(key, parseChannelHtml(html)) : null;
  }
  return verifyChannelInfo(key, parseChannelHtml(html));
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
    console.debug("[BlockTube] identity mismatch for", asked, "— discarding scraped handle/ucid");
    return { ...info, handle: null, ucid: null };
  }
  return info;
}

function parseChannelHtml(html) {
  const subsScoped = html.match(
    /"subscriberCountText":\{[^{}]*?"(?:simpleText|content)":"([^"]+?) subscribers?"/i
  );
  const subsLoose = subsScoped ? null : html.match(/([\d.,]+\s?[KMB]?)\s+subscribers?/i);
  let subs = (subsScoped && subsScoped[1]) || (subsLoose && subsLoose[1]) || null;
  if (subs) subs = subs.replace(/\s+/g, "").trim();
  else if (/"subscriberCountText"/.test(html)) subs = "hidden";

  // Ordered most- to least-authoritative. "canonicalBaseUrl" is LAST because
  // it is not unique to this page: every video/shelf item in the response
  // carries its own, so on a page whose first shelf item is someone else's
  // video it names the WRONG channel.
  const handleM =
    html.match(/"vanityChannelUrl":"https?:\/\/[^"]*\/(@[A-Za-z0-9._-]+)"/i) ||
    html.match(/<link[^>]+rel="canonical"[^>]+href="https:\/\/www\.youtube\.com\/(@[A-Za-z0-9._-]+)"/i) ||
    html.match(/"canonicalBaseUrl":"\/(@[A-Za-z0-9._-]+)"/i);
  const handle = handleM ? handleM[1] : null;

  const nameM =
    html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i) ||
    html.match(/<meta[^>]+name="title"[^>]+content="([^"]+)"/i);
  const name = nameM
    ? nameM[1]
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
  // videos, each carrying its own channelId. Worse, `"externalId"` (which is
  // authoritative) sits near the very END of the ~2.4MB document, past the
  // point the streaming reader above deliberately stops — so on a real
  // /@handle page the old order fell through to the first `"channelId"` in a
  // shelf and recorded a STRANGER's UC id. That id then went into
  // blockedByUcid and into a DNR redirect rule, silently blocking an innocent
  // channel. <link rel="canonical"> and <meta itemprop> both appear early and
  // describe only this page.
  const ucM =
    html.match(/<link[^>]+rel="canonical"[^>]+href="https?:\/\/[^"]*\/channel\/(UC[A-Za-z0-9_-]{22})"/i) ||
    html.match(/<meta[^>]+itemprop="(?:identifier|channelId)"[^>]+content="(UC[A-Za-z0-9_-]{22})"/i) ||
    html.match(/"externalId":"(UC[A-Za-z0-9_-]{22})"/);
  const ucid = ucM ? ucM[1] : null;

  return { subs, handle, name, ucid };
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
    console.debug("[BlockTube] identity enrich failed", e);
  }
}

// Merge a { id: {subs, handle, name} } map into the blocklist with ONE storage
// write per location (local overflow + at most a handful of sync chunks),
// instead of one write per channel. `name` only replaces a name that's empty
// or just the id/handle; `handle` never overwrites an existing one.
async function applyChannelInfo(map) {
  const ids = Object.keys(map);
  if (!ids.length) return 0;
  const now = syncedNow();
  const state = await loadAll();

  const patch = (id, e) => {
    const info = map[id];
    const n = { ...e, subsAt: now, updated_at: now };
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

  const ovChannels = { ...state.overflow.channels };
  const chunkEdits = {}; // index -> chunk copy
  let touchedOverflow = false;
  for (const id of ids) {
    if (ovChannels[id]) {
      ovChannels[id] = patch(id, ovChannels[id]);
      touchedOverflow = true;
      continue;
    }
    for (let i = 0; i < state.channelChunks.length; i++) {
      if (id in state.channelChunks[i]) {
        chunkEdits[i] = chunkEdits[i] || { ...state.channelChunks[i] };
        chunkEdits[i][id] = patch(id, chunkEdits[i][id]);
        break;
      }
    }
  }

  if (touchedOverflow) {
    await chrome.storage.local
      .set({ [STORAGE.LOCAL_OVERFLOW_KEY]: { channels: ovChannels, videos: state.overflow.videos } })
      .catch(() => {});
  }
  const writes = {};
  for (const [i, chunk] of Object.entries(chunkEdits)) writes[chunkKey("channel", i)] = chunk;
  if (Object.keys(writes).length) {
    await chrome.storage.sync.set(writes).catch(() => {});
  }
  return ids.length;
}

// ---------- broadcast fresh blocklist to every open YouTube tab ----------
// `fromSync` is set when the write came from the gist merge itself — skip
// re-notifying gist-sync.js in that case, or every pull would schedule another
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
  if (!fromSync && self.BlockTube.gistSync) self.BlockTube.gistSync.onLocalChange();
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
        await setAllowed(msg.id, msg.type === MSG.ALLOW_CHANNEL, msg.note);
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
        const state = await mutateChannelEntry(msg.id, (entry) => ({ ...entry, mode }));
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
        // tabs, but broadcastUpdate keeps the flag flowing to the gist / other
        // devices and refreshes any open options page via storage.onChanged.
        const kind = msg.kind === "video" ? "video" : "channel";
        const state = await mutateEntry(kind, msg.id, (entry) => ({ ...entry, hidden: !!msg.hidden }));
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
        const ids = Array.isArray(msg.ids) ? msg.ids.slice(0, 80) : [];
        const results = {};
        let rateLimited = false;
        const queue = ids.slice();
        const worker = async () => {
          while (queue.length) {
            const id = queue.shift();
            const info = await scrapeChannelInfo(id);
            if (info && info.rateLimited) {
              rateLimited = true;
              await new Promise((r) => setTimeout(r, 2500)); // back off this worker
              continue;
            }
            if (info) results[id] = info;
          }
        };
        // 8-wide fetch pool inside the worker (one message, not N).
        await Promise.all(Array.from({ length: 8 }, worker));
        const written = await applyChannelInfo(results);
        sendResponse({ ok: true, got: Object.keys(results).length, written, rateLimited });
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
        sendResponse({ ok: true });
        break;
      }
      case MSG.UNBLOCK_VIDEO: {
        const state = await removeEntry("video", msg.id);
        await broadcastUpdate(state);
        sendResponse({ ok: true });
        break;
      }
      case MSG.IMPORT_BLOCKLIST: {
        // Merge everything in memory, then ONE bulk write. Calling addEntry per
        // entry (its own loadAll + chrome.storage.sync.set each) melts down on a
        // big import — thousands of sequential sync writes blow the
        // MAX_WRITE_OPERATIONS_PER_MINUTE quota and take minutes.
        const now = syncedNow();
        const state = await loadAll();
        const channels = { ...state.channels };
        const videos = { ...state.videos };
        const clearedTombs = [];

        for (const [id, entry] of Object.entries(msg.channels || {})) {
          if (channels[id]) continue; // already blocked — keep its existing mode/whitelist
          // Preserve mode/whitelist from an exported blocklist — otherwise a
          // re-imported EXCEPT_WHITELIST channel would silently revert to a
          // full block and lose its exceptions.
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
          if (entry.subs) {
            channels[id].subs = String(entry.subs);
            channels[id].subsAt = Number(entry.subsAt) || now;
          }
          if (entry.handle) channels[id].handle = String(entry.handle);
          if (entry.ucid) channels[id].ucid = String(entry.ucid);
          clearedTombs.push("channel:" + id);
        }
        for (const [id, entry] of Object.entries(msg.videos || {})) {
          if (videos[id]) continue;
          videos[id] = { title: entry.title || "", ts: Number(entry.ts) || now, updated_at: now };
          if (entry.hidden) videos[id].hidden = true;
          clearedTombs.push("video:" + id);
        }

        await writeFullState(channels, videos);
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
          channels: Object.keys(fresh.channels).length,
          videos: Object.keys(fresh.videos).length
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
      case MSG.CLEAR_BLOCKED_VIDEOS: {
        const before = await loadAll();
        const ids = Object.keys(before.videos);
        if (ids.length) {
          // one bulk write: keep channels, drop every video
          await writeFullState(before.channels, {});
          const now = syncedNow();
          const tombs = await getTombstones();
          for (const id of ids) tombs["video:" + id] = now;
          await setTombstones(tombs);
          const entries = {};
          for (const id of ids) entries[id] = stripRuntimeEntry(before.videos[id]);
          await pushRecentUnblock({ t: "bulk", kind: "video", entries, count: ids.length });
        }
        const state = await loadAll();
        await broadcastUpdate(state);
        sendResponse({ ok: true, cleared: ids.length });
        break;
      }
      case MSG.GET_RECENT_UNBLOCKS: {
        sendResponse({ ok: true, log: await getRecentUnblocks() });
        break;
      }
      case MSG.RESTORE_UNBLOCK: {
        const state = await restoreRecentUnblock(Number(msg.index));
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
        sendResponse(await self.BlockTube.gistSync.status());
        break;
      }
      case MSG.SET_SYNC_CONFIG: {
        // msg.token: a string to connect/replace, or null/absent to disconnect.
        sendResponse(await self.BlockTube.gistSync.configure(msg.token || null));
        break;
      }
      case MSG.SYNC_NOW: {
        sendResponse(await self.BlockTube.gistSync.syncNow());
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
  self.BlockTube.gistSync.onPoll();
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
    chrome.contextMenus.create({ id: CTX_BLOCK_CHANNEL, title: "BlockTube: block this channel", ...common });
    chrome.contextMenus.create({ id: CTX_BLOCK_VIDEO, title: "BlockTube: block this video", ...common });
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
      if (!videoId) return toast(tabId, "BlockTube: no video in that link.");
      const state = await addEntry("video", videoId, "");
      await broadcastUpdate(state);
      return toast(tabId, "Video blocked.");
    }

    if (info.menuItemId !== CTX_BLOCK_CHANNEL) return;
    // A channel link names the channel outright. A video link doesn't, so fall
    // back to the same oEmbed lookup the /embed/ guard uses.
    let key = channelKey;
    if (!key && videoId) key = await resolveVideoChannel(videoId);
    if (!key) return toast(tabId, "BlockTube: couldn't work out which channel that is.");
    const state = await addEntry("channel", key, "", { mode: CHANNEL_MODE.FULL, whitelist: {} });
    await broadcastUpdate(state);
    // Fills in the real name and the other identity format, as a popup block does.
    enrichChannelIdentity(key);
    toast(tabId, `Blocked ${key}.`);
  });
}

// ---------- cross-browser sync (background/gist-sync.js) ----------
// gist-sync.js never touches blocklist storage itself — it goes through this
// host object. applyMergedState() is the merge's write path: re-chunk, replace
// tombstones, then broadcast with fromSync so it doesn't loop back into a push.
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

self.BlockTube.gistSync.init(syncHost);

// Periodic pull. Alarm registration is top-level and synchronous (MV3-safe);
// the debounced push in gist-sync.js can be lost if the worker sleeps, and
// this is its backstop.
chrome.alarms.create(SYNC.POLL_ALARM, { periodInMinutes: SYNC.POLL_PERIOD_MIN });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === SYNC.POLL_ALARM) self.BlockTube.gistSync.onPoll();
});

// The homepage/Shorts network redirects are toggle-gated in rebuildDnrRules,
// so a settings change has to rebuild the DNR rule set. (content.js watches
// bt_settings itself for its own behaviours.)
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area === "sync" && changes[SETTINGS_KEY]) {
    await rebuildDnrRules(await loadAll());
  }
});
