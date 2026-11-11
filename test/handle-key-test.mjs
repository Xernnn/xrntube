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

console.log("\nDONE");
