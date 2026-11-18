// What stops `npm run release` (scripts/package.mjs --release) before it
// builds or uploads anything. Tested in test/release-test.mjs.
import { execFileSync } from "child_process";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { createPrivateKey, generateKeyPairSync } from "crypto";

// The branch releases are made from.
export const RELEASE_BRANCH = "master";

// Why the working tree at `root` isn't one to release from; empty if it is.
// What's published is what the folders hold, so it must be master with
// everything committed: a file not added would go into the package as well.
export function treeRefusals(root) {
  const git = (...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
  const out = [];
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== RELEASE_BRANCH) out.push(`on ${branch}, not ${RELEASE_BRANCH}`);
  const changed = git("status", "--porcelain");
  if (changed) out.push(`not committed:\n${changed}`);
  return out;
}

// The extension's signing key, which is its ID: an installed copy only takes
// an update signed with it. Made only when `make` says so (a first release,
// --new-key), never because the file is missing: on a machine without it, a
// release published a new extension under a new ID, and every browser with
// the old one stopped updating. An existing file is never replaced.
export function signingKey(file, make = false) {
  if (!existsSync(file)) {
    if (!make) {
      throw new Error(
        `no ${file}. Restore it from the key backup: a new key is a new extension ID, and installed copies stop updating. Only for a first release: --new-key`
      );
    }
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    writeFileSync(file, privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600, flag: "wx" });
    console.log(`made a signing key: ${file}. Back it up: every update needs this exact key`);
  }
  return createPrivateKey(readFileSync(file));
}

// The extension ID an updates.xml names (its <app appid='…'>), or null.
export function appIdOf(xml) {
  const m = /<app\s[^>]*appid=['"]([a-p]{32})['"]/.exec(String(xml || ""));
  return m ? m[1] : null;
}

// Why signing with the key whose ID is `id` would orphan the installs that
// `xml` (an updates.xml, from `where`) points at; null when it wouldn't. A
// browser looks for its own ID in updates.xml, so once a release replaces it
// with another ID, every copy installed under the old one stops updating.
export function idRefusal(id, xml, where) {
  const published = appIdOf(xml);
  if (!published || published === id) return null;
  return (
    `${where} names extension ID ${published}, and this key signs as ${id}. Publishing would replace it, and every copy ` +
    "installed under the old ID would stop updating. Restore the key that ID came from (the key backup)."
  );
}
