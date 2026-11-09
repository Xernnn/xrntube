import { chromium } from "playwright";

// The network-level redirect for a blocked channel's own page, offline: what
// rebuildDnrRules() writes, asked of Chrome's own rule matcher
// (declarativeNetRequest.testMatchOutcome, there for unpacked extensions).
//   - a blocked @handle's page redirects on www. and m., with a path or a
//     query after it, in any case
//   - …and no other channel's: the rule was the bare substring
//     "youtube.com/@foo", which also matched @foobar, @foo.tv and @foo-bar
//   - a blocked UC id's page, and its tabs, redirect too
//   - nothing off youtube.com does: another host named like it, or a link
//     to the channel inside some other site's URL (a redirect rule acts only
//     where the extension has host access, youtube.com, and the rule's `||`
//     anchor says the same on its own)
//
// Needs the extension but not the network.

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ctx = await chromium.launchPersistentContext(`/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"]
});
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${sw.url().split("/")[2]}/options/options.html`);
  const UC = "UCdnrtest" + "x".repeat(15);
  // An import, not BLOCK_CHANNEL: no lookup on youtube.com afterwards.
  const res = await p.evaluate(
    (uc) => chrome.runtime.sendMessage({ type: "IMPORT_BLOCKLIST", channels: { "@foo": { name: "Foo" }, [uc]: { name: "By id" } }, videos: {} }),
    UC
  );
  if (!res || !res.ok) throw new Error("import: " + JSON.stringify(res));

  const redirected = (url) =>
    sw.evaluate(
      (u) => chrome.declarativeNetRequest.testMatchOutcome({ url: u, type: "main_frame" }).then((r) => r.matchedRules.length > 0),
      url
    );
  const sweep = async (urls) => Object.fromEntries(await Promise.all(urls.map(async (u) => [u, await redirected(u)])));

  const blocked = await sweep([
    "https://www.youtube.com/@foo",
    "https://m.youtube.com/@foo",
    "https://youtube.com/@foo",
    "https://www.youtube.com/@foo/videos",
    "https://www.youtube.com/@foo?si=abc",
    "https://www.youtube.com/@FOO",
    `https://www.youtube.com/channel/${UC}`,
    `https://www.youtube.com/channel/${UC}/videos`
  ]);
  const missed = Object.keys(blocked).filter((u) => !blocked[u]);
  !missed.length
    ? ok("a blocked channel's page redirects as @handle (www., m., bare, with a path, a query, in capitals) and as /channel/UC…, tabs included")
    : fail("not redirected: " + missed.join(", "));

  const others = await sweep([
    "https://www.youtube.com/@foobar",
    "https://www.youtube.com/@foo.tv",
    "https://www.youtube.com/@foo-bar",
    "https://www.youtube.com/@foo_2",
    "https://m.youtube.com/@foobar/videos"
  ]);
  const caught = Object.keys(others).filter((u) => others[u]);
  !caught.length
    ? ok("…and no other channel's: @foobar, @foo.tv, @foo-bar and @foo_2 all open")
    : fail("another channel's page redirected: " + caught.join(", "));

  const offsite = await sweep([
    "https://notyoutube.com/@foo",
    "https://www.google.com/url?q=https://www.youtube.com/@foo"
  ]);
  const off = Object.keys(offsite).filter((u) => offsite[u]);
  !off.length
    ? ok("nothing off youtube.com is redirected: a host named like it, or another site's URL that carries the link")
    : fail("redirected off youtube.com: " + off.join(", "));
} catch (e) {
  fail(e.stack || String(e));
} finally {
  await ctx.close().catch(() => {});
}
console.log("\nDONE");
