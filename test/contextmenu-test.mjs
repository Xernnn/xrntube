import { readFileSync } from "fs";

// Right-click → block. A native context menu can't be opened from Playwright,
// so the part worth testing is the part that can actually be wrong: working out
// *what* you right-clicked. The regexes and `ctxTargetFrom()` are lifted
// straight out of background.js (the same trick locale-age-test uses for
// parseAgeDays) so this can't drift from the shipped code without failing.
//
// Pure Node: no browser, runs offline, finishes instantly.

const src = readFileSync(new URL("../background/background.js", import.meta.url), "utf8");
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);

const grab = (name) => {
  const m = src.match(new RegExp(`const ${name} = (/.*?/);\\n`));
  if (!m) throw new Error(`could not find ${name} in background.js`);
  return m[1];
};
const fnSrc = src.match(/function ctxTargetFrom\(info\) \{[\s\S]*?\n\}/);
if (!fnSrc) {
  fail("ctxTargetFrom() not found in background.js — did it get renamed?");
  process.exit();
}

const ctxTargetFrom = new Function(
  `const CTX_VIDEO_RE = ${grab("CTX_VIDEO_RE")};
   const CTX_CHANNEL_RE = ${grab("CTX_CHANNEL_RE")};
   ${fnSrc[0]}
   return ctxTargetFrom;`
)();

const t = (url) => ctxTargetFrom({ linkUrl: url });

// ---- every video URL shape a YouTube link can take ----
for (const [shape, url, id] of [
  ["watch?v=", "https://www.youtube.com/watch?v=ANmTVYkEtLw", "ANmTVYkEtLw"],
  ["watch with extra params", "https://www.youtube.com/watch?list=PL123&v=ANmTVYkEtLw&t=3s", "ANmTVYkEtLw"],
  ["/shorts/", "https://www.youtube.com/shorts/ANmTVYkEtLw", "ANmTVYkEtLw"],
  ["/live/", "https://www.youtube.com/live/ANmTVYkEtLw", "ANmTVYkEtLw"],
  ["/embed/", "https://www.youtube.com/embed/ANmTVYkEtLw", "ANmTVYkEtLw"]
]) {
  const got = t(url).videoId;
  got === id ? ok(`video id read from ${shape}`) : fail(`${shape}: got ${got}, expected ${id}`);
}

// ---- channel URL shapes ----
for (const [shape, url, key] of [
  ["/@handle", "https://www.youtube.com/@mkbhd", "@mkbhd"],
  ["/@handle/videos", "https://www.youtube.com/@mkbhd/videos", "@mkbhd"],
  ["/channel/UC…", "https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ", "UCBJycsmduvYEL83R_U4JriQ"]
]) {
  const got = t(url).channelKey;
  got === key ? ok(`channel key read from ${shape}`) : fail(`${shape}: got ${got}, expected ${key}`);
}

// ---- things that must NOT resolve ----
// /c/ and /user/ name neither identity format, so they can't be keyed — the
// handler reports that rather than blocking the wrong thing.
for (const [what, url] of [
  ["legacy /c/", "https://www.youtube.com/c/mkbhd"],
  ["legacy /user/", "https://www.youtube.com/user/marquesbrownlee"],
  ["the home feed", "https://www.youtube.com/"],
  ["a search page", "https://www.youtube.com/results?search_query=mkbhd"]
]) {
  const r = t(url);
  !r.channelKey && !r.videoId
    ? ok(`${what} resolves to nothing (reported, not guessed)`)
    : fail(`${what} wrongly resolved to ${JSON.stringify(r)}`);
}

// A right-click on the page itself, with no link under the cursor.
const pageOnly = ctxTargetFrom({ pageUrl: "https://www.youtube.com/watch?v=ANmTVYkEtLw" });
pageOnly.videoId === "ANmTVYkEtLw"
  ? ok("falls back to the page URL when the click wasn't on a link")
  : fail(`page-URL fallback failed: ${JSON.stringify(pageOnly)}`);

// A link wins over the page it sits on — right-clicking a tile on a watch page
// must block the tile, not the video you're watching.
const linkWins = ctxTargetFrom({
  linkUrl: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  pageUrl: "https://www.youtube.com/watch?v=ANmTVYkEtLw"
});
linkWins.videoId === "dQw4w9WgXcQ"
  ? ok("the link under the cursor wins over the page URL")
  : fail(`link should take precedence: ${JSON.stringify(linkWins)}`);

// The menu items must be registered against youtube.com only.
/documentUrlPatterns: \["\*:\/\/\*\.youtube\.com\/\*"\]/.test(src)
  ? ok("context menu items are scoped to youtube.com")
  : fail("context menu items are not scoped to youtube.com");
