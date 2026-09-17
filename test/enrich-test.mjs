import { chromium } from "playwright";

const EXT_PATH = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const ctx = await chromium.launchPersistentContext(`/tmp/bt-test-${process.pid}-${Math.random().toString(36).slice(2)}`, {
  headless: false,
  args: [`--disable-extensions-except=${EXT_PATH}`, `--load-extension=${EXT_PATH}`, "--headless=new", "--no-sandbox"],
});
const fail = (m) => { console.error("FAIL:", m); process.exitCode = 1; };
const ok = (m) => console.log("ok:", m);

let sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 10000 }));
const extId = sw.url().split("/")[2];
const swErr = [];
sw.on("console", (m) => { if (m.type() === "error") swErr.push(m.text()); });

const opt = await ctx.newPage();
opt.on("dialog", (d) => d.accept()); // auto-accept the post-import confirm if it appears
await opt.goto(`chrome-extension://${extId}/options/options.html`);
await opt.waitForLoadState("domcontentloaded");
await opt.waitForTimeout(300);
const send = (m) => opt.evaluate((mm) => chrome.runtime.sendMessage(mm), m);

// seed: mix of UC-keyed and @handle-keyed channels + one bogus
const IDS = [
  "UCX6OQ3DkcsbYNE6H8uQQuVA", // MrBeast
  "UCBJycsmduvYEL83R_U4JriQ", // MKBHD (UC)
  "@veritasium",
  "UCsXVk37bltHxD1rDPwtNM8Q", // Kurzgesagt
  "@mkbhd",
  "UC-lHJZR3Gqxm24_Vd_AJ5Yw", // PewDiePie
  "UCq-Fj5jknLsUf-MWSy4_brA", // T-Series
  "UCzzzzzzzzzzzzzzzzzzzzzz", // bogus
];
for (const id of IDS) await send({ type: "BLOCK_CHANNEL", id, name: "", mode: "full" });
await opt.waitForTimeout(300);

// --- BULK_FETCH_CHANNEL_INFO: one message, one write, enriched fields ---
const t0 = Date.now();
const r = await send({ type: "BULK_FETCH_CHANNEL_INFO", ids: IDS });
const ms = Date.now() - t0;
console.log(`   BULK_FETCH_CHANNEL_INFO -> ${JSON.stringify(r)}  (${ms} ms for ${IDS.length})`);
(r && r.ok && r.got >= 6)
  ? ok(`bulk enriched ${r.got}/${IDS.length} channels in ${ms} ms (8-wide, one write)`)
  : fail("bulk fetch underperformed: " + JSON.stringify(r));
ms < 25000 ? ok(`fast enough (${ms} ms < 25s for ${IDS.length})`) : fail(`too slow: ${ms} ms`);

const bl = await send({ type: "GET_BLOCKLIST" });
const mkbhdUC = bl.channels["UCBJycsmduvYEL83R_U4JriQ"];
console.log("   MKBHD (UC key) ->", JSON.stringify(mkbhdUC));
(mkbhdUC && /^[\d.,]+\s?[KMB]?$/i.test(mkbhdUC.subs || "") && /^@/.test(mkbhdUC.handle || "") && mkbhdUC.name && mkbhdUC.name !== "UCBJycsmduvYEL83R_U4JriQ")
  ? ok(`UC-keyed channel enriched: subs=${mkbhdUC.subs}, handle=${mkbhdUC.handle}, name="${mkbhdUC.name}"`)
  : fail("UC channel not fully enriched: " + JSON.stringify(mkbhdUC));

const verit = bl.channels["@veritasium"];
(verit && verit.subs && verit.name && verit.name.toLowerCase() !== "@veritasium")
  ? ok(`@handle channel got a real name: "${verit.name}" (${verit.subs})`)
  : fail("@handle channel not enriched: " + JSON.stringify(verit));

// A UC id naming no channel is *gone*, and saying so is the point: it used to
// be recorded as nothing at all, which put it back in the fetch queue on every
// options-page open forever. What must never appear is a number.
const bogus = bl.channels["UCzzzzzzzzzzzzzzzzzzzzzz"];
const bogusNumber = /\d/.test(String((bogus || {}).subs || ""));
bogus && bogus.gone && !bogusNumber
  ? ok("bogus channel recorded as gone, with no number invented for it")
  : fail("bogus channel: " + JSON.stringify(bogus));

// --- UI: UC-keyed w/ handle shows the @handle not the UC id; @handle row has no redundant id line ---
await opt.reload();
await opt.waitForLoadState("domcontentloaded");
await opt.waitForTimeout(600);
await opt.selectOption("#filter-by", "full");
await opt.waitForTimeout(300);
const uiRows = await opt.evaluate(() => {
  const out = {};
  document.querySelectorAll("#channel-list .channel-row").forEach((li) => {
    const idAttr = li.dataset.id;
    const idLine = li.querySelector(".item-id");
    out[idAttr] = { idLineText: idLine ? idLine.textContent : null, idLineTitle: idLine ? idLine.getAttribute("title") : null };
  });
  return out;
});
console.log("   UI id lines:", JSON.stringify(uiRows, null, 1));
const ucRow = uiRows["UCBJycsmduvYEL83R_U4JriQ"];
(ucRow && ucRow.idLineText && ucRow.idLineText.startsWith("@") && ucRow.idLineTitle === "UCBJycsmduvYEL83R_U4JriQ")
  ? ok(`UC row shows "${ucRow.idLineText}" (UC id kept as tooltip)`)
  : fail("UC row still shows the raw id: " + JSON.stringify(ucRow));
const handleRow = uiRows["@veritasium"];
(handleRow && handleRow.idLineText === null)
  ? ok("@handle row shows no redundant id line")
  : fail("@handle row still has an id line: " + JSON.stringify(handleRow));

await opt.waitForTimeout(300);
swErr.length ? fail("SW errors:\n" + swErr.join("\n")) : ok("no service worker console errors");
await ctx.close();
console.log("\nDONE");
