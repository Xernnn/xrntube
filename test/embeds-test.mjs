import { chromium } from "playwright";

// `blockInEmbeds` — the one setting that reaches outside youtube.com, and so
// the only leaf that ships OFF.
//
// The host page here is a real third-party origin with a youtube.com/embed
// iframe in it, which is exactly the shape this guards: the extension has no
// content script on the host page and cannot remove the <iframe> element, so
// the frame can only be neutered from the inside.
//
// The off case matters as much as the on case — this is opt-in, and an
// extension that quietly altered embeds on every site would be a nasty
// surprise.

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const HANDLE = "@mkbhd";
const HOST_PAGE = "https://example.com/";

const ctx = await chromium.launchPersistentContext(`/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
  viewport: { width: 1200, height: 800 }
});
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);

const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
const extId = sw.url().split("/")[2];
const ext = await ctx.newPage();
await ext.goto(`chrome-extension://${extId}/options/options.html`);
const send = (m) => ext.evaluate((mm) => new Promise((r) => chrome.runtime.sendMessage(mm, r)), m);
const setEmbeds = (on) =>
  ext.evaluate(
    (v) =>
      new Promise((r) =>
        chrome.storage.sync.get(["bt_settings"], (d) =>
          chrome.storage.sync.set({ bt_settings: { ...(d.bt_settings || {}), blockInEmbeds: v } }, r)
        )
      ),
    on
  );

// A real, current video from the channel, grabbed before it is blocked.
const probe = await ctx.newPage();
await probe.goto(`https://www.youtube.com/${HANDLE}/videos`, { waitUntil: "domcontentloaded" }).catch(() => {});
await probe.waitForTimeout(6000);
const VID = await probe.evaluate(() => {
  const ids = [...document.querySelectorAll('a[href*="/watch?v="]')]
    .map((a) => (a.getAttribute("href") || "").match(/[?&]v=([\w-]{11})/)?.[1])
    .filter(Boolean);
  return ids[0] || null;
});
await probe.close();
if (!VID) {
  fail("could not find a video on the channel page (YouTube markup changed?)");
  await ctx.close();
  process.exit();
}

await send({ type: "UNBLOCK_CHANNEL", id: HANDLE });
await send({ type: "BLOCK_CHANNEL", id: HANDLE, name: "MKBHD", mode: "full" });
await ext.waitForTimeout(6000); // let the identity enrich land

// Embed the blocked channel's video in a third-party page and report what the
// frame ended up showing.
const embedState = async () => {
  const page = await ctx.newPage();
  await page.goto(HOST_PAGE, { waitUntil: "domcontentloaded" }).catch(() => {});
  await page.evaluate((id) => {
    const f = document.createElement("iframe");
    f.id = "bt-embed";
    f.width = "560";
    f.height = "315";
    f.src = `https://www.youtube.com/embed/${id}`;
    document.body.appendChild(f);
  }, VID);
  await page.waitForTimeout(9000);
  const out = await page.evaluate(() => {
    const f = document.getElementById("bt-embed");
    try {
      const d = f.contentDocument; // cross-origin: null, which is the normal case
      return { reachable: !!d, text: d ? (d.body.textContent || "").trim().slice(0, 40) : null };
    } catch {
      return { reachable: false, text: null };
    }
  });
  // The host page can't read a cross-origin frame, so ask the frame itself —
  // Playwright can see into it.
  const frame = page.frames().find((fr) => fr.url().includes("/embed/"));
  const inside = frame
    ? await frame
        .evaluate(() => ({
          body: (document.body.textContent || "").trim().slice(0, 40),
          hasVideo: !!document.querySelector("video")
        }))
        .catch(() => null)
    : null;
  await page.close();
  return { out, inside };
};

// ---- off (the default): embeds are left completely alone ----
await setEmbeds(false);
await ext.waitForTimeout(1200);
const offState = await embedState();
offState.inside && !offState.inside.body.startsWith("Blocked by BlockTube")
  ? ok(`default (off): a blocked channel's embed is untouched (${JSON.stringify(offState.inside)})`)
  : fail(`embeds were altered while the setting was OFF: ${JSON.stringify(offState.inside)}`);

// ---- on: the frame is blanked ----
await setEmbeds(true);
await ext.waitForTimeout(1200);
const onState = await embedState();
onState.inside && onState.inside.body.startsWith("Blocked by BlockTube")
  ? ok("opted in: the embedded player is blanked")
  : fail(`embed was not blocked with the setting ON: ${JSON.stringify(onState.inside)}`);

// ---- an unblocked channel's embed still plays while opted in ----
const other = await ctx.newPage();
await other.goto(HOST_PAGE, { waitUntil: "domcontentloaded" }).catch(() => {});
await other.evaluate(() => {
  const f = document.createElement("iframe");
  f.id = "bt-embed2";
  f.src = "https://www.youtube.com/embed/dQw4w9WgXcQ";
  document.body.appendChild(f);
});
await other.waitForTimeout(9000);
const okFrame = other.frames().find((fr) => fr.url().includes("/embed/"));
const okInside = okFrame ? await okFrame.evaluate(() => (document.body.textContent || "").trim().slice(0, 40)).catch(() => null) : null;
await other.close();
!(okInside || "").startsWith("Blocked by BlockTube")
  ? ok("an unblocked channel's embed still plays while opted in")
  : fail("blanked an embed whose channel is not blocked (false positive)");

await send({ type: "UNBLOCK_CHANNEL", id: HANDLE });
await setEmbeds(false);
await ctx.close();
