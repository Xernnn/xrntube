import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join, dirname } from "path";
import { createHash, createPublicKey, generateKeyPairSync, verify } from "crypto";
import { inflateRawSync } from "zlib";
import { chromium } from "playwright";
import { packageFiles, withUpdateUrl, zip, crx3, extensionId, updateManifest, compareVersions, CRX3_SIGNED_PREFIX } from "../scripts/crx.mjs";

// The extension updating itself, offline:
//   - the signed .crx `npm run release` builds: a CRX3 header whose
//     signature verifies over the zip, an ID derived from the key, every
//     shipped file inside, update_url in its manifest (and not in the zip's),
//     and an updates.xml that names that ID, version and file
//   - an unpacked copy (the laptop) reloads itself when its folder's manifest
//     names another version: from options → Sync → Check now, and from the
//     check every start of the worker makes; a check with nothing new is a
//     no-op; the hourly alarm survives the worker restarting
//   - …and after a browser restart, when the folder moved on while it was
//     closed: the browser runs the old worker code under the new manifest
// The phone half (a browser installing the .crx and taking an update from
// the server) needs a real update server and browser; see test/README.md.

const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const dir = mkdtempSync(join(tmpdir(), "xt-update-"));

// ---- 1. the .crx ----
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const UPDATE_URL = "https://example.invalid/xrntube/update/updates.xml";
const shipped = packageFiles(EXT_PATH);
const zipBuf = zip(withUpdateUrl(shipped, UPDATE_URL));
const crx = crx3(zipBuf, privateKey);

// Just enough protobuf to read the header back: { field: [bytes…] }.
function fields(buf) {
  const out = {};
  let i = 0;
  const varint = () => {
    let n = 0;
    let shift = 0;
    let b;
    do {
      b = buf[i++];
      n += (b & 127) * 2 ** shift;
      shift += 7;
    } while (b & 128);
    return n;
  };
  while (i < buf.length) {
    const key = varint();
    if ((key & 7) !== 2) throw new Error("unexpected wire type " + (key & 7));
    const len = varint();
    (out[Math.floor(key / 8)] ||= []).push(buf.subarray(i, i + len));
    i += len;
  }
  return out;
}
// The central directory, inflated: { name: bytes }.
function unzip(buf) {
  const files = {};
  let at = buf.length - 22;
  const count = buf.readUInt16LE(at + 10);
  let p = buf.readUInt32LE(at + 16);
  for (let n = 0; n < count; n++) {
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString();
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    files[name] = inflateRawSync(buf.subarray(start, start + size));
    p += 46 + nameLen + extra + comment;
  }
  return files;
}

try {
  const headerLen = crx.readUInt32LE(8);
  const header = fields(crx.subarray(12, 12 + headerLen));
  const payload = crx.subarray(12 + headerLen);
  const proof = fields(header[2][0]);
  const pub = proof[1][0];
  const sig = proof[2][0];
  const signedData = header[10000][0];
  const crxId = fields(signedData)[1][0];
  const len = Buffer.alloc(4);
  len.writeUInt32LE(signedData.length);
  const verified = verify("sha256", Buffer.concat([CRX3_SIGNED_PREFIX, len, signedData, payload]), createPublicKey({ key: pub, format: "der", type: "spki" }), sig);
  const idFromPub = [...createHash("sha256").update(pub).digest().subarray(0, 16).toString("hex")].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");
  crx.subarray(0, 4).toString() === "Cr24" &&
  crx.readUInt32LE(4) === 3 &&
  verified &&
  crxId.equals(createHash("sha256").update(pub).digest().subarray(0, 16)) &&
  idFromPub === extensionId(privateKey) &&
  payload.equals(zipBuf)
    ? ok(`a CRX3 whose signature verifies over the zip, for ID ${idFromPub} (the key's)`)
    : fail(`crx header: magic=${crx.subarray(0, 4)} v=${crx.readUInt32LE(4)} verified=${verified} id=${idFromPub}/${extensionId(privateKey)}`);

  const inside = unzip(payload);
  const m = JSON.parse(inside["manifest.json"]);
  const plain = JSON.parse(unzip(zip(shipped))["manifest.json"]);
  const sameFiles = shipped.every(([name, data]) => name === "manifest.json" || (inside[name] && inside[name].equals(data)));
  Object.keys(inside).length === shipped.length && sameFiles && m.update_url === UPDATE_URL && !plain.update_url && m.version === plain.version
    ? ok(`all ${shipped.length} shipped files inside, byte for byte; update_url in the .crx's manifest and not in the zip's`)
    : fail(`crx contents: ${Object.keys(inside).length}/${shipped.length} files, same=${sameFiles}, update_url=${m.update_url}, zip's=${plain.update_url}`);

  const xml = updateManifest({ id: extensionId(privateKey), version: m.version, codebase: "https://example.invalid/xrntube/update/x.crx", crx });
  xml.includes(`appid='${extensionId(privateKey)}'`) &&
  xml.includes(`version='${m.version}'`) &&
  xml.includes(`codebase='https://example.invalid/xrntube/update/x.crx'`) &&
  xml.includes(`hash_sha256='${createHash("sha256").update(crx).digest("hex")}'`)
    ? ok("updates.xml names the ID, the version, the .crx and its hash")
    : fail("updates.xml: " + xml);

  compareVersions("2.1.0", "2.0.13") > 0 && compareVersions("2.1", "2.1.0") === 0 && compareVersions("2.0.9", "2.0.10") < 0
    ? ok("versions compare numerically, part by part")
    : fail("compareVersions");
} catch (e) {
  fail(e.stack || String(e));
}

// ---- 2. an unpacked copy reloads itself ----
// A copy in a temp folder, so the test can change its manifest.
const extDir = join(dir, "ext");
for (const [name, data] of shipped) {
  mkdirSync(dirname(join(extDir, name)), { recursive: true });
  writeFileSync(join(extDir, name), data);
}
const setVersion = (v) => {
  const file = join(extDir, "manifest.json");
  writeFileSync(file, readFileSync(file, "utf8").replace(/("version"\s*:\s*")[^"]*(")/, `$1${v}$2`));
};
// Chromium disables an unpacked extension that reloads while developer mode is
// off ("unsupportedDeveloperExtension"). A browser it was loaded into by hand
// has it on — Load unpacked needs it — so this profile does too.
mkdirSync(join(dir, "profile", "Default"), { recursive: true });
writeFileSync(join(dir, "profile", "Default", "Preferences"), JSON.stringify({ extensions: { ui: { developer_mode: true } } }));
let ctx = await chromium.launchPersistentContext(join(dir, "profile"), {
  headless: false,
  args: [`--disable-extensions-except=${extDir}`, `--load-extension=${extDir}`, "--headless=new", "--no-sandbox"]
});
// The current worker: after a reload the old one is gone and a new one comes.
// Asking a worker that has just gone can hang rather than throw, hence the race.
const versionOf = (w) =>
  Promise.race([w.evaluate(() => chrome.runtime.getManifest().version), new Promise((r) => setTimeout(r, 1000, null))]).catch(() => null);
const worker = async () => {
  for (let i = 0; i < 100; i++) {
    for (const w of ctx.serviceWorkers()) {
      const v = await versionOf(w);
      if (v) return { w, v };
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return { w: null, v: null };
};
const waitForVersion = async (want) => {
  for (let i = 0; i < 50; i++) {
    const { w, v } = await worker();
    if (v === want) return w;
    await new Promise((r) => setTimeout(r, 200));
  }
  return null;
};
// Stop the worker; the next message starts a fresh one, as on a real wake.
const restartWorker = async (page) => {
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("ServiceWorker.enable").catch(() => {});
  await cdp.send("ServiceWorker.stopAllWorkers").catch(() => {});
  await page.evaluate(() => chrome.runtime.sendMessage({ type: "GET_SYNC_STATUS" }).catch(() => null));
};
try {
  const { w: sw, v: v0 } = await worker();
  const extId = sw.url().split("/")[2];

  // The worker starts far more often than hourly; an alarm made again on
  // every start would keep moving and never fire.
  const alarm0 = await sw.evaluate(() => chrome.alarms.get("bt-update-check"));
  await sw.evaluate(() => (self.btTestMark = true));
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${extId}/popup/popup.html`);
  await restartWorker(popup);
  const { w: swAgain } = await worker();
  const restarted = !(await swAgain.evaluate(() => self.btTestMark));
  const alarm1 = await swAgain.evaluate(() => chrome.alarms.get("bt-update-check"));
  restarted && alarm0 && alarm1 && alarm0.periodInMinutes === 60 && alarm1.scheduledTime === alarm0.scheduledTime
    ? ok("the hourly update alarm is made once and keeps its schedule when the worker restarts")
    : fail(`update alarm: restarted=${restarted} before=${JSON.stringify(alarm0)} after=${JSON.stringify(alarm1)}`);

  const p = await ctx.newPage();
  await p.goto(`chrome-extension://${extId}/options/options.html`);
  await p.locator(".page-tab[data-page='sync']").click();
  const blurb = await p.locator("#update-blurb").innerText();
  await p.locator("#update-check").click();
  await p.locator("#update-result:not([hidden])").filter({ hasNotText: "Checking" }).waitFor({ timeout: 5000 });
  const result0 = await p.locator("#update-result").innerText();
  blurb.includes(`Version ${v0}`) && /loaded unpacked/.test(blurb) && result0 === "Up to date."
    ? ok(`options → Sync → Updates says it's v${v0}, loaded unpacked; Check now with nothing new says "Up to date."`)
    : fail(`updates card: blurb=${JSON.stringify(blurb)} result=${JSON.stringify(result0)}`);

  setVersion("9.9.9");
  await p.locator("#update-check").click();
  // Read before the reload closes the page (the reply comes 250ms ahead of it).
  const said = await p.locator("#update-result").filter({ hasText: "reloading" }).innerText({ timeout: 3000 }).catch(() => "(no reply before the page closed)");
  const sw1 = await waitForVersion("9.9.9");
  sw1 && /9\.9\.9.*reloading/.test(said)
    ? ok(`a new version in the folder: Check now says ${JSON.stringify(said)} and the worker comes back as 9.9.9`)
    : fail(`reload from Check now: said=${JSON.stringify(said)}, running=${(await worker()).v}`);

  // Nothing clicked this time: a worker that starts finds the new version on
  // its own.
  setVersion("9.9.10");
  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${extId}/popup/popup.html`);
  await restartWorker(page);
  const sw2 = await waitForVersion("9.9.10");
  sw2
    ? ok("with nothing clicked, the next start of the worker sees 9.9.10 in the folder and reloads into it")
    : fail(`reload on worker start: running=${(await worker()).v}`);
} catch (e) {
  fail(e.stack || String(e));
} finally {
  await ctx.close().catch(() => {});
}

// ---- 3. a release made while the browser was closed ----
// The browser keeps the worker code it registered when the extension loaded
// and runs it again after a restart, while the manifest it loads is the
// folder's: getManifest() names the new version and the old code runs on.
// The laptop's is a "Load unpacked" install, which a test can't click through
// (it opens a folder picker), so the --load-extension one becomes one: its
// location in Preferences turns 4 (unpacked) and the browser starts without
// the flag.
try {
  const prefsFile = join(dir, "profile", "Default", "Preferences");
  const prefs = JSON.parse(readFileSync(prefsFile, "utf8"));
  Object.values(prefs.extensions.settings).find((e) => e.path === extDir).location = 4;
  writeFileSync(prefsFile, JSON.stringify(prefs));
  setVersion("9.9.11");
  const bg = join(extDir, "background", "background.js");
  writeFileSync(bg, readFileSync(bg, "utf8") + '\nself.btTestBuild = "9.9.11";\n');
  ctx = await chromium.launchPersistentContext(join(dir, "profile"), {
    headless: false,
    ignoreDefaultArgs: ["--disable-extensions"],
    args: ["--headless=new", "--no-sandbox"]
  });
  const buildOf = (w) =>
    Promise.race([w.evaluate(() => self.btTestBuild || null), new Promise((r) => setTimeout(r, 1000, null))]).catch(() => null);
  let build = null;
  for (let i = 0; i < 50 && !build; i++) {
    for (const w of ctx.serviceWorkers()) build = build || (await buildOf(w));
    if (!build) await new Promise((r) => setTimeout(r, 200));
  }
  build === "9.9.11"
    ? ok("a version that landed while the browser was closed: the worker finds its code older than the folder and reloads into it")
    : fail(`after a restart the worker still runs the old code (running ${(await worker()).v}, new code ${build ? "running" : "not running"})`);
} catch (e) {
  fail(e.stack || String(e));
} finally {
  await ctx.close().catch(() => {});
  rmSync(dir, { recursive: true, force: true }); // a browser profile and a copy of the extension, ~7MB
}
console.log("\nDONE");
