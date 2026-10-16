// Packs the extension into dist/xrntube-<version>.zip — what a phone browser
// loads (Quetta's developer mode, or the Chrome Web Store upload). Only what
// the browser runs goes in: no tests, server, docs or node_modules.
//
//   node scripts/package.mjs                     build the zip
//   node scripts/package.mjs --upload homeserver  …and copy it to the sync
//                                                 server's downloads over ssh
//
// No zip tool needed: a plain PKZIP writer over node:zlib, with fixed file
// times so the same source always gives the same bytes.
import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "fs";
import { join, relative } from "path";
import { deflateRawSync, crc32 } from "zlib";
import { execFileSync } from "child_process";

const ROOT = new URL("..", import.meta.url).pathname;
const INCLUDE = ["manifest.json", "background", "content", "shared", "popup", "options", "icons"];
const { version } = JSON.parse(readFileSync(join(ROOT, "manifest.json"), "utf8"));

const files = [];
const walk = (p) => {
  if (statSync(p).isDirectory()) for (const f of readdirSync(p).sort()) walk(join(p, f));
  else files.push(p);
};
for (const entry of INCLUDE) walk(join(ROOT, entry));

const DOS_TIME = 0; // 00:00:00
const DOS_DATE = (2026 - 1980) << 9 | 1 << 5 | 1; // 2026-01-01
const locals = [];
const central = [];
let offset = 0;
for (const file of files) {
  const name = Buffer.from(relative(ROOT, file).split("\\").join("/"));
  const data = readFileSync(file);
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
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);

mkdirSync(join(ROOT, "dist"), { recursive: true });
const out = join(ROOT, "dist", `xrntube-${version}.zip`);
writeFileSync(out, Buffer.concat([...locals, centralBuf, end]));
console.log(`${relative(ROOT, out)}: ${files.length} files, ${Math.round(statSync(out).size / 1024)} KB`);

const at = process.argv.indexOf("--upload");
if (at > 0) {
  const host = process.argv[at + 1];
  if (!host) throw new Error("--upload needs an ssh host");
  // Two names: the versioned file, and a stable one a phone can bookmark.
  for (const name of [`xrntube-${version}.zip`, "xrntube.zip"]) {
    execFileSync("ssh", [host, `cat > xrntube-sync/data/downloads/${name}`], { input: readFileSync(out) });
  }
  console.log(`uploaded to ${host}: …/xrntube/download/xrntube-${version}.zip and …/download/xrntube.zip`);
}
