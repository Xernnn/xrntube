// What scripts/package.mjs builds, without its command line: the zip, the
// signed .crx, and the update manifest a browser polls for new versions.
// test/selfupdate-test.mjs checks the .crx against these same functions.
//
// No zip tool and no browser needed: a plain PKZIP writer over node:zlib, with
// fixed file times so the same source always gives the same bytes, and CRX3
// written by hand (a few protobuf fields around an RSA signature).
import { readFileSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { deflateRawSync, crc32 } from "zlib";
import { createHash, createPublicKey, createSign } from "crypto";

// Only what the browser runs: no tests, server, docs or node_modules.
export const INCLUDE = ["manifest.json", "background", "content", "shared", "popup", "options", "icons", "fonts"];

// [[path inside the package, bytes]] for every shipped file, in a stable order.
export function packageFiles(root) {
  const out = [];
  const walk = (p) => {
    if (statSync(p).isDirectory()) for (const f of readdirSync(p).sort()) walk(join(p, f));
    else out.push([relative(root, p).split("\\").join("/"), readFileSync(p)]);
  };
  for (const entry of INCLUDE) walk(join(root, entry));
  return out;
}

// The same files with update_url added to the manifest: what goes in the .crx.
// The zip keeps none, since the Chrome Web Store refuses a manifest that
// points updates anywhere else.
export const withUpdateUrl = (files, updateUrl) =>
  files.map(([path, data]) => {
    if (path !== "manifest.json") return [path, data];
    const m = JSON.parse(data.toString("utf8"));
    m.update_url = updateUrl;
    return [path, Buffer.from(JSON.stringify(m, null, 2) + "\n")];
  });

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1; // 2026-01-01

export function zip(entries) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [path, data] of entries) {
    const name = Buffer.from(path);
    const packed = deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4); // version needed
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt16LE(DOS_TIME, 10);
    head.writeUInt16LE(DOS_DATE, 12);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(data.length, 22);
    head.writeUInt16LE(name.length, 26);
    locals.push(head, name, packed);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(0x0800, 8);
    dir.writeUInt16LE(8, 10);
    dir.writeUInt16LE(DOS_TIME, 12);
    dir.writeUInt16LE(DOS_DATE, 14);
    dir.writeUInt32LE(crc, 16);
    dir.writeUInt32LE(packed.length, 20);
    dir.writeUInt32LE(data.length, 24);
    dir.writeUInt16LE(name.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, name);
    offset += head.length + name.length + packed.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, centralBuf, end]);
}

// The public key as the browser hashes it (DER SubjectPublicKeyInfo).
export const publicKeyDer = (privateKey) => createPublicKey(privateKey).export({ type: "spki", format: "der" });

// An extension's ID is the first 16 bytes of the SHA-256 of its public key,
// each hex digit written as a letter a–p. So the key, not the path or the
// version, is what keeps one install the same extension across updates.
export const crxIdBytes = (privateKey) => createHash("sha256").update(publicKeyDer(privateKey)).digest().subarray(0, 16);
export const extensionId = (privateKey) =>
  [...crxIdBytes(privateKey).toString("hex")].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");

// Protobuf: every field here is length-delimited (wire type 2).
const varint = (n) => {
  const b = [];
  while (n > 127) {
    b.push((n & 127) | 128);
    n >>>= 7;
  }
  b.push(n);
  return Buffer.from(b);
};
const field = (num, bytes) => Buffer.concat([varint((num << 3) | 2), varint(bytes.length), bytes]);
export const CRX3_SIGNED_PREFIX = Buffer.from("CRX3 SignedData\0");

// "Cr24", format 3, header length, CrxFileHeader, then the zip. The header is
// { sha256_with_rsa (2): { public_key (1), signature (2) },
//   signed_header_data (10000): SignedData { crx_id (1) } }, and the signature
// covers the prefix, the signed data's length and bytes, then the whole zip.
export function crx3(zipBuf, privateKey) {
  const signedData = field(1, crxIdBytes(privateKey));
  const len = Buffer.alloc(4);
  len.writeUInt32LE(signedData.length);
  const signature = createSign("sha256").update(Buffer.concat([CRX3_SIGNED_PREFIX, len, signedData, zipBuf])).sign(privateKey);
  const header = Buffer.concat([
    field(2, Buffer.concat([field(1, publicKeyDer(privateKey)), field(2, signature)])),
    field(10000, signedData)
  ]);
  const pre = Buffer.alloc(12);
  pre.write("Cr24", 0);
  pre.writeUInt32LE(3, 4);
  pre.writeUInt32LE(header.length, 8);
  return Buffer.concat([pre, header, zipBuf]);
}

// What the browser fetches from the manifest's update_url: the newest version
// and where its .crx is. The hash lets it refuse a file that changed in transit.
export const updateManifest = ({ id, version, codebase, crx }) => `<?xml version='1.0' encoding='UTF-8'?>
<gupdate xmlns='http://www.google.com/update2/response' protocol='2.0'>
  <app appid='${id}'>
    <updatecheck codebase='${codebase}' version='${version}' hash_sha256='${createHash("sha256").update(crx).digest("hex")}' />
  </app>
</gupdate>
`;

// "2.1.0" vs "2.0.13" → positive, zero or negative, comparing numerically.
export function compareVersions(a, b) {
  const pa = String(a).split(".").map(Number);
  const pb = String(b).split(".").map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d) return d;
  }
  return 0;
}

// The version `npm run release` publishes, given the one the server has live
// (null when it has none) and manifest.json's. A browser takes only a version
// higher than its own, so one the server already has is bumped past. One the
// server is already beyond means this checkout is behind what was shipped:
// bumped, its older code would go out under a newer number, and every
// browser would install it within hours. That one is refused.
export function releaseVersion(live, local) {
  const order = live ? compareVersions(live, local) : -1;
  if (order < 0) return { version: local, bumped: false };
  if (order > 0) {
    throw new Error(
      `The server already has ${live}, newer than this checkout's ${local}. Releasing would ship this older code ` +
        `as a newer version, and every browser would install it. Update this checkout to the code ${live} came from ` +
        "(git pull, or the branch it was released from), then release again."
    );
  }
  const parts = String(live).split(".");
  parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + 1);
  return { version: parts.join("."), bumped: true };
}
