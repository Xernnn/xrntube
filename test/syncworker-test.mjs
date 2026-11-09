import { readFileSync } from "fs";
import vm from "vm";

// The worker's side of sync, in node: the real background.js and
// server-sync.js with chrome.* stubbed and the sync server faked, so a test
// can pause a download and act while it is under way.
//   - a block, an unblock and a keyword added while the list downloads all
//     survive the round, and reach the server with it
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
function area(name, data, onChanged) {
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
  const stores = { local: area("local", structuredClone(local), onChanged), sync: area("sync", structuredClone(sync), onChanged) };
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

console.log("\nDONE");
