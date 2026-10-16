import { spawn, execFileSync } from "child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { chromium } from "playwright";

// Sync through your own server, end to end and offline: the real
// server/xrntube-sync.py on 127.0.0.1, and two browser profiles with the
// extension (think laptop and phone) syncing through it.
//   - connecting pulls what's there; a block on one device reaches the other
//   - an unblock travels too (a tombstone, not a resurrected entry)
//   - two devices writing at once both keep their edits (the 412 path)
//   - keywords travel with the blocklist
//   - a wrong password is refused, with a readable error
//   - settings, keywords and the never-block list merge item by item: two
//     devices each changing a different one keep both, a deletion travels
//   - the server keeps earlier copies, and restoring one through the options
//     page brings back what a "delete everything" took, on both devices
// Needs python3 with `bcrypt` (the server's one dependency).

const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const dir = mkdtempSync(join(tmpdir(), "xt-sync-"));
const USER = "me";
const PASS = "pässword-123"; // non-ASCII on purpose: Basic auth must survive it
writeFileSync(
  join(dir, "users"),
  execFileSync("python3", ["-c", `import bcrypt,sys; print("${USER}:" + bcrypt.hashpw(sys.argv[1].encode(), bcrypt.gensalt(4)).decode())`, PASS])
);
const PORT = 5300 + Math.floor(Math.random() * 500);
const server = spawn("python3", [join(EXT_PATH, "server/xrntube-sync.py"), "--port", String(PORT), "--data", join(dir, "data"), "--users", join(dir, "users")], {
  stdio: ["ignore", "ignore", "pipe"]
});
let serverLog = "";
server.stderr.on("data", (d) => (serverLog += d));
const URL_ = `http://127.0.0.1:${PORT}/xrntube`;
for (let i = 0; i < 50; i++) {
  const up = await fetch(`http://127.0.0.1:${PORT}/health`).then((r) => r.ok, () => false);
  if (up) break;
  await new Promise((r) => setTimeout(r, 100));
}

async function device(name) {
  const ctx = await chromium.launchPersistentContext(join(dir, "profile-" + name), {
    headless: false,
    args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"]
  });
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${sw.url().split("/")[2]}/options/options.html`);
  const send = (m) => p.evaluate((mm) => chrome.runtime.sendMessage(mm), m);
  return { ctx, p, send, list: async () => (await send({ type: "GET_BLOCKLIST" })).channels };
}
// A sync can hand its push to a rerun (412); keep syncing until both agree.
async function settle(...devs) {
  for (let round = 0; round < 4; round++) for (const d of devs) await d.send({ type: "SYNC_NOW" });
}
const stamped = (name) => ({ name, mode: "full", subsAt: Date.now(), subsV: 9 });

// Closed in `finally` too: an exception that skipped the closes left both
// browsers running and the process waiting on them until the runner's timeout.
let A;
let B;
try {
  A = await device("A");
  B = await device("B");

  // ---- wrong password ----
  const bad = await A.send({ type: "SET_SYNC_CONFIG", conn: { url: URL_, user: USER, password: "nope" } });
  bad && bad.ok === false && /refused/.test(bad.error || "")
    ? ok("a wrong password is refused with a readable error")
    : fail("wrong password: " + JSON.stringify(bad));

  // ---- A pushes, B pulls ----
  await A.send({ type: "IMPORT_BLOCKLIST", channels: { "@alpha": stamped("Alpha"), "@beta": stamped("Beta") }, videos: { aaaaaaaaaaa: { title: "v" } } });
  await A.p.evaluate(() => chrome.storage.sync.set({ bt_keywords: { list: [{ p: "reaction", re: false }], ts: Date.now() } }));
  const conA = await A.send({ type: "SET_SYNC_CONFIG", conn: { url: URL_, user: USER, password: PASS } });
  conA && conA.ok ? ok("device A connects and pushes") : fail("connect A: " + JSON.stringify(conA));
  const conB = await B.send({ type: "SET_SYNC_CONFIG", conn: { url: URL_ + "/", user: USER, password: PASS } });
  const bList = await B.list();
  const bKw = (await B.p.evaluate(() => chrome.storage.sync.get("bt_keywords"))).bt_keywords;
  conB && conB.ok && bList["@alpha"] && bList["@beta"] && bKw && bKw.list.length === 1
    ? ok("device B connects and pulls A's channels and keywords")
    : fail(`pull on B: ${JSON.stringify(conB)} channels=${Object.keys(bList)} kw=${JSON.stringify(bKw)}`);

  // ---- an unblock travels as a deletion ----
  await B.send({ type: "UNBLOCK_CHANNEL", id: "@beta" });
  await settle(B, A);
  !(await A.list())["@beta"] && (await A.list())["@alpha"]
    ? ok("an unblock on B removes the channel on A (and only that one)")
    : fail("unblock didn't travel: " + Object.keys(await A.list()));

  // ---- both write at once ----
  await A.send({ type: "IMPORT_BLOCKLIST", channels: { "@gamma": stamped("Gamma") }, videos: {} });
  await B.send({ type: "IMPORT_BLOCKLIST", channels: { "@delta": stamped("Delta") }, videos: {} });
  await Promise.all([A.send({ type: "SYNC_NOW" }), B.send({ type: "SYNC_NOW" })]);
  await settle(A, B);
  const a = Object.keys(await A.list()).sort();
  const b = Object.keys(await B.list()).sort();
  JSON.stringify(a) === JSON.stringify(b) && a.includes("@gamma") && a.includes("@delta")
    ? ok(`two devices writing at once both keep their edits (${a.join(", ")})`)
    : fail(`after concurrent writes: A=${a} B=${b}`);

  // ---- what's on the server ----
  const onDisk = JSON.parse(readFileSync(join(dir, "data/users", USER, "state.json"), "utf8"));
  onDisk.version >= 3 && onDisk.data.channels["@alpha"] && onDisk.data.tombstones["channel:@beta"]
    ? ok(`the server holds one versioned document (v${onDisk.version}) with the deletion recorded`)
    : fail("server document: " + JSON.stringify(onDisk).slice(0, 200));

  const st = await A.send({ type: "GET_SYNC_STATUS" });
  st.enabled && st.url === URL_ && !st.lastError && st.remoteChannels === a.length
    ? ok("status reports the server, no error, and the right count")
    : fail("status: " + JSON.stringify(st));

  // ---- settings: one shared set, merged switch by switch ----
  const setSwitch = (d, key, on) =>
    d.p.evaluate(
      ([k, v]) =>
        chrome.storage.sync.get("bt_settings").then((r) =>
          chrome.storage.sync.set({ bt_settings: { ...XrnTube.resolveSettings(r.bt_settings), [k]: v } })
        ),
      [key, on]
    );
  const switches = async (d) => d.p.evaluate(() => chrome.storage.sync.get("bt_settings").then((r) => XrnTube.resolveSettings(r.bt_settings)));
  await settle(A, B);
  await setSwitch(A, "sidebarExplore", false);
  await setSwitch(B, "actionClip", false);
  await settle(A, B);
  const sA = await switches(A);
  const sB = await switches(B);
  sA.sidebarExplore === false && sA.actionClip === false && sB.sidebarExplore === false && sB.actionClip === false
    ? ok("a switch flipped on each device reaches the other, and neither undoes the other's")
    : fail(`settings: A=${sA.sidebarExplore}/${sA.actionClip} B=${sB.sidebarExplore}/${sB.actionClip}`);

  // ---- keywords: item by item, deletions included, bounds carried ----
  // { add, drop, set } — data, not code: the options page's CSP forbids eval.
  const editKw = (d, op) =>
    d.p.evaluate(
      ({ add, drop, set }) =>
        chrome.storage.sync.get("bt_keywords").then((r) => {
          const k = r.bt_keywords || { list: [] };
          let list = k.list.filter((x) => x.p !== drop);
          if (add) list = [{ p: add, re: false }, ...list];
          return chrome.storage.sync.set({ bt_keywords: { ...k, ...(set || {}), list, ts: Date.now() } });
        }),
      op
    );
  const kwOf = async (d) => (await d.p.evaluate(() => chrome.storage.sync.get("bt_keywords"))).bt_keywords;
  await editKw(A, { add: "from-a" });
  await editKw(B, { add: "from-b" });
  await settle(A, B);
  const kwA = (await kwOf(A)).list.map((k) => k.p).sort();
  const kwB = (await kwOf(B)).list.map((k) => k.p).sort();
  JSON.stringify(kwA) === JSON.stringify(["from-a", "from-b", "reaction"]) && JSON.stringify(kwA) === JSON.stringify(kwB)
    ? ok("a keyword added on each device between syncs: both survive, on both (" + kwA.join(", ") + ")")
    : fail(`keywords after concurrent adds: A=${kwA} B=${kwB}`);
  await editKw(B, { drop: "reaction" });
  await editKw(A, { set: { commentLimit: 12 } });
  await settle(B, A);
  const kwA2 = await kwOf(A);
  const kwB2 = await kwOf(B);
  !kwA2.list.some((k) => k.p === "reaction") && kwA2.list.length === 2 && kwB2.commentLimit === 12 && kwA2.commentLimit === 12
    ? ok("a keyword deleted on B is deleted on A; A's comment limit reaches B")
    : fail(`keyword delete / commentLimit: A=${JSON.stringify(kwA2)} B=${JSON.stringify(kwB2)}`);

  // ---- never-block list: same ----
  await A.send({ type: "ALLOW_CHANNEL", id: "@keep-a" });
  await B.send({ type: "ALLOW_CHANNEL", id: "@keep-b" });
  await settle(A, B);
  const alOf = async (d) => Object.keys((await d.send({ type: "GET_BLOCKLIST" })).allowlist || {}).sort();
  const alA = await alOf(A);
  JSON.stringify(alA) === JSON.stringify(["@keep-a", "@keep-b"]) && JSON.stringify(alA) === JSON.stringify(await alOf(B))
    ? ok("a never-block entry added on each device: both survive, on both")
    : fail(`allowlist: A=${alA} B=${await alOf(B)}`);
  await A.send({ type: "DISALLOW_CHANNEL", id: "@keep-b" });
  await settle(A, B);
  JSON.stringify(await alOf(B)) === JSON.stringify(["@keep-a"])
    ? ok("removing a never-block entry on A removes it on B")
    : fail("allowlist removal didn't travel: " + (await alOf(B)));

  // ---- agreement is stable: nothing to push means no push ----
  // A merge that never quite matches what the server holds (a field one side
  // normalises and the other doesn't) pushes on every cycle — every 3 minutes
  // per device, forever, each push another history copy.
  await new Promise((r) => setTimeout(r, 5000)); // let the debounced pushes land
  await settle(A, B);
  const versionOnDisk = () => JSON.parse(readFileSync(join(dir, "data/users", USER, "state.json"), "utf8")).version;
  const vBefore = versionOnDisk();
  await settle(A, B);
  const vAfter = versionOnDisk();
  vAfter === vBefore
    ? ok(`once both devices agree, more syncing pushes nothing (still v${vAfter})`)
    : fail(`idle syncing kept pushing: v${vBefore} → v${vAfter}`);

  // ---- the server's history, and restoring from it ----
  const beforeWipe = Object.keys(await A.list()).sort();
  await A.send({ type: "DELETE_DATA", channels: "all", videos: "all" });
  await settle(A, B);
  Object.keys(await B.list()).length === 0
    ? ok("delete everything on A empties B too (the case history exists for)")
    : fail("wipe didn't travel: " + Object.keys(await B.list()));
  // The pushes after the wipe were kept too (empty); the copy to restore is
  // the newest one that still has channels — what a user would pick.
  const hist = await B.send({ type: "SYNC_HISTORY" });
  const items = (hist && hist.ok && hist.items) || [];
  const pick = items.findIndex((it) => it.channels > 0);
  pick >= 0 && items[pick].channels === beforeWipe.length && items.every((it, i) => !i || items[i - 1].name > it.name)
    ? ok(`the server lists ${items.length} earlier copies, newest first; the last one before the wipe has all ${beforeWipe.length} channels`)
    : fail("history: " + JSON.stringify(hist).slice(0, 300));

  await B.p.locator(".page-tab[data-page='sync']").click();
  await B.p.locator("#sync-history").click();
  await B.p.locator("#modal:not([hidden]) .history-list li").first().waitFor({ timeout: 5000 });
  await B.p.locator("#modal:not([hidden]) .history-list li").nth(Math.max(0, pick)).click();
  await B.p.locator("#modal-confirm").click(); // Preview
  await B.p.locator("#modal:not([hidden]) ul.plan:not(.history-list)").waitFor({ timeout: 5000 });
  const previewText = await B.p.locator("#modal-body").innerText();
  await B.p.locator("#modal-confirm").click(); // Import
  await B.p.waitForTimeout(1000);
  await settle(B, A);
  const restoredA = Object.keys(await A.list()).sort();
  const restoredB = Object.keys(await B.list()).sort();
  /server's copy from/.test(previewText) &&
  JSON.stringify(restoredB) === JSON.stringify(beforeWipe) &&
  JSON.stringify(restoredA) === JSON.stringify(beforeWipe)
    ? ok(`restoring that copy on B brings all ${beforeWipe.length} channels back on both devices, past A's tombstones`)
    : fail(`restore: preview=${JSON.stringify(previewText.slice(0, 120))} A=${restoredA} B=${restoredB} want=${beforeWipe}`);

} catch (e) {
  fail(e.stack || String(e));
} finally {
  await A?.ctx.close().catch(() => {});
  await B?.ctx.close().catch(() => {});
  server.kill();
  if (process.exitCode) console.log("server log:\n" + serverLog.slice(-1500));
}
console.log("\nDONE");
