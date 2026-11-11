import { spawn, execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { gzipSync } from "zlib";
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
//   - /update/ hands out the update files without a login, and nothing else
//   - a PUT that says gzip and isn't gets an answer, and one that inflates
//     past the size limit is refused before it is inflated in full
//   - wrong passwords sent all at once still get only ten guesses an address
//   - the address counted is the proxy's own hop, and an IPv6 line is its /64
//   - a write sent from another site's page is refused; the extension's go on
//   - a connection that goes quiet is let go
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
// A second login with a costlier hash, as a real htpasswd's is: a guess at it
// is still being checked while the next ones arrive.
const SLOW_USER = "slowhash";
writeFileSync(
  join(dir, "users"),
  execFileSync("python3", [
    "-c",
    "import bcrypt,sys\nfor u, pw, cost in ((sys.argv[1], sys.argv[2], 4), (sys.argv[3], sys.argv[4], 10)):\n    print(u + ':' + bcrypt.hashpw(pw.encode(), bcrypt.gensalt(cost)).decode())",
    USER,
    PASS,
    SLOW_USER,
    "slow-pass"
  ])
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

  // ---- /update/ is public, and only for the update files ----
  // A browser's extension updater fetches these and can't send a login.
  mkdirSync(join(dir, "data", "update"), { recursive: true });
  const crxBytes = Buffer.from("Cr24 not really a crx, but bytes that must arrive untouched ".repeat(40));
  writeFileSync(join(dir, "data", "update", "updates.xml"), "<gupdate version='9.9.9'/>");
  writeFileSync(join(dir, "data", "update", "xrntube-9.9.9.crx"), crxBytes);
  writeFileSync(join(dir, "data", "update", "notes.txt"), "not served");
  writeFileSync(join(dir, "data", "downloads", "xrntube.zip"), "zip");
  const xmlRes = await fetch(`${URL_}/update/updates.xml`);
  const crxRes = await fetch(`${URL_}/update/xrntube-9.9.9.crx`, { headers: { "Accept-Encoding": "gzip" } });
  const crxBody = Buffer.from(await crxRes.arrayBuffer());
  const refused = await Promise.all(
    ["/update/notes.txt", "/update/.updates.xml", "/update/%2e%2e%2fdownloads%2fxrntube.zip", "/update/missing.crx"].map((p) =>
      fetch(URL_ + p).then((r) => r.status)
    )
  );
  const zipNoLogin = (await fetch(`${URL_}/download/xrntube.zip`)).status;
  xmlRes.status === 200 &&
  /xml/.test(xmlRes.headers.get("content-type")) &&
  (await xmlRes.text()) === "<gupdate version='9.9.9'/>" &&
  crxRes.status === 200 &&
  crxRes.headers.get("content-type") === "application/x-chrome-extension" &&
  !crxRes.headers.get("content-encoding") &&
  crxBody.equals(crxBytes) &&
  refused.every((s) => s === 404) &&
  zipNoLogin === 401
    ? ok("/update/ serves updates.xml and the .crx without a login (the .crx never gzipped), nothing else there, and /download/ still needs one")
    : fail(`/update/: xml ${xmlRes.status} ${xmlRes.headers.get("content-type")}, crx ${crxRes.status} ${crxRes.headers.get("content-type")} ${crxRes.headers.get("content-encoding")} same=${crxBody.equals(crxBytes)}, refused ${refused}, /download/ without login ${zipNoLogin}`);

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

  // ---- the server's clock decides, not the device's ----
  // Entries merge last-write-wins on updated_at, so a device whose clock runs
  // ahead wins every merge until real time catches up. The server's Date
  // header corrects it — but these are CORS requests, a header the server
  // doesn't expose can't be read, and the correction never happened. A's
  // clock an hour fast: after a sync, what it stamps is the server's time.
  const swA = A.ctx.serviceWorkers()[0];
  await swA.evaluate(() => {
    self.btRealNow = Date.now;
    Date.now = () => self.btRealNow() + 3600e3;
  });
  try {
    await A.send({ type: "SYNC_NOW" });
    await A.send({ type: "IMPORT_BLOCKLIST", channels: { "@clockcheck": { name: "Clock check" } }, videos: {} });
  } finally {
    await swA.evaluate(() => (Date.now = self.btRealNow));
  }
  const { bt_sync: cfgA, bt_blocklist: blA } = await A.p.evaluate(() => chrome.storage.local.get(["bt_sync", "bt_blocklist"]));
  const clockStamp = blA.channels["@clockcheck"].updated_at;
  Math.abs(cfgA.clockOffset + 3600e3) < 5000 && Math.abs(clockStamp - Date.now()) < 10000
    ? ok(`a device clock an hour fast is corrected by the server's Date header (offset ${Math.round(cfgA.clockOffset / 1000)} s), and what it stamps is the server's time`)
    : fail(`clock: offset ${cfgA.clockOffset} ms, an entry stamped ${Math.round((clockStamp - Date.now()) / 1000)} s from now`);

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
  // { add, drop, set, strip } — data, not code: the options page's CSP forbids eval.
  const editKw = (d, op) =>
    d.p.evaluate(
      ({ add, drop, set, strip }) =>
        chrome.storage.sync.get("bt_keywords").then((r) => {
          const k = { ...(r.bt_keywords || { list: [] }) };
          for (const f of [].concat(strip || [])) delete k[f];
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

  // The Subscriptions rules travel the same way — and survive a device that
  // has never heard of them: an older version writes its record without the
  // fields, and must not take the rules away from everyone else.
  const SUBS = ["subsMaxAgeDays", "subsHideWatched", "subsHideUpcoming"];
  const subsOf = (k) => SUBS.map((f) => k[f]);
  await editKw(A, { set: { subsMaxAgeDays: 7, subsHideWatched: true, subsHideUpcoming: true } });
  await settle(A, B);
  const reached = subsOf(await kwOf(B));
  await editKw(B, { add: "from-older-b", strip: SUBS });
  await settle(B, A);
  const [kwA3, kwB3] = [await kwOf(A), await kwOf(B)];
  const want = JSON.stringify([7, true, true]);
  JSON.stringify(reached) === want && JSON.stringify(subsOf(kwA3)) === want && JSON.stringify(subsOf(kwB3)) === want &&
  kwA3.list.some((k) => k.p === "from-older-b")
    ? ok("A's Subscriptions rules (7 days, hide watched, hide upcoming) reach B, and a record written without them (an older device's) doesn't erase them")
    : fail(`Subscriptions rules: reached B as ${JSON.stringify(reached)}; then A=${JSON.stringify(kwA3)} B=${JSON.stringify(kwB3)}`);

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

  // ---- …and pulls nothing either: an idle poll is a 304 ----
  // The document is the whole list, and every device polls every 3 minutes:
  // pulling it each time cost a real list ~150MB a day through the server.
  const stateGets = (from) =>
    [...serverLog.slice(from).matchAll(/"GET \/xrntube\/state(?:\?\S*)? HTTP\/1\.1" (\d{3})/g)].map((m) => m[1]);
  const logSettles = () => new Promise((r) => setTimeout(r, 300));
  let mark = serverLog.length;
  await settle(A, B);
  await logSettles();
  let gets = stateGets(mark);
  gets.length >= 8 && gets.every((c) => c === "304")
    ? ok(`an idle round is answered "not modified" — ${gets.length} pulls, no list sent`)
    : fail(`idle pulls answered: ${gets.join(" ") || "none"}`);

  // ---- a poll alongside a pull adds nothing ----
  // The poll alarm mostly finds the worker stopped, and starting it runs
  // init(), which pulls; the alarm's onPoll() then queued a second pull behind
  // that one, and the server's log had every poll fetching the list twice. The
  // same shape without a cold start's timing (which a test can't pin down): a
  // pull under way, and a poll.
  mark = serverLog.length;
  await A.ctx.serviceWorkers()[0].evaluate(async () => {
    const s = self.XrnTube.serverSync;
    await Promise.all([s.syncNow(), s.onPoll()]);
    await new Promise((r) => setTimeout(r, 500)); // a queued rerun would pull in here
  });
  await logSettles();
  gets = stateGets(mark);
  gets.length === 1
    ? ok(`a poll that arrives with a pull under way doesn't pull again (${gets[0]})`)
    : fail(`a pull and a poll together pulled ${gets.length} times: ${gets.join(" ")}`);
  // B has pulled "not modified" all this while; A's change below must still
  // reach it — the version moved, so the server sends the document.

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

  // ---- a page on another site can't write with the browser's password ----
  // A browser once given the password in its own box sends it with whatever
  // another site's page sends here. The extension's requests come from another
  // origin too (it holds no host permission for the server: the syncing above
  // went out as cross-site, from chrome-extension://), and must still go.
  // If-Match names a version the server isn't at: one let through gets 412.
  const putFrom = (h) =>
    fetch(`${URL_}/state`, {
      method: "PUT",
      headers: {
        Authorization: "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64"),
        "If-Match": '"999999"',
        "Content-Type": "text/plain",
        ...h
      },
      body: '{"channels":{}}'
    }).then((r) => r.status);
  const fromElsewhere = await Promise.all(
    [
      { "Sec-Fetch-Site": "cross-site", Origin: "https://evil.example" },
      { "Sec-Fetch-Site": "same-site", Origin: "https://other.homeserver.example" },
      { Origin: "https://evil.example" } // a browser from before Sec-Fetch-Site
    ].map(putFrom)
  );
  const fromOurs = await Promise.all(
    [
      { "Sec-Fetch-Site": "cross-site", Origin: "chrome-extension://abcdefghijklmnop" },
      { "Sec-Fetch-Site": "cross-site", Origin: "moz-extension://8c2f5e7a-0000-4000-8000-000000000000" },
      { Origin: `http://127.0.0.1:${PORT}` },
      { Origin: "https://homeserver.example", "X-Forwarded-Host": "homeserver.example" },
      {}
    ].map(putFrom)
  );
  fromElsewhere.every((s) => s === 403) && fromOurs.every((s) => s === 412)
    ? ok("a PUT from another site's page is refused (403); the extensions', this host's and an app's go on")
    : fail(`cross-site PUT: from elsewhere ${fromElsewhere} (want 403s), from ours ${fromOurs} (want 412s)`);

  // ---- a connection that goes quiet is let go ----
  // With no socket timeout, a client that stopped half way through its request
  // held a thread for good. Two minutes is too long to wait for here, so the
  // handler's setting is read instead.
  const quietS = Number(
    execFileSync("python3", [
      "-c",
      "import importlib.util as u, sys\ns = u.spec_from_file_location('s', sys.argv[1])\nm = u.module_from_spec(s)\ns.loader.exec_module(m)\nprint(m.Handler.timeout)",
      join(EXT_PATH, "server/xrntube-sync.py")
    ]).toString()
  );
  quietS > 0 && quietS <= 600
    ? ok(`a connection that goes quiet is dropped after ${quietS} s`)
    : fail(`the server's socket timeout is ${quietS}: a stalled client holds a thread for good`);

  // ---- a gzipped PUT is inflated with the same limit as a plain one ----
  // The limit (32 MB) was checked on the compressed length only, so a few KB
  // of gzip inflated to whatever they held, in memory; and a body that wasn't
  // gzip at all raised in the handler, which dropped the connection with no
  // reply. If-Match names a version the server isn't at, so nothing is stored
  // either way: before, both got as far as that check or died on the way.
  const put = (body) =>
    fetch(`${URL_}/state`, {
      method: "PUT",
      headers: {
        Authorization: "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64"),
        "Content-Encoding": "gzip",
        "If-Match": '"999999"'
      },
      body
    }).then((r) => r.status, (e) => "no reply: " + ((e.cause && e.cause.code) || e.message));
  const notGzip = await put(Buffer.from('{"channels":{}}'));
  const bomb = await put(gzipSync(Buffer.from(JSON.stringify({ pad: "x".repeat(33 * 1024 * 1024) }))));
  const fits = await put(gzipSync(Buffer.from('{"channels":{}}')));
  notGzip === 400 && bomb === 413 && fits === 412
    ? ok("a PUT marked gzip that isn't is answered 400, one that inflates past 32 MB is refused (413), and a real one goes on to the version check")
    : fail(`gzipped PUT: not gzip ${notGzip} (want 400), 33 MB inflated ${bomb} (want 413), a real one ${fits} (want 412)`);

  // Last, since it locks this address out: ten wrong passwords (sent at once, each held 2 s) and
  // even the right one gets 429 for 15 minutes. Basic auth from a loopback peer with a forwarded
  // address counts against that address, as behind Tailscale Funnel.
  const basic = (u, pw) => ({ Authorization: "Basic " + Buffer.from(`${u}:${pw}`).toString("base64") });
  const state = (h) => fetch(`${URL_}/state`, { headers: h }).then((r) => r.status);
  const fwd = { "X-Forwarded-For": "203.0.113.7" };
  const wrong = await Promise.all(Array.from({ length: 10 }, () => state({ ...basic(USER, "nope"), ...fwd })));
  const lockedRight = await state({ ...basic(USER, PASS), ...fwd });
  const otherAddr = await state({ ...basic(USER, PASS), "X-Forwarded-For": "203.0.113.8" });
  wrong.every((s) => s === 401) && lockedRight === 429 && otherAddr === 200
    ? ok("ten wrong passwords lock that address out (429 even for the right one); other addresses still sign in")
    : fail(`lockout: wrong ${wrong}, then right ${lockedRight}, other address ${otherAddr}`);

  // The count was checked before bcrypt and added to after it, on a server
  // that runs each request in its own thread: thirty guesses sent at once all
  // got past a count of zero, and all thirty were checked.
  const burst = await Promise.all(
    Array.from({ length: 30 }, () => state({ ...basic(SLOW_USER, "guess"), "X-Forwarded-For": "203.0.113.9" }))
  );
  const checked = burst.filter((s) => s === 401).length;
  const turnedAway = burst.filter((s) => s === 429).length;
  checked === 10 && turnedAway === 20
    ? ok("thirty wrong passwords sent at once from one address: ten are checked, the other twenty turned away (429)")
    : fail(`thirty wrong passwords at once: ${checked} checked (401), ${turnedAway} turned away (429)`);

  // The count is kept for the hop the proxy itself added, the last one. A proxy that appends
  // passes the caller's own header on in front, and counted by that, each guess came from a new
  // "address" and none was ever turned away.
  const guessFrom = (forwarded, n) => state({ ...basic(USER, "nope" + n), "X-Forwarded-For": forwarded });
  const madeUp = await Promise.all(Array.from({ length: 11 }, (_, i) => guessFrom(`198.51.100.${i}, 203.0.113.20`, i)));
  madeUp.filter((s) => s === 401).length === 10 && madeUp.filter((s) => s === 429).length === 1
    ? ok("a made-up hop in front of the proxy's own doesn't make each guess a new address")
    : fail(`eleven guesses, each with its own made-up first hop: ${madeUp}`);

  // An IPv6 line has a /64 of addresses to guess from, so it is counted as one.
  const sixes = await Promise.all(Array.from({ length: 11 }, (_, i) => guessFrom(`2001:db8:1:2::${(i + 1).toString(16)}`, i)));
  const nextDoor = await guessFrom("2001:db8:1:3::1", 0);
  sixes.filter((s) => s === 401).length === 10 && sixes.filter((s) => s === 429).length === 1 && nextDoor === 401
    ? ok("an IPv6 guesser is counted as its /64, and the /64 next door isn't held")
    : fail(`eleven guesses from one IPv6 /64: ${sixes}; the /64 next door: ${nextDoor}`);

} catch (e) {
  fail(e.stack || String(e));
} finally {
  await A?.ctx.close().catch(() => {});
  await B?.ctx.close().catch(() => {});
  server.kill();
  if (process.exitCode) console.log("server log:\n" + serverLog.slice(-1500));
}
console.log("\nDONE");
