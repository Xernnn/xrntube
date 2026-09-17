// Where the subscriber count comes from.
//
// Pure Node: the scrape is plain fetch + regex, so it is lifted straight out
// of background.js and run here — no browser needed. It does hit live
// YouTube, because the thing that breaks is YouTube's markup.
//
// The bug this guards: a channel page embeds shelves of *other people's*
// videos and channel cards, each carrying its own "subscriberCountText", and
// the channel's own header sits at the very end of a ~2.5MB document. Reading
// the first count in the page therefore reported a stranger's number
// (@mkbhd came back as "1.15M", @NASA as "62.9K") and on a big channel the
// reader stopped before reaching anything at all, so ~37% of channels got no
// count. Both failures looked identical from the options page: a blank chip.
//
// Numbers drift, so nothing here hard-codes one. What is asserted instead is
// that the answer is *self-consistent* — the same channel reached by its
// @handle and by its UC id must report the same count — and that the parser
// refuses a count that isn't in the channel's own header.

import fs from "node:fs";

const bg = fs.readFileSync(new URL("../background/background.js", import.meta.url), "utf8");
const region = bg.slice(
  bg.indexOf("// ---------- scrape a channel's public page"),
  bg.indexOf("// Which channel does this video belong to?")
);
const { scrapeChannelInfo, parseChannelHtml } = new Function(
  region + "\nreturn { scrapeChannelInfo, parseChannelHtml };"
)();

const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);

// ---- the parser only trusts the channel's own header ----
// A stranger's card first, the page's own header second: the old parser took
// the first one it saw.
const STRANGER = '"subscriberCountText":{"simpleText":"986K subscribers"},"canonicalBaseUrl":"/@someoneelse"';
const OWN =
  '"pageHeaderRenderer":{"pageTitle":"Real Channel","content":{"pageHeaderViewModel":{' +
  '"metadataRows":[{"metadataParts":[{"text":{"content":"@realchannel"}}]},' +
  '{"metadataParts":[{"text":{"content":"21.3M subscribers"},"accessibilityLabel":"21.3 million subscribers"},' +
  '{"text":{"content":"1.8K videos"}}]}],"delimiter":"•"}}}';
const mixed = parseChannelHtml("x".repeat(5000) + STRANGER + "y".repeat(5000) + OWN);
mixed.subs === "21.3M"
  ? ok("the count comes from the page's own header, not an embedded card")
  : fail(`read "${mixed.subs}" — expected 21.3M from the header`);
mixed.handle === "@realchannel" && mixed.name === "Real Channel"
  ? ok("handle and name come from the same header")
  : fail(`handle=${mixed.handle} name=${mixed.name}`);

// A channel that hides its count has a header but no subscribers part. That is
// an answer, not a failure — it must not read as "never fetched".
const hidden = parseChannelHtml(
  '"pageHeaderRenderer":{"pageTitle":"Quiet","content":{"pageHeaderViewModel":{' +
    '"metadataRows":[{"metadataParts":[{"text":{"content":"@quiet"}}]},' +
    '{"metadataParts":[{"text":{"content":"12 videos"}}]}],"delimiter":"•"}}}'
);
hidden.subs === "hidden"
  ? ok('a channel with no subscriber row reads as "hidden", not as missing')
  : fail(`hidden-count channel parsed as ${JSON.stringify(hidden.subs)}`);

// A UI language the extension has no idea about: the row is still
// [<subscribers>, <videos>], so its first part is still the count.
const german = parseChannelHtml(
  '"pageHeaderRenderer":{"pageTitle":"Kanal","content":{"pageHeaderViewModel":{' +
    '"metadataRows":[{"metadataParts":[{"text":{"content":"@kanal"}}]},' +
    '{"metadataParts":[{"text":{"content":"1,2 Mio. Abonnenten"}},{"text":{"content":"340 Videos"}}]}],' +
    '"delimiter":"•"}}}'
);
german.subs === "1,2 Mio. Abonnenten"
  ? ok("a non-English header still yields the subscriber part, not the video count")
  : fail(`non-English header parsed as ${JSON.stringify(german.subs)}`);

// No header at all (a consent wall, a redirect to a non-channel page) must
// report that, so the caller can pay for the full page instead of recording a
// blank as if it were an answer.
parseChannelHtml("<html>nothing useful</html>").headed === false
  ? ok("a page with no channel header says so")
  : fail("a headerless page was reported as headed");

// ---- live: the same channel by both identity formats ----
const PAIRS = [
  ["@mkbhd", "UCBJycsmduvYEL83R_U4JriQ"],
  ["@Kurzgesagt", "UCsXVk37bltHxD1rDPwtNM8Q"]
];
for (const [handle, ucid] of PAIRS) {
  const [a, b] = await Promise.all([scrapeChannelInfo(handle), scrapeChannelInfo(ucid)]);
  if (!a || !b || !a.subs || !b.subs) {
    fail(`no count for ${handle} (${a && a.subs}) / ${ucid} (${b && b.subs})`);
    continue;
  }
  a.subs === b.subs
    ? ok(`${handle} and its UC id report the same count (${a.subs})`)
    : fail(`${handle}=${a.subs} but ${ucid}=${b.subs} — one of them is someone else's`);
  a.ucid === ucid
    ? ok(`${handle} resolves to the right UC id`)
    : fail(`${handle} resolved to ${a.ucid}, expected ${ucid}`);
  (b.handle || "").toLowerCase() === handle.toLowerCase()
    ? ok(`${ucid} resolves to the right handle`)
    : fail(`${ucid} resolved to ${b.handle}, expected ${handle}`);
}

// ---- live: a channel everyone knows is enormous ----
// A floor, not a value: the point is to catch a reading that is off by orders
// of magnitude, which is exactly what a shelf card gives you.
const huge = await scrapeChannelInfo("UCX6OQ3DkcsbYNE6H8uQQuVA"); // MrBeast
const n = /^([\d.]+)M$/.test(String(huge && huge.subs))
  ? parseFloat(huge.subs) * 1e6
  : null;
n && n > 5e7
  ? ok(`the largest channel on YouTube reads as ${huge.subs}`)
  : fail(`MrBeast came back as ${huge && huge.subs} — that is not his subscriber count`);

// ---- live: a channel that no longer exists ----
const dead = await scrapeChannelInfo("@bt-gone-channel-test-99182734");
dead && dead.gone
  ? ok("a 404 channel reports gone rather than nothing")
  : fail(`a deleted channel returned ${JSON.stringify(dead)}`);
