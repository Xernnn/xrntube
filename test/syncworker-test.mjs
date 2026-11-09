import { readFileSync } from "fs";
import vm from "vm";

// The worker's side of sync, in node: the real background.js and
// server-sync.js with chrome.* stubbed and the sync server faked, so a test
// can pause a download and act while it is under way.
//   - a block, an unblock and a keyword added while the list downloads all
//     survive the round, and reach the server with it
//   - a list the browser won't store (chrome.storage.sync's 8 KB an item)
//     fails the round before anything is sent, so the next round doesn't read
//     what's missing here as deleted; and a bulk never-block, an import or a
//     restore that won't fit says so instead of reporting it done
//   - reconnecting to the same server and user (a new password after a 401)
//     keeps the merge base, so deletions made elsewhere stay deleted; another
//     server, or one that was reset, still merges as a first sync
// The real server and two browsers are serversync-test's; syncread-test has
// the reply that can't be read.

const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);

const ROOT = new URL("..", import.meta.url).pathname;
const SOURCES = ["shared/constants.js", "background/server-sync.js", "background/background.js"].map((f) => [
  f,
  readFileSync(ROOT + f, "utf8")
]);
const ORIGIN = "https://sync.example";
const URL_ = ORIGIN + "/xrntube";

// A chrome.storage area: get in all three shapes, onChanged like the browser's.
// `perItem` refuses a set with an item over that many bytes (the key plus the
// value as JSON), whole, as Chrome's storage.sync does at 8192.
function area(name, data, onChanged, perItem = 0) {
  return {
    data,
    async get(keys) {
      if (keys == null) return structuredClone(data);
      if (typeof keys === "object" && !Array.isArray(keys)) {
        return Object.fromEntries(Object.entries(keys).map(([k, d]) => [k, k in data ? structuredClone(data[k]) : d]));
      }
      return Object.fromEntries([].concat(keys).filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(obj) {
      const enc = new TextEncoder();
      if (perItem && Object.entries(obj).some(([k, v]) => enc.encode(k + JSON.stringify(v)).length > perItem)) {
        throw new Error("QUOTA_BYTES_PER_ITEM quota exceeded");
      }
      const changes = {};
      for (const [k, v] of Object.entries(obj)) {
        changes[k] = { oldValue: data[k], newValue: structuredClone(v) };
        data[k] = structuredClone(v);
      }
      for (const fn of onChanged) fn(changes, name);
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    }
  };
}

// The sync server: one document, versioned, behind one login. pause() holds
// the next GET /state until release().
function server({ doc = {}, version = 1, user = "me", password = "pw" } = {}) {
  const s = { doc: structuredClone(doc), version, puts: [], gate: null };
  s.pause = () => {
    let arrived;
    let release;
    const hold = { arrived: new Promise((r) => (arrived = r)) };
    s.gate = { arrived, wait: new Promise((r) => (release = r)) };
    hold.release = () => {
      s.gate = null;
      release();
    };
    return hold;
  };
  s.handle = async (u, init) => {
    const method = init.method || "GET";
    const path = u.pathname.replace(/^\/xrntube/, "");
    const headers = init.headers || {};
    if (headers.Authorization !== "Basic " + Buffer.from(`${user}:${password}`).toString("base64")) {
      return new Response("login required", { status: 401 });
    }
    const etag = { etag: `"${s.version}"` };
    if (method === "GET" && path === "/state") {
      if (s.gate) {
        const g = s.gate;
        g.arrived();
        await g.wait;
      }
      if (u.searchParams.get("since") === String(s.version)) return new Response(null, { status: 304, headers: etag });
      return new Response(JSON.stringify(s.doc), { status: 200, headers: etag });
    }
    if (method === "PUT" && path === "/state") {
      const want = String(headers["If-Match"] || "");
      if (want !== "*" && want.replace(/"/g, "") !== String(s.version)) return new Response("changed", { status: 412, headers: etag });
      let body = init.body;
      if (headers["Content-Encoding"] === "gzip") {
        body = await new Response(body.stream().pipeThrough(new DecompressionStream("gzip"))).text();
      }
      s.doc = JSON.parse(body);
      s.version++;
      s.puts.push(structuredClone(s.doc));
      return new Response('{"ok":true}', { status: 200, headers: { etag: `"${s.version}"` } });
    }
    return new Response("not found", { status: 404 });
  };
  return s;
}

// One device: the worker's scripts in a fresh context. Timers are recorded and
// never fire, so the debounced push after an edit doesn't start rounds of its
// own; each test runs its rounds with SYNC_NOW.
async function boot({ local = {}, sync = {}, servers = {} } = {}) {
  const onChanged = [];
  const stores = {
    local: area("local", structuredClone(local), onChanged),
    sync: area("sync", structuredClone(sync), onChanged, 8192)
  };
  const requests = [];
  const fetch = async (url, init = {}) => {
    const u = new URL(String(url));
    requests.push({ url: u.href, method: init.method || "GET", auth: (init.headers || {}).Authorization || null });
    const s = servers[u.origin];
    if (!s) throw new TypeError("Failed to fetch"); // YouTube and anything else: offline
    return s.handle(u, init);
  };
  let onMessage = null;
  const noop = { addListener() {} };
  const chrome = {
    storage: { local: stores.local, sync: stores.sync, onChanged: { addListener: (fn) => onChanged.push(fn) } },
    runtime: {
      id: "xrntube-test",
      onMessage: { addListener: (fn) => (onMessage = fn) },
      onStartup: noop,
      onInstalled: noop,
      onUpdateAvailable: noop,
      getManifest: () => ({ version: "0.0.0" }),
      getURL: (p) => "chrome-extension://xrntube-test/" + p,
      reload() {}
    },
    alarms: { create() {}, clear() {}, get: async () => null, onAlarm: noop },
    tabs: { query: async () => [], sendMessage: async () => {} },
    declarativeNetRequest: { getDynamicRules: async () => [], updateDynamicRules: async () => {} },
    management: { getSelf: async () => ({ installType: "normal" }) }
  };
  const timers = new Set();
  const ctx = vm.createContext({
    console: { log: console.log, warn() {}, error: console.error, debug() {} },
    setTimeout: (fn, ms) => {
      const t = { fn, ms };
      timers.add(t);
      return t;
    },
    clearTimeout: (t) => timers.delete(t),
    structuredClone, TextEncoder, TextDecoder, btoa, atob, crypto, URL,
    Response, Headers, ReadableStream, Blob, CompressionStream, fetch, chrome,
    addEventListener() {}
  });
  ctx.self = ctx;
  for (const [name, src] of SOURCES) vm.runInContext(src, ctx, { filename: name });
  const send = (msg) => new Promise((resolve) => onMessage(msg, {}, resolve));
  await send({ type: "GET_SYNC_STATUS" }); // init() has read its (empty) config by now
  return { chrome, send, local: stores.local.data, sync: stores.sync.data, requests };
}

// Connected and agreed with the server at version 6 on `base`; set straight
// into storage, as a device that synced before would have it.
const connect = (d, { base = null, sync = {} } = {}) =>
  d.chrome.storage.local.set({
    bt_sync: { url: URL_, user: "me", password: "pw", lastVersion: '"6"', agreedFp: "older", ...sync },
    ...(base ? { bt_sync_base: base } : {})
  });

const entry = (name, at) => ({ name, ts: at, updated_at: at, mode: "full", whitelist: {} });
const kwIds = (k) => ((k && k.list) || []).map((x) => x.p).sort().join(",");

// ---- 1. what happens here while the list downloads stays ----
// The round read the store and the keywords before the download and wrote its
// merge back over them after: a block made meanwhile vanished (after its
// toast), an unblock made meanwhile came back, and so did a keyword.
{
  const OLD = entry("Old", 1000);
  const srv = server({
    version: 7,
    doc: {
      channels: { "@old": OLD, "@remote": entry("Remote", 2000) },
      videos: {},
      tombstones: {},
      keywords: { list: [{ p: "from-remote" }, { p: "kept" }], ts: 2000 },
      allowlist: { list: {}, ts: 0 }
    }
  });
  const d = await boot({
    servers: { [ORIGIN]: srv },
    local: { bt_blocklist: { channels: { "@old": OLD }, videos: {} } },
    sync: { bt_keywords: { list: [{ p: "kept" }], ts: 1000 } }
  });
  await connect(d, { base: { kw: { items: ["kept"] }, allow: [], settings: null } });

  const hold = srv.pause();
  const round = d.send({ type: "SYNC_NOW" });
  await hold.arrived;
  await d.send({ type: "BLOCK_CHANNEL", id: "@during", name: "During" });
  await d.send({ type: "UNBLOCK_CHANNEL", id: "@old" });
  // The options page writes keywords to storage itself.
  await d.chrome.storage.sync.set({ bt_keywords: { list: [{ p: "added-meanwhile" }, { p: "kept" }], ts: 3000 } });
  hold.release();
  const res = await round;

  const ch = d.local.bt_blocklist.channels;
  const tombs = d.local.bt_tombstones || {};
  ch["@during"] && !ch["@old"] && ch["@remote"] && tombs["channel:@old"] && !tombs["channel:@during"]
    ? ok("a block and an unblock made while the list downloaded both stand after the round (with the other device's block merged in)")
    : fail("edits during the download: " + JSON.stringify({ res, channels: Object.keys(ch), tombs }));
  kwIds(d.sync.bt_keywords) === "added-meanwhile,from-remote,kept"
    ? ok("…and so does a keyword added meanwhile")
    : fail("keyword added during the download: " + kwIds(d.sync.bt_keywords));
  const pushed = srv.doc;
  res.ok && pushed.channels["@during"] && !pushed.channels["@old"] && pushed.tombstones["channel:@old"] && kwIds(pushed.keywords) === "added-meanwhile,from-remote,kept"
    ? ok("the round's push carries all three to the server")
    : fail("what the round pushed: " + JSON.stringify({ res, channels: Object.keys(pushed.channels || {}), tombstones: pushed.tombstones, keywords: pushed.keywords }));
  const puts = srv.puts.length;
  const again = await d.send({ type: "SYNC_NOW" });
  again.ok && again.notModified && srv.puts.length === puts
    ? ok("the next round finds both sides agreeing: a 304, and nothing to push")
    : fail("the round after: " + JSON.stringify({ again, puts: srv.puts.length - puts }));
}

// ---- 2. a list too big for synced storage ----
// chrome.storage.sync holds 8 KB an item, and the never-block list is one
// item: about 150 channels. The write was swallowed, and everything after it
// carried on as if it had worked.
const uc = (i) => "UC" + String(i).padStart(22, "x");
// As setAllowed() stores them: ~58 bytes each, so 150 are over 8 KB and 100 are not.
const allowOf = (from, n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [uc(from + i), { note: "", ts: 1762790400000 }]));
const size = (a) => Object.keys((a && a.list) || {}).length;

// A bulk "Never block" of 200 rows answered ok and saved nothing.
{
  const d = await boot({ sync: { bt_allowlist: { list: allowOf(0, 1), ts: 1000 } } });
  const res = await d.send({ type: "ALLOW_CHANNEL", ids: Array.from({ length: 200 }, (_, i) => uc(1000 + i)) });
  res.ok === false && /never-block list would be too big/.test(res.error || "") && size(d.sync.bt_allowlist) === 1
    ? ok(`a bulk never-block of 200 channels is refused, saying why ("${res.error}"), and the list is as it was`)
    : fail("bulk never-block over the quota: " + JSON.stringify({ res, size: size(d.sync.bt_allowlist) }));
}

// This device agreed 60 never-block entries with the server; another device
// has since added 90. The two together don't fit here. The round stored
// nothing but pushed the merge and kept it as the base, and the next one read
// the 90 as deleted on this device and deleted them everywhere.
{
  const mine = allowOf(0, 60);
  const srv = server({ version: 7, doc: { channels: {}, videos: {}, tombstones: {}, allowlist: { list: { ...mine, ...allowOf(500, 90) }, ts: 2000 } } });
  const d = await boot({ servers: { [ORIGIN]: srv }, sync: { bt_allowlist: { list: mine, ts: 1000 } } });
  await connect(d, { base: { kw: { items: [] }, allow: Object.keys(mine), settings: null } });
  const first = await d.send({ type: "SYNC_NOW" });
  const second = await d.send({ type: "SYNC_NOW" });
  !first.ok && /never-block list won't fit/.test(first.error || "") && /Nothing was changed or sent/.test(first.error)
    ? ok(`a round whose merge won't fit in synced storage fails, saying so: "${first.error}"`)
    : fail("round over the quota: " + JSON.stringify(first));
  !second.ok && srv.puts.length === 0 && size(srv.doc.allowlist) === 150 && d.local.bt_sync_base.allow.length === 60 && size(d.sync.bt_allowlist) === 60
    ? ok("…pushes nothing and keeps its old base, so the round after it doesn't delete the other device's 90 entries from the server")
    : fail("after two rounds over the quota: " + JSON.stringify({ second, puts: srv.puts.map((p) => size(p.allowlist)), server: size(srv.doc.allowlist), base: (d.local.bt_sync_base || {}).allow?.length }));
}

// A backup's never-block list that won't fit doesn't stop its channels.
{
  const d = await boot({ sync: { bt_allowlist: { list: allowOf(0, 100), ts: 1000 } } });
  const res = await d.send({ type: "IMPORT_BLOCKLIST", channels: { "@imported": { name: "Imported" } }, videos: {}, allowlist: allowOf(300, 100) });
  res.ok && res.added.channels === 1 && res.allowAdded === 0 && /never-block list would be too big/.test(res.allowError || "") && size(d.sync.bt_allowlist) === 100
    ? ok("an import whose never-block list won't fit brings the channels in and says the never-block list wasn't added")
    : fail("import over the quota: " + JSON.stringify({ res, size: size(d.sync.bt_allowlist) }));
}

// Restoring a cleared never-block list onto one that has grown since.
{
  const d = await boot({ sync: { bt_allowlist: { list: allowOf(0, 100), ts: 1000 } } });
  const cleared = await d.send({ type: "DELETE_DATA", allowlist: true });
  await d.send({ type: "ALLOW_CHANNEL", ids: Object.keys(allowOf(700, 60)) });
  const res = await d.send({ type: "RESTORE_UNBLOCK", ts: cleared.undoTs });
  const kept = (await d.send({ type: "GET_RECENT_UNBLOCKS" })).log.some((r) => r.ts === cleared.undoTs);
  await d.send({ type: "DISALLOW_CHANNEL", ids: Object.keys(allowOf(700, 60)) });
  const retry = await d.send({ type: "RESTORE_UNBLOCK", ts: cleared.undoTs });
  res.ok === false && /never-block list would be too big/.test(res.error || "") && kept && retry.ok && size(d.sync.bt_allowlist) === 100
    ? ok("a restore that won't fit says so and keeps its undo record, which restores once there's room")
    : fail("restore over the quota: " + JSON.stringify({ res, kept, retry, size: size(d.sync.bt_allowlist) }));
}

// ---- 3. reconnecting ----
// Agreed on keywords a and b at version 6; another device has since deleted
// b. Then the password changes: rounds get 401 until it's typed again.
// configure() dropped the base on every connect, so the round after the new
// password was a first sync — a union — and b came back, on every device.
const kwRecords = (list) => ({ channels: {}, videos: {}, tombstones: {}, keywords: { list: list.map((p) => ({ p })), ts: 2000 }, allowlist: { list: {}, ts: 0 } });
const agreedAB = { base: { kw: { items: ["a", "b"] }, allow: [], settings: null } };
{
  const srv = server({ version: 7, password: "new-pw", doc: kwRecords(["a"]) });
  const d = await boot({ servers: { [ORIGIN]: srv }, sync: { bt_keywords: { list: [{ p: "a" }, { p: "b" }], ts: 1000 } } });
  await connect(d, agreedAB);
  const refused = await d.send({ type: "SYNC_NOW" });
  const res = await d.send({ type: "SET_SYNC_CONFIG", conn: { url: URL_ + "/", user: "me", password: "new-pw" } });
  refused.status === 401 && res.ok && kwIds(d.sync.bt_keywords) === "a" && kwIds(srv.doc.keywords) === "a"
    ? ok("a new password for the same server and user keeps the base: a keyword deleted on another device stays deleted, here and on the server")
    : fail("reconnect to the same server: " + JSON.stringify({ refused, res, here: kwIds(d.sync.bt_keywords), server: kwIds(srv.doc.keywords) }));
}
// The base belongs to the copy it was agreed with: another server, or the
// same one reset (its version went backwards), merges as a first sync.
{
  const other = server({ version: 3, doc: kwRecords(["a"]) });
  const d = await boot({ servers: { "https://other.example": other }, sync: { bt_keywords: { list: [{ p: "a" }, { p: "b" }], ts: 1000 } } });
  await connect(d, agreedAB);
  const res = await d.send({ type: "SET_SYNC_CONFIG", conn: { url: "https://other.example/xrntube", user: "me", password: "pw" } });
  const reset = server({ version: 2, doc: kwRecords(["a"]) });
  const d2 = await boot({ servers: { [ORIGIN]: reset }, sync: { bt_keywords: { list: [{ p: "a" }, { p: "b" }], ts: 1000 } } });
  await connect(d2, agreedAB);
  const res2 = await d2.send({ type: "SET_SYNC_CONFIG", conn: { url: URL_, user: "me", password: "pw" } });
  res.ok && kwIds(other.doc.keywords) === "a,b" && res2.ok && kwIds(reset.doc.keywords) === "a,b"
    ? ok("…while another server, or the same one reset to an older version, takes this device's keywords as a first sync does")
    : fail("first-sync merges: " + JSON.stringify({ res, other: kwIds(other.doc.keywords), res2, reset: kwIds(reset.doc.keywords) }));
}

console.log("\nDONE");
