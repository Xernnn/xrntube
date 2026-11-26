// The icons, in pure Node: every size a browser may draw, in both the manifest's "icons" and the
// toolbar button's "action.default_icon", each file that size, and the tile reaching the edges of
// its canvas. Chromium picks the next size up for its slot and scales it down; on Android the
// toolbar slot is 20 dp, 55 px on a 2.75x phone. scripts/icons.sh renders the files.
import { readFileSync } from "fs";
import { inflateSync } from "zlib";

const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);
const check = (cond, m) => (cond ? ok(m) : fail(m));

const read = (name) => readFileSync(new URL(`../${name}`, import.meta.url));
const manifest = JSON.parse(read("manifest.json"));
const SIZES = ["16", "24", "32", "48", "64", "96", "128", "256"];

/** A PNG's width, height and the alpha at (x, y): 8-bit RGBA, not interlaced (rsvg-convert's). */
function png(buf) {
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (buf.toString("latin1", 1, 4) !== "PNG" || buf[24] !== 8 || buf[25] !== 6 || buf[28] !== 0) return null;
  const idat = [];
  for (let at = 8; at < buf.length; ) {
    const len = buf.readUInt32BE(at);
    if (buf.toString("latin1", at + 4, at + 8) === "IDAT") idat.push(buf.subarray(at + 8, at + 8 + len));
    at += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const px = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let i = 0; i < stride; i++) {
      const v = raw[y * (stride + 1) + 1 + i];
      const a = i >= 4 ? px[y * stride + i - 4] : 0;
      const b = y ? px[(y - 1) * stride + i] : 0;
      const c = i >= 4 && y ? px[(y - 1) * stride + i - 4] : 0;
      const p = a + b - c;
      const paeth = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      px[y * stride + i] = (v + [0, a, b, (a + b) >> 1, paeth][filter]) & 255;
    }
  }
  return { width, height, alpha: (x, y) => px[y * stride + x * 4 + 3] };
}

check(JSON.stringify(Object.keys(manifest.icons)) === JSON.stringify(SIZES), `"icons" names ${SIZES.join(", ")} (has ${Object.keys(manifest.icons)})`);
check(
  JSON.stringify(manifest.action.default_icon) === JSON.stringify(manifest.icons),
  `the toolbar button has the same set (has ${Object.keys(manifest.action.default_icon)})`
);
for (const [size, file] of Object.entries(manifest.icons)) {
  const img = png(read(file));
  if (!img) {
    fail(`${file} isn't an 8-bit RGBA PNG`);
    continue;
  }
  const { width, height, alpha } = img;
  check(width === +size && height === +size, `${file} is ${size} px (${width}x${height})`);
  const mid = width >> 1;
  const edges = [[mid, 0], [mid, height - 1], [0, mid], [width - 1, mid]].every(([x, y]) => alpha(x, y) > 200);
  check(edges && alpha(0, 0) < 128, `${file}: the tile reaches the edges, with rounded corners`);
}
