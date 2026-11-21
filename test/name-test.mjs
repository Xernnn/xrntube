import { readFileSync, readdirSync } from "fs";

// The name a person sees is "xrntube", in lower case like every other xrn app,
// with nothing after it: the browser's extension list, the toolbar tooltip, the
// popup and options tabs, the ⋮ rows, the right-click items and every notice
// on YouTube. "XrnTube" stays only as the code's namespace (`self.XrnTube`,
// `XrnTube.MSG`), which nobody sees. The add-on id doesn't change with it, or
// Zen would install the new .xpi beside the old one instead of over it.
//
// Pure Node: no browser, runs offline, finishes instantly.

const root = new URL("..", import.meta.url);
const read = (f) => readFileSync(new URL(f, root), "utf8");
const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);

const manifest = JSON.parse(read("manifest.json"));
manifest.name === "xrntube"
  ? ok('the manifest names it "xrntube" and nothing more')
  : fail(`manifest name is ${JSON.stringify(manifest.name)}`);
!/xrntube/i.test(manifest.description)
  ? ok("the description doesn't repeat the name")
  : fail(`description: ${manifest.description}`);
const geckoId = manifest.browser_specific_settings?.gecko?.id || "";
/^xrntube@[a-z0-9.-]+$/.test(geckoId)
  ? ok("the Firefox add-on id still starts xrntube@, so a new .xpi installs over the old one")
  : fail(`gecko id is ${JSON.stringify(geckoId)}`);

for (const page of ["popup/popup.html", "options/options.html"]) {
  const title = read(page).match(/<title>([^<]*)<\/title>/);
  title && title[1] === "xrntube"
    ? ok(`${page}'s tab is called "xrntube"`)
    : fail(`${page}'s title is ${title ? JSON.stringify(title[1]) : "missing"}`);
}

// Every shipped file: "XrnTube" only as the namespace — after a "." (self.,
// ctx.) or before a member (XrnTube.MSG). Anything else is text someone reads.
const shipped = ["background", "content", "popup", "options", "shared"].flatMap((d) =>
  readdirSync(new URL(`${d}/`, root))
    .filter((f) => /\.(js|html|css)$/.test(f))
    .map((f) => `${d}/${f}`)
);
const prose = /(?<![.\w])XrnTube(?!\.[A-Za-z_])(?!\w)/;
const stray = [];
for (const f of shipped) {
  read(f)
    .split("\n")
    .forEach((line, i) => prose.test(line) && stray.push(`${f}:${i + 1}: ${line.trim()}`));
}
stray.length === 0
  ? ok(`no "XrnTube" a person can see in ${shipped.length} shipped files`)
  : fail(`"XrnTube" outside the namespace:\n  ${stray.join("\n  ")}`);

// The rows and notices the extension adds to YouTube, named once each, so a
// rewording that drops the name altogether also shows up here.
const bg = read("background/background.js");
const content = read("content/content.js");
for (const [where, src, text] of [
  ["right-click item", bg, '"xrntube: block this channel"'],
  ["right-click item", bg, '"xrntube: block this video"'],
  ["blanked embed", content, "Blocked by xrntube</body>"],
  ["comment limit notice", content, "by xrntube."],
  ["end-of-feed line", content, "xrntube blocked ${n} result"]
]) {
  src.includes(text) ? ok(`${where}: ${text}`) : fail(`${where} no longer reads ${text}`);
}
