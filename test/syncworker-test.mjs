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
//   - the saved password goes only to the server and user it was saved for,
//     and only over https (plain http just to this machine)
//   - the server's clock is taken over the device's when they differ by more
//     than a little, and doesn't wobble with each reply; and a change is
//     never stamped before what it supersedes, so an unblock or a block made
//     after the clock moved back still wins
//   - a switch only a newer version knows rides through this one's merge:
//     not stripped, and no push over it
//   - pointing sync elsewhere, the server's history, deleting and importing
//     are taken from the extension's own pages only, not from a YouTube tab's
//     content script
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
// the next GET /state until release(). With `skew` (ms) set, every reply has a
// Date header that far off this machine's clock, as a real server's would.
function server({ doc = {}, version = 1, user = "me", password = "pw" } = {}) {
  const s = { doc: structuredClone(doc), version, puts: [], gate: null, skew: null };
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
    const res = await answer(u, init);
    if (s.skew !== null) res.headers.set("date", new Date(Date.now() + s.skew).toUTCString());
    return res;
  };
  const answer = async (u, init) => {
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
  // As the browser fills in `sender`: the options page, or a YouTube tab's content script.
  const OPTIONS_PAGE = { id: "xrntube-test", url: "chrome-extension://xrntube-test/options/options.html" };
  const YOUTUBE_TAB = { id: "xrntube-test", url: "https://www.youtube.com/watch?v=ANmTVYkEtLw", tab: { id: 7 }, frameId: 0, origin: "https://www.youtube.com" };
  const send = (msg) => new Promise((resolve) => onMessage(msg, OPTIONS_PAGE, resolve));
  const sendFromTab = (msg) => new Promise((resolve) => onMessage(msg, YOUTUBE_TAB, resolve));
  await send({ type: "GET_SYNC_STATUS" }); // init() has read its (empty) config by now
  return { chrome, send, sendFromTab, X: ctx.XrnTube, local: stores.local.data, sync: stores.sync.data, requests };
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

// ---- 4. where the saved password may go ----
// It is the server login, which is also the calendar's. With the password box
// left empty, Reconnect sent the saved one to whatever address was typed, and
// took http:// too, which shows it to the network.
{
  const srv = server({ version: 7, doc: kwRecords(["a"]) });
  const local = { 5233: server({ doc: kwRecords(["a"]) }) };
  const d = await boot({
    servers: { [ORIGIN]: srv, "http://127.0.0.1:5233": local[5233], "http://localhost:5233": local[5233] },
    sync: { bt_keywords: { list: [{ p: "a" }], ts: 1000 } }
  });
  await connect(d, agreedAB);
  const elsewhere = await d.send({ type: "SET_SYNC_CONFIG", conn: { url: "https://elsewhere.example/xrntube", user: "me" } });
  const otherUser = await d.send({ type: "SET_SYNC_CONFIG", conn: { url: URL_, user: "someone" } });
  const plain = await d.send({ type: "SET_SYNC_CONFIG", conn: { url: "http://192.168.1.5:5233/xrntube", user: "me", password: "pw" } });
  const after = d.local.bt_sync;
  !elsewhere.ok && /password/.test(elsewhere.error || "") && !otherUser.ok && !plain.ok && /https/.test(plain.error || "") &&
  !d.requests.length && after.url === URL_ && after.user === "me" && after.password === "pw" && d.local.bt_sync_base
    ? ok("no password typed, another address or user is refused; http:// to another machine is refused even with one — nothing is sent, and the connection stands")
    : fail("refusals: " + JSON.stringify({ elsewhere, otherUser, plain, requests: d.requests, url: after.url, user: after.user }));

  const same = await d.send({ type: "SET_SYNC_CONFIG", conn: { url: URL_ + "/", user: "me" } });
  same.ok && d.requests.length && d.requests.every((r) => r.url.startsWith(URL_ + "/") && r.auth)
    ? ok("the same address and user with the box left empty reconnects with the saved password")
    : fail("reconnect with the saved password: " + JSON.stringify({ same, requests: d.requests }));

  d.requests.length = 0;
  const loop = await d.send({ type: "SET_SYNC_CONFIG", conn: { url: "http://127.0.0.1:5233/xrntube", user: "me", password: "pw" } });
  const named = await d.send({ type: "SET_SYNC_CONFIG", conn: { url: "http://localhost:5233/xrntube", user: "me", password: "pw" } });
  loop.ok && named.ok && d.requests.length >= 2
    ? ok("plain http:// to 127.0.0.1 or localhost connects (a server on this machine)")
    : fail("http to this machine: " + JSON.stringify({ loop, named, requests: d.requests }));
}
// Saved before this check existed: the round refuses to send the password.
{
  const lan = server({ doc: kwRecords(["a"]) });
  const d = await boot({ servers: { "http://192.168.1.5:5233": lan } });
  await connect(d, { sync: { url: "http://192.168.1.5:5233/xrntube" } });
  const res = await d.send({ type: "SYNC_NOW" });
  !res.ok && /https/.test(res.error || "") && !d.requests.length
    ? ok(`a connection saved with http:// to another machine sends nothing: "${res.error}"`)
    : fail("saved http connection: " + JSON.stringify({ res, requests: d.requests }));
}

// ---- 5. whose clock ----
// The offset was read afresh off every reply's Date header, which is in whole
// seconds, so it wobbled by up to a second from one request to the next.
{
  const srv = server({ version: 7, doc: kwRecords(["a"]) });
  const d = await boot({ servers: { [ORIGIN]: srv } });
  await connect(d);
  const offset = () => d.local.bt_sync.clockOffset;
  srv.skew = 700;
  await d.send({ type: "SYNC_NOW" });
  const near = offset();
  srv.skew = 3600e3;
  await d.send({ type: "SYNC_NOW" });
  const far = offset();
  srv.skew = 3600e3 + 900;
  await d.send({ type: "SYNC_NOW" });
  await d.send({ type: "SYNC_NOW" });
  const steady = offset();
  await d.send({ type: "BLOCK_CHANNEL", id: "@stamped", name: "Stamped" });
  const at = d.local.bt_blocklist.channels["@stamped"].updated_at;
  near === 0 && Math.abs(far - 3600e3) < 1500 && steady === far && Math.abs(at - (Date.now() + far)) < 2000
    ? ok(`a server clock 0.7 s off is left alone; one an hour off is taken (offset ${Math.round(far / 1000)} s) and held through a reply 0.9 s further off, and blocks are stamped by it`)
    : fail("clock offset: " + JSON.stringify({ near, far, steady, stampedFromNow: at - Date.now() }));
}

// An entry stamped an hour ahead: this device's clock ran fast when it was
// blocked, and has since been put right (or the server's clock taken over).
// Unblocking it now stamped the tombstone an hour before the entry, the
// entry won the next merge, and the unblock came undone; a block over a
// tombstone stamped ahead was undone the same way.
{
  const ahead = Date.now() + 3600e3;
  const srv = server({
    version: 7,
    doc: { channels: { "@fast": entry("Fast", ahead) }, videos: {}, tombstones: { "channel:@gone": ahead }, allowlist: { list: {}, ts: 0 } }
  });
  const d = await boot({
    servers: { [ORIGIN]: srv },
    local: { bt_blocklist: { channels: { "@fast": entry("Fast", ahead) }, videos: {} }, bt_tombstones: { "channel:@gone": ahead } }
  });
  await connect(d);
  await d.send({ type: "UNBLOCK_CHANNEL", id: "@fast" });
  await d.send({ type: "BLOCK_CHANNEL", id: "@gone", name: "Back" });
  const res = await d.send({ type: "SYNC_NOW" });
  const ch = d.local.bt_blocklist.channels;
  res.ok && !ch["@fast"] && ch["@gone"] && !srv.doc.channels["@fast"] && srv.doc.channels["@gone"]
    ? ok("an unblock of an entry stamped ahead, and a block over a tombstone stamped ahead, both stand after a sync, here and on the server")
    : fail("stamps after a clock moved back: " + JSON.stringify({ res, here: Object.keys(ch), server: Object.keys(srv.doc.channels || {}) }));
}

// ---- 6. a switch this version doesn't know ----
// A newer version adds a switch and pushes it. resolveSettings() keeps only
// the switches this version knows, so the merge left the new one out, found
// the server's copy different, and pushed it stripped; the newer device put it
// back, and the two pushed the whole list at each other every few minutes.
{
  const srv = server({ version: 7 });
  const d = await boot({ servers: { [ORIGIN]: srv } });
  const defaults = d.X.resolveSettings({});
  const newer = { ...defaults, futureSwitch: false };
  srv.doc = { channels: {}, videos: {}, tombstones: {}, keywords: { list: [], ts: 0 }, allowlist: { list: {}, ts: 0 }, settings: newer };
  await d.chrome.storage.sync.set({ bt_settings: defaults });
  await connect(d, { base: { kw: { items: [] }, allow: [], settings: defaults } });
  const first = await d.send({ type: "SYNC_NOW" });
  const quiet = srv.puts.length === 0 && srv.doc.settings.futureSwitch === false;
  // This version's options page writes the switches it knows, and only those.
  await d.chrome.storage.sync.set({ bt_settings: { ...defaults, actionClip: false } });
  await d.send({ type: "SYNC_NOW" });
  const carried = srv.doc.settings;
  await d.send({ type: "SYNC_NOW" });
  first.ok && quiet && srv.puts.length === 1 && carried.futureSwitch === false && carried.actionClip === false
    ? ok("a newer version's switch rides through: no push over it, and a push for this device's own switch carries it along")
    : fail("unknown switch: " + JSON.stringify({ first, quiet, puts: srv.puts.length, futureSwitch: carried && carried.futureSwitch, actionClip: carried && carried.actionClip }));

  // A first sync takes the server's switches whole, the newer one included.
  srv.doc.settings = { ...newer };
  const d2 = await boot({ servers: { [ORIGIN]: srv } });
  await connect(d2);
  const puts = srv.puts.length;
  const res = await d2.send({ type: "SYNC_NOW" });
  res.ok && srv.puts.length === puts && d2.sync.bt_settings && d2.sync.bt_settings.futureSwitch === false
    ? ok("…and a device's first sync keeps it too, with nothing to push")
    : fail("unknown switch, first sync: " + JSON.stringify({ res, puts: srv.puts.length - puts, settings: d2.sync.bt_settings }));
}

// ---- 7. what a YouTube tab may ask for ----
// Nothing checked who sent a message, so a content script, which lives in
// YouTube's renderer, could do anything the options page does: point sync at
// another server (and send it the list, and take that server's in its
// place), read the server's earlier copies, delete everything, import.
{
  const srv = server({ version: 7, doc: { channels: {}, videos: {}, tombstones: {} } });
  const evil = server({ version: 1, user: "them", password: "theirs" });
  const d = await boot({
    servers: { [ORIGIN]: srv, "https://evil.example": evil },
    local: { bt_blocklist: { channels: { "@kept": entry("Kept", 1000) }, videos: { aaaaaaaaaaa: { title: "v", ts: 1000, updated_at: 1000 } } } }
  });
  await connect(d);
  const before = JSON.stringify({ sync: d.local.bt_sync, list: d.local.bt_blocklist });
  const refused = [];
  for (const m of [
    { type: "SET_SYNC_CONFIG", conn: { url: "https://evil.example/xrntube", user: "them", password: "theirs" } },
    { type: "SET_SYNC_CONFIG", conn: null },
    { type: "SYNC_HISTORY" },
    { type: "SYNC_HISTORY_GET", name: "x" },
    { type: "DELETE_DATA", channels: "all", videos: "all", keywords: true, allowlist: true },
    { type: "IMPORT_BLOCKLIST", channels: { "@planted": { name: "Planted" } }, videos: {} }
  ]) {
    const res = await d.sendFromTab(m);
    if (res && res.ok === false && /extension's own pages/.test(res.error || "")) refused.push(m.type);
  }
  const after = JSON.stringify({ sync: d.local.bt_sync, list: d.local.bt_blocklist });
  refused.length === 6 && after === before && !d.requests.some((r) => r.url.startsWith("https://evil.example"))
    ? ok("from a YouTube tab, repointing or turning off sync, the server's history, deleting and importing are all refused, and nothing changes")
    : fail("from a YouTube tab: " + JSON.stringify({ refused, changed: after !== before, evil: d.requests.filter((r) => r.url.startsWith("https://evil.example")).length }));
  const blocked = await d.sendFromTab({ type: "BLOCK_CHANNEL", id: "@fromtile", name: "From a tile" });
  const deleted = await d.send({ type: "DELETE_DATA", channels: ["@kept"] });
  blocked.ok && d.local.bt_blocklist.channels["@fromtile"] && deleted.ok && !d.local.bt_blocklist.channels["@kept"]
    ? ok("…while a tile's block still works from the tab, and the options page still deletes")
    : fail("allowed messages: " + JSON.stringify({ blocked, deleted, channels: Object.keys(d.local.bt_blocklist.channels) }));
}

console.log("\nDONE");
