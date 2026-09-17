import { chromium } from "playwright";

// Comments by a blocked channel.
//
// Blocking someone and then meeting their comments under every video you watch
// is the most visible way "blocked" stops meaning blocked — and comments were
// handled nowhere: they are not tiles (RENDERER_SELECTOR) and not community
// posts (POST_SELECTOR).
//
// The author link is the only thing that decides. The false positive this
// guards against is removing a comment that merely *mentions* a blocked
// channel — that is someone else talking, and dropping it is the same mistake
// as matching `@mkbhd` against `@mkbhd508`.
//
// The channel to block is read off the page rather than hard-coded, so this
// doesn't rot when the comments under a given video change.

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const VIDEO = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";

const ctx = await chromium.launchPersistentContext(`/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
  viewport: { width: 1500, height: 1100 }
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

// Load the comments and pick an author that is actually there.
const loadComments = async () => {
  const p = await ctx.newPage();
  await p.goto(VIDEO, { waitUntil: "domcontentloaded" }).catch(() => {});
  await p.waitForTimeout(5000);
  for (let i = 0; i < 5; i++) {
    await p.mouse.wheel(0, 1800);
    await p.waitForTimeout(1400);
  }
  await p.waitForTimeout(4000);
  return p;
};

const probe = await loadComments();
const authors = await probe.evaluate(() =>
  [...document.querySelectorAll("ytd-comment-thread-renderer")]
    .map((t) => {
      const a = t.querySelector("#author-text");
      return a ? (a.getAttribute("href") || "") : "";
    })
    .filter((h) => /^\/@[\w.-]+$/.test(h))
);
await probe.close();

const target = authors.find((h) => authors.filter((x) => x === h).length >= 1);
if (!target) {
  fail("no comment authors found — YouTube's comment markup changed (#author-text)");
  await ctx.close();
  process.exit();
}
const HANDLE = target.slice(1); // "@name"
ok(`picked a real comment author to block: ${HANDLE}`);

const countFor = async (p, handle) =>
  p.evaluate((h) => {
    const threads = [...document.querySelectorAll("ytd-comment-thread-renderer")];
    const byAuthor = threads.filter((t) => {
      const a = t.querySelector("#author-text");
      return a && (a.getAttribute("href") || "").toLowerCase() === "/" + h.toLowerCase();
    });
    return { threads: threads.length, byBlockedAuthor: byAuthor.length };
  }, handle);

// ---- baseline: their comment is there ----
const before = await loadComments();
const b = await countFor(before, HANDLE);
await before.close();
b.byBlockedAuthor > 0
  ? ok(`baseline: ${b.byBlockedAuthor} comment thread(s) by ${HANDLE} among ${b.threads}`)
  : fail(`could not find a comment by ${HANDLE} to test against`);

// ---- blocked FULL: their threads go, everyone else's stay ----
await send({ type: "UNBLOCK_CHANNEL", id: HANDLE });
await send({ type: "BLOCK_CHANNEL", id: HANDLE, name: HANDLE, mode: "full" });
await ext.waitForTimeout(5000);

const after = await loadComments();
const a = await countFor(after, HANDLE);
await after.close();
a.byBlockedAuthor === 0
  ? ok(`blocked: no comment thread by ${HANDLE} survives`)
  : fail(`${a.byBlockedAuthor} comment thread(s) by the blocked channel survived`);
a.threads > 0
  ? ok(`other people's comments are untouched (${a.threads} threads remain)`)
  : fail("every comment was removed — the author match is far too broad");

// ---- a comment that only MENTIONS the blocked channel must survive ----
const mention = await loadComments();
const mentionResult = await mention.evaluate((h) => {
  const thread = document.querySelector("ytd-comment-thread-renderer");
  if (!thread) return { ok: false, reason: "no thread to test with" };
  const body = thread.querySelector("#content-text, #comment-content") || thread;
  const link = document.createElement("a");
  link.href = "/" + h;
  link.textContent = "@" + h;
  body.appendChild(link);
  return new Promise((r) =>
    setTimeout(() => r({ ok: true, stillThere: thread.isConnected }), 3500)
  );
}, HANDLE);
await mention.close();
mentionResult.ok
  ? mentionResult.stillThere
    ? ok("a comment that only mentions the blocked channel is left alone")
    : fail("removed a comment merely mentioning the blocked channel (false positive)")
  : console.log(`ok: (skipped) ${mentionResult.reason}`);

// ---- video-only mode keeps their comments: the channel itself isn't blocked ----
await send({ type: "UNBLOCK_CHANNEL", id: HANDLE });
await send({ type: "BLOCK_CHANNEL", id: HANDLE, name: HANDLE, mode: "exceptWhitelist" });
await ext.waitForTimeout(5000);
const soft = await loadComments();
const s = await countFor(soft, HANDLE);
await soft.close();
s.byBlockedAuthor > 0
  ? ok(`video-only mode keeps their comments (${s.byBlockedAuthor} thread(s)) — that mode keeps the channel`)
  : fail("video-only mode removed their comments; only a FULL block should");

await send({ type: "UNBLOCK_CHANNEL", id: HANDLE });
await ctx.close();
