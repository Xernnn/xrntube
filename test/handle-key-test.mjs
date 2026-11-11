import { readFileSync } from "fs";
import vm from "vm";

// A channel's @handle may hold letters outside ASCII — YouTube takes the
// letters of 75 languages, and the Latin middle dot — and a link carries those
// percent-encoded: /@caf%C3%A9, /@Nguy%E1%BB%85n. Every place that reads a
// channel out of a link, a URL or typed text must take such a handle whole.
// Each stopped at the first such letter instead, and keyed the channel by
// what came before it: @café as @caf, which is somebody else's channel.
//   - a link or path on the page (normalizeChannelKey, shared/block-logic.js)
//   - right-click → block this channel (ctxTargetFrom, background.js)
//   - a video's uploader from oEmbed (resolveVideoChannel, background.js)
//   - what's typed or pasted into the options page (extractChannelKey)
// The key is the encoded form, as the address bar and the import already have
// it, so a handle written out (/@café, as YouTube's JSON may) is the same key.
// An entry stored under a cut key before that is moved to the right one when
// its name says what that is (repairCutHandles(), background.js), and marked
// in the options page when it only looks cut (cutHandleOf(), constants.js).
//
// Pure Node: the shipped functions, lifted or loaded as they are.

const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);
const read = (f) => readFileSync(new URL("../" + f, import.meta.url), "utf8");
const same = (got, want, what) => (got === want ? ok(`${what} -> ${got}`) : fail(`${what}: got ${JSON.stringify(got)}, expected ${JSON.stringify(want)}`));

// shared/constants.js and shared/block-logic.js are pure: load them whole.
const sandbox = { TextEncoder, URL };
sandbox.self = sandbox;
vm.createContext(sandbox);
for (const f of ["shared/constants.js", "shared/block-logic.js"]) vm.runInContext(read(f), sandbox, { filename: f });
const X = sandbox.XrnTube;

const CAFE = "@caf%C3%A9";
const NGUYEN = "@Nguy%E1%BB%85n";

// ---- a link or a path on the page ----
for (const [href, key] of [
  ["/@caf%C3%A9", CAFE],
  ["/@caf%C3%A9/videos", CAFE],
  ["/@café", CAFE],
  ["/@Nguy%E1%BB%85n?si=abc", NGUYEN],
  ["/@Nguyễn", NGUYEN],
  ["/@abc·def", "@abc%C2%B7def"],
  ["/@%E3%81%B2%E3%82%8D", "@%E3%81%B2%E3%82%8D"],
  // …and the handles that always worked are read as they were.
  ["/@mkbhd", "@mkbhd"],
  ["/@Foo.Bar-1_2/videos", "@Foo.Bar-1_2"],
  ["/channel/UCBJycsmduvYEL83R_U4JriQ/videos", "UCBJycsmduvYEL83R_U4JriQ"],
  ["/c/Legacy", null],
  ["/watch?v=ANmTVYkEtLw", null]
]) {
  same(X.normalizeChannelKey(href), key, `page link ${href}`);
}

// A blocked @caf must not answer for @café, nor the other way round.
const index = X.buildBlockIndex({ channels: { "@caf": { name: "Caf", mode: "full" } }, videos: {} });
const reason = X.blockReasonFor({ videoId: "ANmTVYkEtLw", channelKeys: [X.normalizeChannelKey("/@caf%C3%A9")].filter(Boolean) }, index, null);
reason === null
  ? ok("a video by @café is not hidden because @caf is blocked")
  : fail(`a video by @café was hidden for another channel's block: ${reason}`);
const own = X.buildBlockIndex({ channels: { [CAFE]: { name: "Café", mode: "full" } }, videos: {} });
X.blockReasonFor({ videoId: "ANmTVYkEtLw", channelKeys: [X.normalizeChannelKey("/@café")].filter(Boolean) }, own, null)
  ? ok("…and a blocked @café hides its own video, whichever way the link spells it")
  : fail("a blocked @café did not hide its own video");

// ---- right-click → block this channel ----
const bg = read("background/background.js");
const grab = (name) => {
  const m = bg.match(new RegExp(`const ${name} = (/.*?/);\\n`));
  if (!m) throw new Error(`could not find ${name} in background.js`);
  return m[1];
};
const lift = (src, re, what) => {
  const m = src.match(re);
  if (!m) throw new Error(`could not find ${what}`);
  return m[0];
};
const ctxTargetFrom = new Function(
  `const CTX_VIDEO_RE = ${grab("CTX_VIDEO_RE")};
   const CTX_CHANNEL_RE = ${grab("CTX_CHANNEL_RE")};
   ${lift(bg, /function ctxTargetFrom\(info\) \{[\s\S]*?\n\}/, "ctxTargetFrom() in background.js")}
   return ctxTargetFrom;`
)();
same(ctxTargetFrom({ linkUrl: "https://www.youtube.com/@caf%C3%A9/videos" }).channelKey, CAFE, "right-click on a link to @café");
same(ctxTargetFrom({ linkUrl: "https://www.youtube.com/@mkbhd" }).channelKey, "@mkbhd", "right-click on a link to @mkbhd");

// ---- a video's uploader, from oEmbed ----
const resolverFor = (authorUrl) =>
  new Function(
    "fetch",
    "self",
    `const videoChannelCache = new Map();
     const VIDEO_CHANNEL_CACHE_MAX = 500;
     ${lift(bg, /async function resolveVideoChannel\(videoId\) \{[\s\S]*?\n\}/, "resolveVideoChannel() in background.js")}
     return resolveVideoChannel;`
  )(async () => new Response(JSON.stringify({ author_url: authorUrl })), sandbox);
same(await resolverFor("https://www.youtube.com/@caf%C3%A9")("ANmTVYkEtLw"), CAFE, "oEmbed author_url of a video by @café");
same(await resolverFor("https://www.youtube.com/@café")("ANmTVYkEtLw"), CAFE, "…the same, written out");
same(await resolverFor("https://www.youtube.com/@mkbhd")("ANmTVYkEtLw"), "@mkbhd", "oEmbed author_url of a video by @mkbhd");
same(
  await resolverFor("https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ")("ANmTVYkEtLw"),
  "UCBJycsmduvYEL83R_U4JriQ",
  "oEmbed author_url naming a UC id"
);

// ---- typed or pasted into the options page ----
const options = read("options/options.js");
const extractChannelKey = new Function(
  "self",
  `${lift(options, /function extractChannelKey\(text\) \{[\s\S]*?\n\}/, "extractChannelKey() in options.js")}
   return extractChannelKey;`
)(sandbox);
same(extractChannelKey("https://www.youtube.com/@caf%C3%A9"), CAFE.toLowerCase(), "pasted link to @café");
same(extractChannelKey("@café"), CAFE.toLowerCase(), "typed @café");
same(extractChannelKey("@MKBHD"), "@mkbhd", "typed @MKBHD");
same(extractChannelKey("https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ"), "UCBJycsmduvYEL83R_U4JriQ", "pasted /channel/UC… link");

// ---- entries stored under a cut-off handle, before the fix ----
// A version before 2.1.9 stored @café as "@caf". Read whole now, the tile no
// longer gives "@caf", so that entry blocks another channel (or nobody), and
// the one meant shows again. Where the entry's own name is the handle, the
// key it should have had is known and the background moves it there, with
// what the lookup of the wrong channel wrote dropped. Where its name only
// goes on past the key in such a letter, or the key is too short to be a
// handle at all, the options page marks it.
same(X.handleText("@caf%C3%A9"), "@café", "an encoded handle key, as shown");
same(X.handleText("@Nguy%E1%BB%85n"), "@Nguyễn", "…another");
same(X.handleText("@caf%"), "@caf%", "…a key that isn't a whole encoding, as stored");
same(X.handleText("UCBJycsmduvYEL83R_U4JriQ"), "UCBJycsmduvYEL83R_U4JriQ", "…a UC id, as it is");
const cutOf = (key, name) => JSON.stringify(X.cutHandleOf(key, { name, mode: "full" }));
for (const [key, name, want] of [
  ["@caf", "@café", '{"fix":"@caf%C3%A9"}'],
  ["@Nguy", "@Nguyễn", '{"fix":"@Nguy%E1%BB%85n"}'],
  ["@L", "@Lê_Văn", '{"fix":"@L%C3%AA_V%C4%83n"}'],
  ["@Nguy", "Nguyễn Văn A", '{"cut":true}'],
  ["@nguy", "Nguye\u0302\u0303n Văn A", '{"cut":true}'], // the same name, decomposed
  ["@thecaf", "The Café", '{"cut":true}'],
  ["@mrcaf", "Mr. Café", '{"cut":true}'],
  ["@Tr", "", '{"cut":true}'], // under 3 characters: no handle is that short
  // …and nothing about these says so.
  ["@nguyenvana", "Nguyễn Văn A", "null"],
  ["@mkbhd", "Marques Brownlee", "null"],
  ["@caf", "Caf", "null"],
  ["@caf", "", "null"],
  ["@caf%C3%A9", "@café", "null"],
  ["UCBJycsmduvYEL83R_U4JriQ", "Nguyễn", "null"]
]) {
  same(cutOf(key, name), want, `stored as ${key}, named ${JSON.stringify(name)}`);
}

// The background, in Node: the real background.js with chrome.* stubbed.
async function worker(local) {
  const data = structuredClone(local);
  const listeners = {};
  const on = (name) => ({ addListener: (fn) => (listeners[name] = fn) });
  const storage = (d) => ({
    async get(keys) {
      if (keys == null) return structuredClone(d);
      if (typeof keys === "object" && !Array.isArray(keys)) {
        return Object.fromEntries(Object.entries(keys).map(([k, v]) => [k, k in d ? structuredClone(d[k]) : v]));
      }
      return Object.fromEntries([].concat(keys).filter((k) => k in d).map((k) => [k, structuredClone(d[k])]));
    },
    async set(obj) {
      Object.assign(d, structuredClone(obj));
    },
    async remove(keys) {
      for (const k of [].concat(keys)) delete d[k];
    }
  });
  const chrome = {
    storage: { local: storage(data), sync: storage({}), onChanged: on("storage") },
    runtime: {
      id: "xrntube-test",
      onMessage: on("message"),
      onStartup: on("startup"),
      onInstalled: on("installed"),
      onUpdateAvailable: on("update"),
      getManifest: () => ({ version: "0.0.0" }),
      getURL: (p) => "chrome-extension://xrntube-test/" + p,
      reload() {}
    },
    alarms: { create() {}, clear() {}, get: async () => null, onAlarm: on("alarm") },
    tabs: { query: async () => [], sendMessage: async () => {} },
    declarativeNetRequest: { getDynamicRules: async () => [], updateDynamicRules: async () => {} },
    management: { getSelf: async () => ({ installType: "normal" }) }
  };
  const ctx = vm.createContext({
    console: { log() {}, warn() {}, error: console.error, debug() {} },
    setTimeout: () => 0,
    clearTimeout() {},
    structuredClone, TextEncoder, TextDecoder, btoa, atob, crypto, URL,
    Response, Headers, fetch: async () => {
      throw new TypeError("Failed to fetch"); // offline
    },
    chrome,
    addEventListener() {}
  });
  ctx.self = ctx;
  for (const f of ["shared/constants.js", "background/server-sync.js", "background/background.js"]) {
    vm.runInContext(read(f), ctx, { filename: f });
  }
  return { data, listeners };
}

{
  const STRANGER = "UCstrangerxxxxxxxxxxxxx1";
  const blocked = Date.now() - 86400000;
  const w = await worker({
    bt_blocklist: {
      channels: {
        // Blocked from a link that showed the handle; the lookup that followed
        // fetched /@caf and wrote that channel's id and count on it.
        "@caf": { name: "@café", ts: blocked, updated_at: blocked + 5, mode: "exceptWhitelist", whitelist: { ANmTVYkEtLw: "ok" }, ucid: STRANGER, handle: "@caf", subs: "12K", subsAt: blocked + 5, subsV: 2 },
        // The same, but blocked again since under the right key.
        "@Nguy": { name: "@Nguyễn", ts: blocked, updated_at: blocked, mode: "full", whitelist: {} },
        "@nguy%e1%bb%85n": { name: "Nguyễn", ts: blocked + 9, updated_at: blocked + 9, mode: "full", whitelist: {} },
        // Only marked: the rest of its handle isn't known.
        "@Tr": { name: "Trần Văn B", ts: blocked, updated_at: blocked, mode: "full", whitelist: {} },
        "@mkbhd": { name: "Marques Brownlee", ts: blocked, updated_at: blocked, mode: "full", whitelist: {} }
      },
      videos: {}
    }
  });
  await w.listeners.installed();
  const ch = w.data.bt_blocklist.channels;
  const tombs = w.data.bt_tombstones || {};
  const moved = ch["@caf%C3%A9"];
  !ch["@caf"] && tombs["channel:@caf"] > blocked + 5 && moved
    ? ok("an entry whose name is the whole handle moves to the key it should have had, and the cut key is tombstoned for the other devices")
    : fail("not moved: " + JSON.stringify({ keys: Object.keys(ch), tombs }));
  moved && moved.name === "@café" && moved.mode === "exceptWhitelist" && moved.whitelist.ANmTVYkEtLw && moved.ts === blocked && moved.updated_at > blocked + 5
    ? ok("…keeping its name, mode, allowed videos and block date")
    : fail("moved entry: " + JSON.stringify(moved));
  moved && !moved.ucid && !moved.handle && !moved.subs && !moved.subsAt
    ? ok("…without the other channel's UC id, handle and sub count, which the lookup of the cut key wrote")
    : fail("moved entry kept the lookup of the wrong channel: " + JSON.stringify(moved));
  !ch["@Nguy"] && tombs["channel:@Nguy"] && ch["@nguy%e1%bb%85n"] && !ch["@Nguy%E1%BB%85n"]
    ? ok("one blocked again under the right key since is just removed, the new block standing")
    : fail("re-blocked one: " + JSON.stringify({ keys: Object.keys(ch), tombs }));
  ch["@Tr"] && ch["@mkbhd"] && !tombs["channel:@Tr"]
    ? ok("one that is only suspect stays where it is, for the options page to mark")
    : fail("suspect or ordinary entry touched: " + JSON.stringify(Object.keys(ch)));
  const before = JSON.stringify(w.data);
  await w.listeners.startup();
  JSON.stringify(w.data) === before
    ? ok("a start with nothing left to move writes nothing")
    : fail("the next start wrote again");
}

console.log("\nDONE");
