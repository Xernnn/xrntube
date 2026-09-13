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

const opt = await ctx.newPage();
await opt.goto(`chrome-extension://${extId}/options/options.html`);
await opt.waitForLoadState("domcontentloaded");
await opt.waitForTimeout(300);
await opt.locator(".page-tab[data-page='settings']").click();
await opt.waitForTimeout(150);
const n = await opt.locator("#settings-list .switch input:checked").count();
n === 32 ? ok("32 of 33 toggles on by default (blockInEmbeds is opt-in)") : fail(`checked: ${n}`);

const setToggle = async (key, on) => {
  // A key may name one switch or several — the coarse toggles this suite used
  // to flip are now groups of per-element switches (see SETTING_GROUPS).
  for (const k of [].concat(key)) {
    const cb = opt.locator(`#settings-list .switch[data-key="${k}"] input`);
    if ((await cb.isChecked()) !== on) await opt.locator(`#settings-list .switch[data-key="${k}"] .slider`).click();
    await opt.waitForFunction(
      ([kk, v]) => chrome.storage.sync.get("bt_settings").then((r) => r.bt_settings && r.bt_settings[kk] === v),
      [k, on],
      { timeout: 3000 }
    );
  }
};

async function probeChannel() {
  const p = await ctx.newPage();
  await p.goto("https://www.youtube.com/@LinusTechTips/videos", { waitUntil: "domcontentloaded" });
  await p.waitForTimeout(9000);
  const r = await p.evaluate(() => {
    const sb = document.querySelector("#sponsor-button");
    const membersOnlyBadges = [...document.querySelectorAll("badge-shape, .badge, [class*='badge' i]")]
      .filter((b) => /^members?[\s-]?only$/i.test((b.textContent || "").trim()));
    // tiles still on the page whose subtree still contains such a badge
    const tilesWithBadge = [...document.querySelectorAll("ytd-rich-item-renderer, yt-lockup-view-model")]
      .filter((t) => [...t.querySelectorAll("badge-shape, .badge, [class*='badge' i]")].some((b) => /^members?[\s-]?only$/i.test((b.textContent || "").trim())));
    const membershipTab = [...document.querySelectorAll("yt-tab-shape, tp-yt-paper-tab, [role='tab']")]
      .filter((t) => /^members(hip)?$/i.test((t.textContent || "").trim()));
    return {
      joinBtnDisplay: sb ? getComputedStyle(sb).display : "(no #sponsor-button)",
      totalMembersBadges: membersOnlyBadges.length,
      tilesStillShowingBadge: tilesWithBadge.length,
      membershipTabCount: membershipTab.length,
    };
  });
  await p.close();
  return r;
}

// --- default ON ---
const on = await probeChannel();
console.log("   ON :", JSON.stringify(on));
(on.joinBtnDisplay === "none" || on.joinBtnDisplay === "(no #sponsor-button)")
  ? ok(`Join button hidden (display=${on.joinBtnDisplay})`)
  : fail("Join button visible: " + on.joinBtnDisplay);
on.tilesStillShowingBadge === 0
  ? ok(`0 members-only tiles remain (were ${on.totalMembersBadges > 0 ? "some" : "0"} badges page-wide)`)
  : fail(`${on.tilesStillShowingBadge} members-only tiles survived`);
on.membershipTabCount === 0
  ? ok("Membership channel tab removed")
  : fail(`${on.membershipTabCount} Membership tab(s) left`);

// --- toggle OFF ---
await setToggle(["joinButton", "membershipPrices", "membersOnlyTiles", "membershipTab"], false);
const off = await probeChannel();
console.log("   OFF:", JSON.stringify(off));
(off.joinBtnDisplay !== "none" && off.tilesStillShowingBadge > 0)
  ? ok(`toggle off: Join button back (${off.joinBtnDisplay}), ${off.tilesStillShowingBadge} members-only tiles visible again`)
  : fail("toggle off did not restore memberships: " + JSON.stringify(off));
await setToggle(["joinButton", "membershipPrices", "membersOnlyTiles", "membershipTab"], true);

await ctx.close();
console.log("\nDONE");
