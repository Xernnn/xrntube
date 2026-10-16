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

try {
  const A = await device("A");
  const B = await device("B");

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

  await A.ctx.close();
  await B.ctx.close();
} catch (e) {
  fail(e.stack || String(e));
} finally {
  server.kill();
  if (process.exitCode) console.log("server log:\n" + serverLog.slice(-1500));
}
console.log("\nDONE");
