// Packs the extension for a browser that doesn't load it from this folder.
//
//   node scripts/package.mjs                     dist/xrntube-<version>.zip, for
//                                                a store upload or loading by hand
//   node scripts/package.mjs --upload homeserver  …and copy it to the sync
//                                                server's downloads over ssh
//   node scripts/package.mjs --release           (npm run release) sign
//       dist/xrntube-<version>.crx and publish it with dist/updates.xml on the
//       sync server, where every browser that installed the .crx looks for new
//       versions on its own. A version the server already has is bumped first;
//       one older than the server's stops the release (scripts/crx.mjs →
//       releaseVersion). Only from master with nothing left uncommitted
//       (--force releases this tree anyway).
//
// --release reads ~/.config/xrntube/release.json:
//   { "server": "https://<host>/xrntube", "ssh": "<ssh-host>" }
// ("ssh" may list several ways to the same server, tried in order — say the
// tailnet, then the LAN) and signs with ~/.config/xrntube/xrntube.pem, made
// only on a first release (--new-key). Neither belongs in the repo: the
// address never enters it, and the key is what makes an update the same
// extension — lose it and every phone has to install afresh under a new ID
// (with empty storage until sync refills it). A key whose ID isn't the one
// the server's updates.xml (or the last one written to dist/) names stops the
// release before anything is sent.
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync } from "fs";
import { join, relative } from "path";
import { homedir } from "os";
import { execFileSync } from "child_process";
import { packageFiles, withUpdateUrl, zip, crx3, extensionId, updateManifest, releaseVersion } from "./crx.mjs";
import { treeRefusals, signingKey, idRefusal, appIdOf } from "./release-guard.mjs";

const ROOT = new URL("..", import.meta.url).pathname;
const MANIFEST = join(ROOT, "manifest.json");
const DIST = join(ROOT, "dist");
const CONFIG_DIR = join(homedir(), ".config", "xrntube");
const REMOTE_DIR = "xrntube-sync/data"; // the sync server's --data, from the ssh login's home
const arg = (name) => process.argv.indexOf(name);

const version = () => JSON.parse(readFileSync(MANIFEST, "utf8")).version;
mkdirSync(DIST, { recursive: true });

function buildZip() {
  const out = join(DIST, `xrntube-${version()}.zip`);
  const files = packageFiles(ROOT);
  writeFileSync(out, zip(files));
  console.log(`${relative(ROOT, out)}: ${files.length} files, ${Math.round(statSync(out).size / 1024)} KB`);
  return out;
}

const ssh = (host, command, input) => execFileSync("ssh", [host, command], { input, stdio: [input ? "pipe" : "ignore", "inherit", "inherit"] });

if (arg("--release") > 0) {
  await release();
} else {
  const out = buildZip();
  const at = arg("--upload");
  if (at > 0) {
    const host = process.argv[at + 1];
    if (!host) throw new Error("--upload needs an ssh host");
    // Two names: the versioned file, and a stable one a phone can bookmark.
    for (const name of [`xrntube-${version()}.zip`, "xrntube.zip"]) {
      ssh(host, `cat > ${REMOTE_DIR}/downloads/${name}`, readFileSync(out));
    }
    console.log(`uploaded to ${host}: …/xrntube/download/xrntube-${version()}.zip and …/download/xrntube.zip`);
  }
}

async function release() {
  const flags = new Set(process.argv.slice(2).filter((a) => a.startsWith("--")));
  if ([...flags].some((f) => !["--release", "--force", "--new-key"].includes(f))) {
    console.error("usage: node scripts/package.mjs --release [--force] [--new-key]");
    process.exit(2);
  }
  const refusals = treeRefusals(ROOT);
  if (refusals.length && !flags.has("--force")) {
    console.error(`Not released: ${refusals.join("\n")}\n(--force releases this tree anyway)`);
    process.exit(1);
  }
  const stop = (message) => {
    console.error(`Not released: ${message}`);
    process.exit(1);
  };

  const configFile = join(CONFIG_DIR, "release.json");
  if (!existsSync(configFile)) {
    console.error(`No ${configFile}. Create it with the sync server's public address and its ssh host:
  { "server": "https://<host>/xrntube", "ssh": "<ssh-host>" }`);
    process.exit(1);
  }
  const { server: rawServer, ssh: hosts } = JSON.parse(readFileSync(configFile, "utf8"));
  const server = String(rawServer || "").replace(/\/+$/, "");
  const tried = [].concat(hosts || []);
  if (!/^https:\/\/[^/]+/.test(server) || !tried.length) throw new Error(`${configFile} needs "server" (https://…) and "ssh"`);

  // The key and the ID it signs as, before the server is reached. A key made
  // just now, asked for with --new-key, is a new ID on purpose.
  const keyFile = join(CONFIG_DIR, "xrntube.pem");
  const made = !existsSync(keyFile);
  let key;
  try {
    key = signingKey(keyFile, flags.has("--new-key"));
  } catch (err) {
    stop(err.message);
  }
  const id = extensionId(key);
  const checkId = (xml, where) => {
    const refusal = idRefusal(id, xml, where);
    if (refusal && !made) stop(refusal);
    if (refusal) console.warn(`--new-key: ${where} named ${appIdOf(xml)}; copies installed under it won't update.`);
  };
  // What the last release from this checkout published.
  const lastXml = join(DIST, "updates.xml");
  if (existsSync(lastXml)) checkId(readFileSync(lastXml, "utf8"), relative(ROOT, lastXml));

  // Found before anything is bumped, so an unreachable server changes nothing.
  const host = tried.find((h) => {
    try {
      execFileSync("ssh", ["-o", "ConnectTimeout=8", "-o", "BatchMode=yes", h, "true"], { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  });
  if (!host) throw new Error(`no ssh host in ${configFile} answers: ${tried.join(", ")}`);
  console.log(`publishing over ssh to ${host}`);

  // A browser only takes a version newer than the one it has, so publishing
  // the same number twice would reach nobody: that one is bumped. A server
  // already past this checkout, or naming another extension ID, stops the
  // release here, before anything is built or changed.
  const { version: live, xml: liveXml } = await liveUpdates(server);
  checkId(liveXml, `${server}/update/updates.xml`);
  let plan;
  try {
    plan = releaseVersion(live, version());
  } catch (err) {
    console.error(err.message);
    process.exit(1);
  }
  if (plan.bumped) {
    const text = readFileSync(MANIFEST, "utf8");
    writeFileSync(MANIFEST, text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${plan.version}$2`));
    console.log(`the server already has ${live}: manifest.json is now ${plan.version}`);
  }
  const v = version();

  buildZip();
  const updateUrl = `${server}/update/updates.xml`;
  const crx = crx3(zip(withUpdateUrl(packageFiles(ROOT), updateUrl)), key);
  const crxName = `xrntube-${v}.crx`;
  writeFileSync(join(DIST, crxName), crx);
  const xml = updateManifest({ id, version: v, codebase: `${server}/update/${crxName}`, crx });
  writeFileSync(join(DIST, "updates.xml"), xml);
  console.log(`dist/${crxName}: ${Math.round(crx.length / 1024)} KB, extension ID ${id}`);

  // The .crx files first and updates.xml last, each written beside its final
  // name and moved into place, so a browser never reads a half-written file
  // or a manifest pointing at a .crx that isn't there yet.
  const put = (name, data) => ssh(host, `cat > ${REMOTE_DIR}/update/${name}.part && mv ${REMOTE_DIR}/update/${name}.part ${REMOTE_DIR}/update/${name}`, data);
  ssh(host, `mkdir -p ${REMOTE_DIR}/update`);
  put(crxName, crx);
  put("xrntube.crx", crx); // the stable link a new install starts from
  put("updates.xml", Buffer.from(xml));
  ssh(host, `cd ${REMOTE_DIR}/update && for f in xrntube-*.crx; do [ "$f" = ${crxName} ] || rm -f "$f"; done`);

  const { version: now } = await liveUpdates(server);
  if (now !== v) throw new Error(`uploaded, but ${updateUrl} says ${now || "nothing"} — is the server's /update/ route deployed?`);
  console.log(`published ${v}. Browsers with the .crx pick it up within hours, or at once from options → Sync → Check now.
First install on a new device: ${server}/update/xrntube.crx`);
}

// The server's updates.xml: its text and the version it offers (both null
// before the first release).
async function liveUpdates(server) {
  const res = await fetch(`${server}/update/updates.xml`, { cache: "no-store" });
  if (res.status === 404) return { version: null, xml: null };
  if (!res.ok) throw new Error(`${server}/update/updates.xml answered ${res.status}`);
  const xml = await res.text();
  const m = /updatecheck[^>]*\sversion='([^']+)'/.exec(xml);
  return { version: m ? m[1] : null, xml };
}
