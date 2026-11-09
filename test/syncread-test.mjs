import { readFileSync } from "fs";
import vm from "vm";

// A sync round whose GET /state reply can't be read must change nothing:
//   - a body cut short (the connection dropped mid-download) fails the round
//     with a readable error: no push, and nothing written on this device
//   - so does a damaged document (JSON that doesn't parse)
//   - a whole document still syncs as before
// Reading an unreadable reply as an empty document kept the real ETag, so the
// three-way merge took every keyword and never-block entry for deleted on the
// server and pushed that, with a valid If-Match, to every device.
// Runs background/server-sync.js in node with chrome.storage and fetch stubbed.

const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);

const ROOT = new URL("..", import.meta.url).pathname;
const SOURCES = ["shared/constants.js", "background/server-sync.js"].map((f) => [f, readFileSync(ROOT + f, "utf8")]);

const KEYWORDS = { list: [{ p: "spoiler" }, { p: "^asmr", re: true }], ts: 1 };
const ALLOWLIST = { list: { UCkeep: { note: "", ts: 1 } }, ts: 1 };
const WHOLE = JSON.stringify({ channels: {}, videos: {}, tombstones: {}, keywords: KEYWORDS, allowlist: ALLOWLIST });

function area(data) {
  return {
    data,
    async get(keys) {
      const list = keys == null ? Object.keys(data) : [].concat(keys);
      return Object.fromEntries(list.filter((k) => k in data).map((k) => [k, structuredClone(data[k])]));
    },
    async set(obj) {
      Object.assign(data, structuredClone(obj));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete data[k];
    }
  };
}

// One device that agreed with the server on two keywords and one never-block
// entry at version 6, and a server now at version 7 answering with `reply()`.
async function device(reply) {
  const local = area({});
  const sync = area({ bt_keywords: structuredClone(KEYWORDS), bt_allowlist: structuredClone(ALLOWLIST) });
  const requests = [];
  const fetch = async (url, init = {}) => {
    const method = init.method || "GET";
    requests.push(method);
    if (method === "GET") return reply();
    return new Response("", { status: 200, headers: { etag: '"8"' } });
  };
  const ctx = vm.createContext({
    console, setTimeout, clearTimeout, structuredClone, TextEncoder, TextDecoder, btoa, atob, crypto,
    Response, ReadableStream, Blob, CompressionStream, fetch,
    chrome: { storage: { local, sync } }
  });
  ctx.self = ctx;
  for (const [name, src] of SOURCES) vm.runInContext(src, ctx, { filename: name });
  const s = ctx.XrnTube.serverSync;
  const empty = () => ({ channels: {}, videos: {}, tombstones: {} });
  await s.init({ now: () => Date.now(), setClockOffset() {}, read: async () => empty(), applyMerge: async (merge) => !!merge(empty()) });
  // Connected only now, so init() didn't start a round of its own.
  await local.set({
    bt_sync: { url: "https://example.invalid/xrntube", user: "me", password: "pw", lastVersion: '"6"', agreedFp: "older" },
    bt_sync_base: { kw: { items: ["spoiler", "re:^asmr"] }, allow: ["UCkeep"], settings: null }
  });
  const res = await s.syncNow();
  return { res, requests, sync: sync.data, local: local.data };
}

const kept = (d) =>
  d.sync.bt_keywords && d.sync.bt_keywords.list.length === 2 && d.sync.bt_allowlist && "UCkeep" in d.sync.bt_allowlist.list;

{
  const enc = new TextEncoder().encode(WHOLE.slice(0, 40));
  const d = await device(
    () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(enc);
            c.error(new TypeError("network error"));
          }
        }),
        { status: 200, headers: { etag: '"7"', "content-type": "application/json" } }
      )
  );
  !d.res.ok && !d.requests.includes("PUT") && kept(d) && d.local.bt_sync.lastVersion === '"6"'
    ? ok(`a reply cut off mid-download fails the round (${d.res.error}), pushes nothing and keeps the keywords and never-block list`)
    : fail("a reply cut off mid-download: " + JSON.stringify({ res: d.res, requests: d.requests, sync: d.sync }));
}

{
  const d = await device(() => new Response(WHOLE.slice(0, 40), { status: 200, headers: { etag: '"7"' } }));
  !d.res.ok && !d.requests.includes("PUT") && kept(d)
    ? ok("a damaged document fails the round the same way")
    : fail("a damaged document: " + JSON.stringify({ res: d.res, requests: d.requests, sync: d.sync }));
}

{
  const d = await device(() => new Response(WHOLE, { status: 200, headers: { etag: '"7"' } }));
  d.res.ok && kept(d)
    ? ok("a whole document syncs as before, keywords and never-block list intact")
    : fail("a whole document: " + JSON.stringify({ res: d.res, requests: d.requests, sync: d.sync }));
}
