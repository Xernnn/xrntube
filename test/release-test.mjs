import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync, statSync, rmSync, chmodSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { execFileSync, spawnSync } from "child_process";
import { generateKeyPairSync, createPrivateKey } from "crypto";
import { extensionId, updateManifest } from "../scripts/crx.mjs";
import { treeRefusals, signingKey, appIdOf, idRefusal } from "../scripts/release-guard.mjs";

// What stops `npm run release` before it builds or uploads anything, in pure
// Node with no network: scripts/release-guard.mjs on its own, then the real
// scripts/package.mjs --release run in a throwaway copy of the repo, with a
// throwaway HOME and an `ssh` that only records what it was asked.
//   - a release is made from master with everything committed (--force
//     releases anyway)
//   - the signing key is never made because the file is missing, only with
//     --new-key, and an existing one is never replaced: a key made on the spot
//     published a new extension ID, and every installed copy stopped updating
//   - a key whose ID isn't the one the last updates.xml names stops it

const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);

const ROOT = new URL("..", import.meta.url).pathname;
const dir = mkdtempSync(join(tmpdir(), "xt-release-"));
const gitIn = (repo, ...args) =>
  execFileSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@example.invalid", ...args], { stdio: "pipe" });

try {
  // ---- 1. the tree ----
  {
    const repo = join(dir, "tree");
    mkdirSync(repo);
    gitIn(repo, "init", "-q", "-b", "master");
    writeFileSync(join(repo, "a.txt"), "1");
    gitIn(repo, "add", "a.txt");
    gitIn(repo, "commit", "-q", "-m", "one");
    const clean = treeRefusals(repo);
    writeFileSync(join(repo, "a.txt"), "2");
    const edited = treeRefusals(repo);
    gitIn(repo, "checkout", "-q", "-b", "topic");
    const branch = treeRefusals(repo);
    gitIn(repo, "checkout", "-q", "--", "a.txt");
    gitIn(repo, "checkout", "-q", "master");
    writeFileSync(join(repo, "new.js"), "");
    const added = treeRefusals(repo);
    !clean.length && edited.length === 1 && branch.length === 2 && /topic/.test(branch.join()) && added.length === 1
      ? ok("a release is made from master with everything committed: an edit, another branch and a file not added are each refused")
      : fail("tree refusals: " + JSON.stringify({ clean, edited, branch, added }));
  }

  // ---- 2. the key ----
  {
    const file = join(dir, "keys", "xrntube.pem");
    mkdirSync(join(dir, "keys"));
    let refused = null;
    try {
      signingKey(file);
    } catch (err) {
      refused = err.message;
    }
    const pem = (k) => k.export({ type: "pkcs8", format: "pem" });
    const made = signingKey(file, true);
    const mode = statSync(file).mode & 0o777;
    const again = signingKey(file);
    const notReplaced = signingKey(file, true);
    /xrntube\.pem/.test(refused || "") && /--new-key/.test(refused) && mode === 0o600 && pem(again) === pem(made) && pem(notReplaced) === pem(made)
      ? ok("no key file: refused, naming the file and --new-key; with --new-key one is made (0600), and an existing key is read, never replaced")
      : fail("signing key: " + JSON.stringify({ refused, mode: mode.toString(8), same: pem(again) === pem(made), kept: pem(notReplaced) === pem(made) }));
  }

  // ---- 3. the ID updates.xml names ----
  {
    const a = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const b = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    const xml = updateManifest({ id: extensionId(a), version: "2.1.10", codebase: "https://example.invalid/x.crx", crx: Buffer.from("x") });
    appIdOf(xml) === extensionId(a) && !idRefusal(extensionId(a), xml, "updates.xml") && /updates\.xml names extension ID/.test(idRefusal(extensionId(b), xml, "updates.xml") || "") && !idRefusal(extensionId(b), null, "updates.xml")
      ? ok("updates.xml's appid is read back; another key's ID is refused, the same key's and no updates.xml at all are not")
      : fail("ID check: " + JSON.stringify({ read: appIdOf(xml), same: idRefusal(extensionId(a), xml, "x"), other: idRefusal(extensionId(b), xml, "x") }));
  }

  // ---- 4. the real script, in a throwaway copy ----
  // A copy of what --release reads (the script, its two modules and the
  // manifest), committed on master; HOME with a release.json whose server
  // refuses connections at once; and an ssh that answers the reachability
  // probe and records every call. The old script found the ssh host, made a
  // key because there was none, and only then asked the server.
  const repo = join(dir, "repo");
  mkdirSync(join(repo, "scripts"), { recursive: true });
  for (const f of ["scripts/package.mjs", "scripts/crx.mjs", "scripts/release-guard.mjs", "manifest.json", ".gitignore"]) {
    if (existsSync(join(ROOT, f))) copyFileSync(join(ROOT, f), join(repo, f));
  }
  gitIn(repo, "init", "-q", "-b", "master");
  gitIn(repo, "add", ".");
  gitIn(repo, "commit", "-q", "-m", "copy");
  const home = join(dir, "home");
  const config = join(home, ".config", "xrntube");
  mkdirSync(config, { recursive: true });
  writeFileSync(join(config, "release.json"), JSON.stringify({ server: "https://127.0.0.1:1/xrntube", ssh: "fake-host" }));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  const sshLog = join(dir, "ssh.log");
  writeFileSync(join(bin, "ssh"), `#!/bin/sh\necho "$@" >> "${sshLog}"\nfor a in "$@"; do last="$a"; done\n[ "$last" = true ] && exit 0\nexit 255\n`);
  chmodSync(join(bin, "ssh"), 0o755);
  const keyFile = join(config, "xrntube.pem");
  const release = (...flags) => {
    rmSync(sshLog, { force: true });
    const r = spawnSync("node", [join(repo, "scripts/package.mjs"), "--release", ...flags], {
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
      encoding: "utf8"
    });
    return { status: r.status, out: (r.stdout || "") + (r.stderr || ""), ssh: existsSync(sshLog) ? readFileSync(sshLog, "utf8") : "" };
  };

  {
    const r = release();
    r.status !== 0 && /xrntube\.pem/.test(r.out) && /--new-key/.test(r.out) && !existsSync(keyFile) && !r.ssh
      ? ok("--release with no key file stops before reaching the server, makes no key, and says --new-key is for a first release")
      : fail("release with no key: " + JSON.stringify({ ...r, keyMade: existsSync(keyFile) }));
  }

  {
    writeFileSync(join(repo, "manifest.json"), readFileSync(join(repo, "manifest.json"), "utf8") + " ");
    const r = release("--new-key");
    gitIn(repo, "checkout", "-q", "--", "manifest.json");
    r.status !== 0 && /not committed/.test(r.out) && !existsSync(keyFile) && !r.ssh
      ? ok("…and a tree with an uncommitted edit is refused before anything else")
      : fail("release from a dirty tree: " + JSON.stringify({ ...r, keyMade: existsSync(keyFile) }));
  }

  {
    const r = release("--new-key");
    const made = existsSync(keyFile);
    made && (statSync(keyFile).mode & 0o777) === 0o600 && /made a signing key/.test(r.out) && r.status !== 0 && /fake-host true/.test(r.ssh) && !/cat >/.test(r.ssh)
      ? ok("with --new-key the key is made (0600), and the release goes on to the server (unreachable here, so nothing is sent)")
      : fail("release --new-key: " + JSON.stringify({ ...r, made }));
  }

  {
    const before = readFileSync(keyFile, "utf8");
    const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
    mkdirSync(join(repo, "dist"), { recursive: true });
    writeFileSync(
      join(repo, "dist", "updates.xml"),
      updateManifest({ id: extensionId(other), version: "2.1.10", codebase: "https://example.invalid/x.crx", crx: Buffer.from("x") })
    );
    const r = release();
    const r2 = release("--new-key");
    const mine = extensionId(createPrivateKey(before));
    r.status !== 0 && r.out.includes(extensionId(other)) && r.out.includes(mine) && !r.ssh && r2.status !== 0 && !r2.ssh && readFileSync(keyFile, "utf8") === before
      ? ok("a key whose ID isn't the one the last updates.xml names stops the release before the server is reached, --new-key or not, and the key is left alone")
      : fail("release with another ID published: " + JSON.stringify({ r, r2, keyKept: readFileSync(keyFile, "utf8") === before }));
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log("\nDONE");
