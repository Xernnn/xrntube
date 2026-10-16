const {
  MSG,
  CHANNEL_MODE,
  SETTINGS_KEY,
  DEFAULT_SETTINGS,
  KEYWORDS_KEY,
  SETTING_GROUPS,
  SUBS_SCRAPE_VERSION,
  resolveSettings
} = self.XrnTube;

const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const plural = (n, one, many) => `${Number(n).toLocaleString()} ${n === 1 ? one : many || one + "s"}`;

// Tiny DOM builder. Props that exist on the element are set as properties
// (title, type, checked, hidden, href…), "on…" become listeners, everything
// else is an attribute. Children may be nodes, strings, arrays, or falsy.
function h(tag, props, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k === "text") el.textContent = v;
    else if (k === "dataset") Object.assign(el.dataset, v);
    else if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2), v);
    else if (k in el) el[k] = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c);
  return el;
}

// Per-viewer conveniences only (sort order, the size filter, thumbnails).
// The filter itself is deliberately NOT remembered: reopening the page on
// "Hidden" and seeing three rows out of five thousand reads as data loss.
const PREFS_KEY = "xt-blocklist-view";
const prefs = (() => {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY)) || {};
  } catch {
    return {};
  }
})();
function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify({ sortBy, hideSmall, smallThreshold, thumbs }));
  } catch {}
}

let state = { channels: {}, videos: {}, allowlist: {} };
let filter = "";
// Which filter is active: "all" | "full" | "videoOnly" | "videos" | "nosubs" | "hidden"
let tab = "all";
// Channel sort: "subsDesc" | "subsAsc" | "recent" | "oldest" | "name".
// Biggest-first by default — the whole point of the sub counts is to see who
// the heavy hitters are; keep the <select> in options.html in step.
let sortBy = prefs.sortBy || "subsDesc";
// Hide channels whose known sub count is below `smallThreshold` (unknown = kept).
let hideSmall = !!prefs.hideSmall;
let smallThreshold = Number(prefs.smallThreshold) >= 0 ? Number(prefs.smallThreshold) : 10000;
// Video thumbnails are opt-in: a list of things you blocked is not obviously
// a place you want to see them again.
let thumbs = !!prefs.thumbs;
// Whether a background lookup (the sweep) is in progress.
let bulkRunning = false;
// How many rows a section renders before the "Show more" control. The
// blocklist can hold thousands and building every row up front makes the page
// crawl, so lists start capped and grow on demand instead of being truncated
// outright — `shown` tracks the current limit per section and is reset
// whenever the visible set changes (tab / search / sort).
const RENDER_CAP = 300;
const RENDER_STEP = 500;
let shown = { channel: RENDER_CAP, video: RENDER_CAP };
function resetShown() {
  shown = { channel: RENDER_CAP, video: RENDER_CAP };
}

// Bulk-select mode: rows grow a checkbox and an action bar appears. Keys are
// "c:<channel key>" / "v:<video id>" so one selection can mix both.
let selectMode = false;
const selected = new Set();
let lastChecked = null; // for shift-click ranges

// Drawers and whitelist panels survive a re-render — every storage change
// repaints the list, and an editor that snaps shut under your cursor while you
// type an age rule is the kind of thing that makes a page feel broken.
const openDrawers = new Set();
const openWhitelists = new Set();

async function refresh() {
  state = await send({ type: MSG.GET_BLOCKLIST });
  render();
  renderAllowlist();
  renderRecentUnblocks();
  renderDataPage();
}

function matches(text) {
  return !filter || text.toLowerCase().includes(filter);
}

// "1.2M" / "930K" / "12,345" / "1.5B" -> a number; "hidden" / "n/a" / "" -> null.
function subsToNumber(s) {
  if (!s || s === "hidden" || s === "n/a") return null;
  const m = String(s).replace(/,/g, "").match(/^([\d.]+)\s*([KMB])?/i);
  if (!m) return null;
  const mult = { k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase()] || 1;
  const n = parseFloat(m[1]) * mult;
  return Number.isFinite(n) ? Math.round(n) : null;
}

function fmtCount(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

function fmtAgo(ms) {
  if (!ms) return "never";
  const diff = Date.now() - ms;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return Math.round(diff / 60000) + " min ago";
  if (diff < 86400000) return Math.round(diff / 3600000) + " h ago";
  if (diff < 30 * 86400000) return Math.round(diff / 86400000) + " d ago";
  return new Date(ms).toLocaleDateString();
}

// A row is normally excluded if hidden; the "Hidden" tab flips that.
function passesHidden(entry) {
  return tab === "hidden" ? !!entry.hidden : !entry.hidden;
}

const byName = (label) => (a, b) => label(a).toLowerCase().localeCompare(label(b).toLowerCase());
const channelLabel = ([id, e]) => e.name || e.handle || id;
const videoLabel = ([id, e]) => e.title || id;

const CHANNEL_SORT = {
  recent: (a, b) => (b[1].ts || 0) - (a[1].ts || 0),
  oldest: (a, b) => (a[1].ts || 0) - (b[1].ts || 0),
  name: byName(channelLabel),
  subsDesc: (a, b) => (subsToNumber(b[1].subs) ?? -1) - (subsToNumber(a[1].subs) ?? -1),
  subsAsc: (a, b) => {
    const x = subsToNumber(a[1].subs);
    const y = subsToNumber(b[1].subs);
    // unknowns sort last either way
    if (x == null && y == null) return 0;
    if (x == null) return 1;
    if (y == null) return -1;
    return x - y;
  }
};
// Videos have no sub count; the two size sorts fall back to newest-first.
const VIDEO_SORT = {
  oldest: CHANNEL_SORT.oldest,
  name: byName(videoLabel)
};

function render() {
  const allChannels = Object.entries(state.channels || {});
  const allVideos = Object.entries(state.videos || {});
  const hiddenCount =
    allChannels.filter(([, e]) => e.hidden).length + allVideos.filter(([, e]) => e.hidden).length;

  const wantChannels =
    tab === "all" || tab === "full" || tab === "videoOnly" || tab === "nosubs" || tab === "hidden";
  const wantVideos = tab === "all" || tab === "videos" || tab === "hidden";

  let hiddenBySmall = 0;
  const channelEntries = allChannels
    .filter(
      ([id, e]) => matches(id + " " + (e.name || "") + " " + (e.handle || "") + " " + (e.ucid || "")) && passesHidden(e)
    )
    .filter(([, e]) => {
      if (tab === "full") return e.mode !== CHANNEL_MODE.EXCEPT_WHITELIST;
      if (tab === "videoOnly") return e.mode === CHANNEL_MODE.EXCEPT_WHITELIST;
      // Channels with no usable subscriber *number*: never fetched, or the
      // channel hides its count, or the scrape came back "n/a". These are the
      // ones the sub-count sort can't place and the size filter can't judge,
      // so they get a tab of their own to work through.
      if (tab === "nosubs") return subsToNumber(e.subs) == null;
      return true;
    })
    .filter(([, e]) => {
      if (!hideSmall) return true;
      const n = subsToNumber(e.subs);
      if (n != null && n < smallThreshold) {
        hiddenBySmall++;
        return false;
      }
      return true;
    })
    .sort(CHANNEL_SORT[sortBy] || CHANNEL_SORT.recent);

  const videoEntries = allVideos
    .filter(([id, e]) => matches(id + " " + (e.title || "")) && passesHidden(e))
    .sort(VIDEO_SORT[sortBy] || CHANNEL_SORT.recent);

  // One filter control instead of a row of pills. Counts go in the option
  // labels so they're still visible without six buttons competing for space.
  const filterSel = $("filter-by");
  const noSubs = allChannels.filter(([, e]) => subsToNumber(e.subs) == null && !e.hidden).length;
  const setLabel = (v, text) => {
    const o = filterSel.querySelector(`option[value="${v}"]`);
    if (o) o.textContent = text;
  };
  setLabel("hidden", hiddenCount ? `Hidden (${hiddenCount})` : "Hidden");
  setLabel("nosubs", noSubs ? `No sub count (${noSubs})` : "No sub count");
  if (filterSel.value !== tab) filterSel.value = tab;

  $("channel-total").textContent = `(${allChannels.length.toLocaleString()})`;
  $("video-total").textContent = `(${allVideos.length.toLocaleString()})`;
  $("delete-all-channels-btn").hidden = allChannels.length === 0;
  $("delete-all-videos-btn").hidden = allVideos.length === 0;

  $("channel-section").hidden = !wantChannels;
  $("video-section").hidden = !wantVideos;

  renderList($("channel-list"), $("channel-empty"), $("channel-more"), channelEntries, buildChannelRow, "channel");
  renderList($("video-list"), $("video-empty"), $("video-more"), videoEntries, buildVideoRow, "video");

  const fetchAllBtn = $("fetch-all-subs-btn");
  if (!bulkRunning) {
    const missing = allChannels.filter(([, e]) => !subsAttempted(e)).length;
    fetchAllBtn.hidden = missing === 0;
    fetchAllBtn.textContent = missing ? `Fetch ${missing.toLocaleString()} missing sub counts` : "Fetch all sub counts";
  }

  const smallNote = $("small-note");
  smallNote.hidden = !hideSmall || hiddenBySmall === 0;
  smallNote.textContent = `${plural(hiddenBySmall, "channel")} under ${smallThreshold.toLocaleString()} subs hidden.`;

  setNavCount("nav-blocklist", allChannels.length + allVideos.length);
  renderStats(allChannels, allVideos);
  renderEnrichNote(allChannels);
  syncBulkBar();

  const clearVideosBtn = $("clear-videos-btn");
  clearVideosBtn.hidden = allVideos.length === 0;
  clearVideosBtn.textContent = `Clear ${plural(allVideos.length, "blocked video")}`;
  const failures = lookupFailures();
  const nFailed = failures.gone.length + failures.failed.length + failures.hidden.length;
  $("clean-failed-btn").hidden = nFailed === 0;
  $("clean-failed-btn").textContent = `Delete channels that can't be looked up (${nFailed.toLocaleString()})…`;
  const clearChannelsBtn = $("clear-channels-btn");
  clearChannelsBtn.hidden = allChannels.length === 0;
  clearChannelsBtn.textContent = `Delete all ${plural(allChannels.length, "channel")}`;
}

function setNavCount(id, n) {
  const el = $(id);
  if (el) el.textContent = n ? Number(n).toLocaleString() : "";
}

// The four tiles above the list: counts, how many sub counts are known (as a
// progress bar — it's the thing an import is waiting on), and total reach.
function renderStats(allChannels, allVideos) {
  let subSum = 0;
  let known = 0;
  for (const [, e] of allChannels) {
    const n = subsToNumber(e.subs);
    if (n != null) {
      subSum += n;
      known++;
    }
  }
  $("stat-channels").textContent = allChannels.length.toLocaleString();
  $("stat-videos").textContent = allVideos.length.toLocaleString();
  $("stat-subs").textContent = allChannels.length
    ? `${known.toLocaleString()} / ${allChannels.length.toLocaleString()}`
    : "0";
  $("stat-subs-bar").style.width = allChannels.length ? `${(100 * known) / allChannels.length}%` : "0";
  $("stat-reach").textContent = subSum ? fmtCount(subSum) : "—";
}

// Warn about entries that know only ONE of a channel's two identities.
function renderEnrichNote(allChannels) {
  const el = $("enrich-note");
  if (bulkRunning) {
    el.hidden = true;
    return;
  }
  // A channel has two identities and a tile links only ONE of them. Measured on
  // live search results: 20 of 20 tiles linked `/@handle` and none linked
  // `/channel/UC…`; other surfaces are the other way round. So an entry that
  // knows only the identity it was stored under blocks nothing on the surfaces
  // that use the other one — which is what "I blocked them and their videos are
  // still in my search results" actually is.
  //
  // Both directions count. The old version listed only UC-keyed entries missing
  // a handle, so a channel blocked from the popup by `@handle` and never given
  // its `ucid` was silently in the same state and never mentioned.
  //
  // The gate is `subsAttempted` — an entry the *current* scrape has already
  // looked at and still couldn't pair up is a dead end, and nagging about it
  // forever is noise. (A 7-day "scraped recently" window used to do this job,
  // which meant a sweep that resolved nothing left the page claiming there was
  // nothing to resolve.)
  const stuck = allChannels.filter(([id, e]) => {
    if (e.gone || subsAttempted(e)) return false;
    return id.startsWith("UC") ? !e.handle : !e.ucid;
  });
  const unresolved = stuck.map(([id]) => id);
  if (!unresolved.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  // Name them when there are only a few — "1 channel" with no way to tell
  // which is not something anyone can act on.
  const names = stuck.length <= 3 ? ` (${stuck.map(([id, e]) => e.name || id).join(", ")})` : "";
  el.replaceChildren(
    `⚠️ ${plural(unresolved.length, "channel")}${names} may not block everywhere yet — YouTube links a channel by @handle on some pages and by ID on others. `,
    h("button", {
      class: "linklike",
      type: "button",
      text: "Resolve now",
      onclick: () => bulkFetchSubs(unresolved, "Resolved")
    })
  );
}

function syncBulkBar() {
  const bar = $("bulk-bar");
  $("select-mode-btn").classList.toggle("active", selectMode);
  $("select-mode-btn").textContent = selectMode ? "Done" : "Select";
  // Drop selections for rows no longer in the blocklist at all.
  for (const key of [...selected]) {
    const id = key.slice(2);
    const map = key[0] === "c" ? state.channels : state.videos;
    if (!map || !map[id]) selected.delete(key);
  }
  bar.hidden = !selectMode;
  const ch = [...selected].filter((k) => k[0] === "c").length;
  const vid = selected.size - ch;
  const parts = [];
  if (ch) parts.push(plural(ch, "channel"));
  if (vid) parts.push(plural(vid, "video"));
  $("bulk-count").textContent = selected.size ? `${parts.join(" + ")} selected` : "0 selected";
  // Mode and never-block only mean anything for channels.
  for (const id of ["bulk-videoonly", "bulk-full", "bulk-allow"]) $(id).disabled = ch === 0;
  for (const id of ["bulk-hide", "bulk-unblock", "bulk-clear-sel"]) $(id).disabled = selected.size === 0;
}

function renderList(listEl, emptyEl, moreEl, entries, build, key) {
  const limit = shown[key] || RENDER_CAP;
  const frag = document.createDocumentFragment();
  entries.slice(0, limit).forEach(([id, entry]) => frag.appendChild(build(id, entry)));
  listEl.replaceChildren(frag);
  emptyEl.hidden = entries.length > 0;
  emptyEl.textContent = filter ? `Nothing matches “${filter}”.` : "Nothing here.";

  // The rest of the list is reachable, not just announced: "Show more" grows
  // the limit a step at a time and "Show all" drops it entirely. Rendering
  // every row up front is what the cap exists to avoid, so growing on demand
  // keeps a 5,000-entry blocklist openable while still letting you get to the
  // bottom of it.
  moreEl.hidden = entries.length <= limit;
  if (entries.length <= limit) return;
  const step = Math.min(RENDER_STEP, entries.length - limit);
  moreEl.replaceChildren(
    `Showing ${limit.toLocaleString()} of ${entries.length.toLocaleString()}. `,
    h("button", {
      class: "linklike",
      type: "button",
      text: `Show ${step.toLocaleString()} more`,
      onclick: () => {
        shown[key] = limit + RENDER_STEP;
        render();
      }
    }),
    " · ",
    h("button", {
      class: "linklike",
      type: "button",
      text: `Show all ${entries.length.toLocaleString()}`,
      onclick: () => {
        shown[key] = Infinity;
        render();
      }
    })
  );
}

// ---------- row pieces ----------

// A coloured initial, stable per channel — a list of 5,000 names is far
// easier to scan with something to anchor the eye.
function avatarFor(label, seed) {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) | 0;
  const initial = [...String(label).replace(/^@/, "").trim()][0] || "?";
  return h("span", {
    class: "avatar",
    "aria-hidden": "true",
    style: `background:hsl(${Math.abs(hash) % 360} 52% 44%)`,
    text: initial
  });
}

async function copyText(text, what) {
  try {
    await navigator.clipboard.writeText(text);
    toast(`Copied ${what || text}.`);
  } catch {
    toast("Couldn't copy — your browser blocked clipboard access.", { error: true });
  }
}

// An id you can click to copy. `title` is the tooltip (a UC row shows its
// @handle and keeps the raw UC id there); the click copies what's shown.
function copyable(text, title) {
  return h("span", {
    class: "item-id copyable",
    text,
    title: title || "Click to copy",
    onclick: (e) => {
      e.stopPropagation();
      copyText(text);
    }
  });
}

function dateChip(ts) {
  if (!ts) return null;
  return h("span", { class: "item-date", text: "added " + fmtAgo(ts), title: new Date(ts).toLocaleString() });
}

// Select-mode checkbox, with shift-click ranges across the rendered rows.
function rowCheck(key, li) {
  const cb = h("input", { type: "checkbox", class: "row-check", checked: selected.has(key), "aria-label": "Select" });
  cb.dataset.key = key;
  cb.addEventListener("click", (e) => {
    const on = cb.checked;
    if (e.shiftKey && lastChecked && lastChecked !== key) {
      const boxes = [...document.querySelectorAll("#page-blocklist .row-check")];
      const a = boxes.findIndex((b) => b.dataset.key === lastChecked);
      const b = boxes.indexOf(cb);
      if (a >= 0 && b >= 0) {
        for (const box of boxes.slice(Math.min(a, b), Math.max(a, b) + 1)) {
          box.checked = on;
          if (on) selected.add(box.dataset.key);
          else selected.delete(box.dataset.key);
          box.closest("li").classList.toggle("selected", on);
        }
      }
    }
    if (on) selected.add(key);
    else selected.delete(key);
    li.classList.toggle("selected", on);
    lastChecked = key;
    syncBulkBar();
  });
  return cb;
}

// In select mode the whole row is a hit target, not just the 17px box.
function rowClickSelects(li, main) {
  main.addEventListener("click", (e) => {
    if (!selectMode || e.target.closest("button, a, input, .copyable, .subs-chip")) return;
    const cb = li.querySelector(":scope > .row-top > .row-check");
    if (cb) cb.click();
  });
}

function undoAction(undoTs) {
  if (undoTs == null) return undefined;
  return {
    label: "Undo",
    run: async () => {
      await send({ type: MSG.RESTORE_UNBLOCK, ts: undoTs });
      await refresh();
      toast("Restored.");
    }
  };
}

function deleteButton(onDelete) {
  return h("button", {
    class: "unblock-btn",
    type: "button",
    text: "Delete",
    title: "Unblock and remove from the list — you can undo it",
    onclick: onDelete
  });
}

function buildHideBtn(kind, id, entry) {
  const isHidden = !!entry.hidden;
  return h("button", {
    class: "hide-btn",
    type: "button",
    text: isHidden ? "Show in list" : "Hide from list",
    title: isHidden
      ? "List this row in the blocklist manager again"
      : "Keep it blocked but stop listing it here (find it again under Show → Hidden)",
    onclick: async () => {
      await send({ type: MSG.SET_ENTRY_HIDDEN, kind, id, hidden: !isHidden });
      toast(isHidden ? "Shown in the list again." : "Hidden from the list — still blocked.");
      refresh();
    }
  });
}

// ---------- channel row ----------
// CHANNEL_MODE.EXCEPT_WHITELIST channels get an extra "mode" tag, a toggle
// back to a full block, and an editable whitelist of video IDs that are
// let through despite the channel otherwise being fully video-blocked (see
// CHANNEL_MODE in shared/constants.js and channelBlocks() in shared/block-logic.js).
function buildChannelRow(id, entry) {
  const key = "c:" + id;
  const label = entry.name || entry.handle || id;
  const li = h("li", { class: "channel-row" + (selected.has(key) ? " selected" : "") });
  li.dataset.id = id; // real key (may be a UC… id); the visible label can differ

  const top = h("div", { class: "row-top" });
  if (selectMode) top.appendChild(rowCheck(key, li));
  top.appendChild(avatarFor(label, id));

  // Two lines, not one: the name reads on its own, and everything that used to
  // compete with it (id, sub count, block mode, local-only) drops to a quiet
  // meta line underneath. A row is scanned far more often than it is acted on.
  const main = h("div", { class: "row-main" });
  const name = h("div", { class: "item-name", text: label });
  main.appendChild(name);

  const meta = h("div", { class: "row-meta" });
  // A channel keyed by @handle gets NO visible id line: the handle is already
  // a readable identifier, and a row is dense enough without repeating it.
  // It stays reachable as a tooltip on the name instead. A UC…-keyed channel
  // does show its @handle once known, with the raw id as the tooltip.
  if (id.startsWith("@")) name.title = id;
  const idLabel = id.startsWith("@") ? null : entry.handle || id;
  if (idLabel && idLabel !== name.textContent) {
    meta.appendChild(copyable(idLabel, !id.startsWith("@") && entry.handle ? id : undefined));
  }

  // A gone channel gets no sub-count chip: the "gone" tag below already says
  // why there is no number, and "n/a subs" next to it is the same fact twice.
  if (!entry.gone) meta.appendChild(buildSubsChip(id, entry));

  const isSoft = entry.mode === CHANNEL_MODE.EXCEPT_WHITELIST;
  meta.appendChild(
    h("span", {
      class: "mode-tag" + (isSoft ? " soft" : ""),
      text: isSoft ? "Video-only" : "Full block",
      title: isSoft
        ? "Its page stays reachable; its videos are blocked except the ones you allow."
        : "The channel and everything from it is gone."
    })
  );
  if (entry.gone) {
    meta.appendChild(
      h("span", {
        class: "local-tag gone-tag",
        text: "gone",
        title: "This channel 404s — deleted, terminated, or renamed. It will not be re-fetched."
      })
    );
  }
  const date = dateChip(entry.ts);
  if (date) meta.appendChild(date);
  main.appendChild(meta);
  top.appendChild(main);
  rowClickSelects(li, main);

  // Right-hand column: only the action you actually reach for, plus a
  // disclosure for the rest. Everything secondary lives in the drawer below
  // rather than as four more buttons fighting for the same line.
  const moreBtn = h("button", { class: "row-more-btn", type: "button", text: "⋯", title: "More options" });
  moreBtn.setAttribute("aria-expanded", "false");
  const delBtn = deleteButton(async () => {
    li.classList.add("leaving");
    const res = await send({ type: MSG.UNBLOCK_CHANNEL, id });
    toast(`Deleted “${label}”.`, { action: undoAction(res && res.undoTs) });
    refresh();
  });
  top.appendChild(h("div", { class: "row-actions" }, moreBtn, delBtn));
  li.appendChild(top);

  const drawer = h("div", { class: "row-drawer" });
  const channelUrl = "https://www.youtube.com/" + (id.startsWith("@") ? id : "channel/" + id);
  drawer.appendChild(
    h(
      "div",
      { class: "drawer-btns" },
      h("button", {
        class: "mode-toggle-btn",
        type: "button",
        text: isSoft ? "Switch to full block" : "Switch to video-only",
        title: isSoft
          ? "Block the channel page and everything from it"
          : "Keep the channel page reachable; block its videos, with exceptions you choose",
        onclick: async () => {
          await send({ type: MSG.SET_CHANNEL_MODE, id, mode: isSoft ? CHANNEL_MODE.FULL : CHANNEL_MODE.EXCEPT_WHITELIST });
          toast(isSoft ? `“${label}” is fully blocked.` : `“${label}” is video-only now.`);
          refresh();
        }
      }),
      buildHideBtn("channel", id, entry),
      h("button", {
        class: "drawer-btn",
        type: "button",
        text: "Copy link",
        onclick: () => copyText(channelUrl, "the channel link")
      }),
      // A full block redirects its own page, so only offer to open one that
      // will actually load.
      isSoft &&
        h("a", {
          class: "drawer-btn",
          href: channelUrl,
          target: "_blank",
          rel: "noopener",
          text: "Open on YouTube ↗"
        })
    )
  );
  // The whitelist / age-rule editor only means anything in video-only mode.
  if (isSoft) drawer.appendChild(buildWhitelistSection(id, entry));
  li.appendChild(drawer);

  const setDrawer = (open) => {
    drawer.hidden = !open;
    moreBtn.setAttribute("aria-expanded", String(open));
    moreBtn.classList.toggle("open", open);
    if (open) openDrawers.add(id);
    else openDrawers.delete(id);
  };
  setDrawer(openDrawers.has(id));
  moreBtn.addEventListener("click", () => setDrawer(drawer.hidden));

  return li;
}

// ---------- video row ----------
function buildVideoRow(id, entry) {
  const key = "v:" + id;
  const label = entry.title || id;
  const li = h("li", { class: "video-row" + (selected.has(key) ? " selected" : "") });
  li.dataset.id = id;

  const top = h("div", { class: "row-top" });
  if (selectMode) top.appendChild(rowCheck(key, li));
  if (thumbs) {
    top.appendChild(
      h("img", { class: "thumb", src: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`, loading: "lazy", alt: "" })
    );
  }

  const main = h("div", { class: "row-main" });
  // Blocked from a right-click or by pasting an id, a video may have no title
  // saved; say so instead of printing the id twice.
  main.appendChild(
    entry.title
      ? h("div", { class: "item-name", text: entry.title })
      : h("div", { class: "item-name untitled", text: "Untitled video" })
  );
  const meta = h("div", { class: "row-meta" }, copyable(id, `https://www.youtube.com/watch?v=${id}`));
  const date = dateChip(entry.ts);
  if (date) meta.appendChild(date);
  main.appendChild(meta);
  top.appendChild(main);
  rowClickSelects(li, main);

  top.appendChild(
    h(
      "div",
      { class: "row-actions" },
      buildHideBtn("video", id, entry),
      deleteButton(async () => {
        li.classList.add("leaving");
        const res = await send({ type: MSG.UNBLOCK_VIDEO, id });
        toast(`Deleted “${label}”.`, { action: undoAction(res && res.undoTs) });
        refresh();
      })
    )
  );
  li.appendChild(top);
  return li;
}

function subsAttempted(entry) {
  // An attempt only counts if it was made by the *current* scrape. Version 1
  // read the first sub count in the channel's HTML, which was frequently some
  // other channel's — so those numbers are wrong, not merely old, and the one
  // sweep that replaces them has to be allowed to happen. After it, `subsV` is
  // current and the entry is never fetched again.
  return !!(entry && entry.subsAt && (entry.subsV || 0) >= SUBS_SCRAPE_VERSION);
}

function buildSubsChip(id, entry) {
  const chip = h("span", { class: "subs-chip" });
  if (entry.subs) {
    chip.textContent = entry.subs === "hidden" ? "subs hidden" : entry.subs + " subs";
    chip.title = "Click to refresh";
  } else {
    chip.textContent = "get subs";
    chip.classList.add("action");
    chip.title = "Look up this channel's subscriber count";
  }
  chip.addEventListener("click", async () => {
    if (chip.dataset.loading) return;
    chip.dataset.loading = "1";
    chip.textContent = "…";
    const res = await send({ type: MSG.FETCH_CHANNEL_SUBS, id });
    delete chip.dataset.loading;
    if (!res || !res.ok) {
      chip.textContent = "n/a";
      chip.title = "Couldn't read a subscriber count (hidden, region-blocked, or markup changed)";
    }
    // storage.onChanged -> refresh() repaints with the cached value
  });
  return chip;
}

// Per-channel "only block videos older than N days" rule. Off = block every
// video (the default). On = keep uploads newer than N days visible; whitelist
// IDs always stay. Enforced by shared/block-logic.js's channelBlocks() (see
// there for the unknown-age / non-English-locale caveats).
function buildAgeRule(channelId, entry) {
  const on = entry.blockOlderThanDays > 0;
  const cb = h("input", { type: "checkbox", checked: on, id: "age-" + channelId });
  const days = h("input", {
    type: "number",
    min: "1",
    class: "age-days",
    value: on ? String(entry.blockOlderThanDays) : "7",
    disabled: !on
  });

  // Saves as you go. It used to need a separate Save click after ticking the
  // box, and a rule ticked but never saved looked set while doing nothing.
  const commit = async (d) => {
    await send({ type: MSG.SET_CHANNEL_AGE_RULE, id: channelId, days: d });
    toast(d ? `Only videos older than ${plural(d, "day")} are blocked now.` : "Age rule off — every video is blocked.");
    refresh();
  };
  const current = () => Math.max(1, Math.floor(Number(days.value) || 0));
  cb.addEventListener("change", () => {
    days.disabled = !cb.checked;
    commit(cb.checked ? current() : 0);
  });
  days.addEventListener("change", () => {
    if (cb.checked) commit(current());
  });

  return h(
    "div",
    { class: "age-rule" },
    cb,
    h("label", { htmlFor: cb.id, text: "Only block videos older than" }),
    days,
    h("span", { text: "days" })
  );
}

function buildWhitelistSection(channelId, channelEntry) {
  const whitelist = channelEntry.whitelist || {};
  const entries = Object.entries(whitelist);
  const ageDays = channelEntry.blockOlderThanDays > 0 ? channelEntry.blockOlderThanDays : 0;

  // Collapsed by default so a page full of video-only channels stays short.
  const details = h("details", { class: "whitelist-details", open: openWhitelists.has(channelId) });
  details.addEventListener("toggle", () => {
    if (details.open) openWhitelists.add(channelId);
    else openWhitelists.delete(channelId);
  });
  const bits = [];
  if (ageDays) bits.push(`only block older than ${ageDays}d`);
  bits.push(`${entries.length} allowed`);
  details.appendChild(h("summary", { text: `Whitelist & age rule — ${bits.join(" · ")}` }));

  const wrap = h("div", { class: "whitelist" });
  details.appendChild(wrap);
  wrap.appendChild(buildAgeRule(channelId, channelEntry));

  if (!entries.length) {
    wrap.appendChild(
      h("p", {
        class: "empty-inline",
        text: ageDays
          ? `No always-allow exceptions. Videos newer than ${ageDays} days already stay visible.`
          : "No exceptions yet — every video from this channel is blocked."
      })
    );
  } else {
    wrap.appendChild(
      h(
        "ul",
        { class: "whitelist-list" },
        entries.map(([videoId, title]) =>
          h(
            "li",
            null,
            h("span", { class: "item-name", text: title || videoId }),
            h("span", { class: "item-id", text: videoId }),
            h("button", {
              class: "unblock-btn",
              type: "button",
              text: "Remove",
              onclick: async () => {
                await send({ type: MSG.UNWHITELIST_CHANNEL_VIDEO, id: channelId, videoId });
                refresh();
              }
            })
          )
        )
      )
    );
  }

  const input = h("input", { type: "text", placeholder: "Paste a video URL or ID to allow it" });
  const allow = async () => {
    const videoId = extractVideoId(input.value.trim());
    if (!videoId) {
      toast("No video ID in that — paste a youtube.com/watch?v=… URL, a youtu.be link, or the 11-character ID.", {
        error: true
      });
      return;
    }
    await send({ type: MSG.WHITELIST_CHANNEL_VIDEO, id: channelId, videoId, title: "" });
    input.value = "";
    toast("Allowed — that video stays visible.");
    refresh();
  };
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") allow();
  });
  wrap.appendChild(
    h("div", { class: "whitelist-add" }, input, h("button", { class: "btn", type: "button", text: "Allow", onclick: allow }))
  );
  return details;
}

function extractVideoId(text) {
  if (!text) return null;
  const m =
    text.match(/[?&]v=([\w-]{11})/) ||
    text.match(/\/(?:shorts|live|embed|v)\/([\w-]{11})/) ||
    text.match(/youtu\.be\/([\w-]{11})/) ||
    text.match(/^([\w-]{11})$/);
  return m ? m[1] : null;
}

// "@handle" | "UC…" | a channel URL -> a normalized channel key, or null.
function extractChannelKey(text) {
  const s = (text || "").trim();
  if (!s) return null;
  let m = s.match(/(UC[\w-]{22})/);
  if (m) return m[1];
  m = s.match(/@[\w.-]{2,}/);
  if (m) return m[0].toLowerCase();
  return null;
}

// Free text -> what it names. Accepts anything separated by spaces, commas
// or new lines: channel URLs, @handles, UC ids, video URLs, bare video ids.
// /c/… and /user/… name neither identity format, so they are reported rather
// than guessed at: blocking the wrong channel is worse than blocking nothing.
function parseTargets(text) {
  const out = { channels: [], videos: [], unknown: [] };
  for (const tok of String(text || "").split(/[\s,]+/).filter(Boolean)) {
    const looksChannel = /^@|^UC[\w-]{22}$|youtube\.com\/(?:channel\/|@)/i.test(tok);
    const key = looksChannel ? extractChannelKey(tok) : null;
    const vid = key ? null : extractVideoId(tok);
    if (key) out.channels.push(key);
    else if (vid) out.videos.push(vid);
    else out.unknown.push(tok);
  }
  out.channels = [...new Set(out.channels)];
  out.videos = [...new Set(out.videos)];
  return out;
}

// An <input type=text> silently deletes line breaks from pasted text, which
// glues a pasted column of ids into one unreadable token. Turn them into
// spaces first so a list from a spreadsheet or a text file just works.
function keepPastedLines(input) {
  input.addEventListener("paste", (e) => {
    const text = e.clipboardData && e.clipboardData.getData("text");
    if (!text || !/[\r\n]/.test(text)) return;
    e.preventDefault();
    const flat = text.split(/[\r\n]+/).map((s) => s.trim()).filter(Boolean).join(" ");
    const { selectionStart: a, selectionEnd: b, value } = input;
    input.value = value.slice(0, a) + flat + value.slice(b);
    input.setSelectionRange(a + flat.length, a + flat.length);
  });
}

// ---------- toasts & dialogs ----------
function toast(text, { action, error, ms } = {}) {
  const box = $("toasts");
  const t = h("div", { class: "toast" + (error ? " error" : ""), role: "status" }, h("span", { text }));
  let timer = null;
  const close = () => {
    clearTimeout(timer);
    t.remove();
  };
  if (action) {
    t.append(
      h("button", {
        type: "button",
        text: action.label,
        onclick: async () => {
          close();
          await action.run();
        }
      })
    );
  }
  t.append(h("button", { type: "button", text: "✕", "aria-label": "Dismiss", onclick: close }));
  box.append(t);
  while (box.children.length > 3) box.firstElementChild.remove();
  timer = setTimeout(close, ms || (action ? 9000 : error ? 6000 : 3500));
  return close;
}

let modalResolve = null;
// Promise-based replacement for confirm(): resolves true on confirm, false on
// cancel / Esc / a click outside. `requireText` keeps the confirm button
// disabled until that word is typed — reserved for "delete everything".
function openModal({ title, body, confirmLabel = "OK", cancelLabel = "Cancel", danger, extra, requireText, noCancel }) {
  if (modalResolve) closeModal(false);
  return new Promise((resolve) => {
    modalResolve = resolve;
    $("modal-title").textContent = title;
    const bodyEl = $("modal-body");
    bodyEl.replaceChildren();
    for (const part of [].concat(body || [])) {
      bodyEl.append(typeof part === "string" ? h("p", { text: part }) : part);
    }
    const ok = $("modal-confirm");
    ok.textContent = confirmLabel;
    ok.className = "btn primary" + (danger ? " danger" : "");
    ok.disabled = false;
    $("modal-cancel").textContent = cancelLabel;
    $("modal-cancel").hidden = !!noCancel;
    const ex = $("modal-extra");
    ex.hidden = !extra;
    ex.onclick = extra ? extra.run : null;
    if (extra) ex.textContent = extra.label;
    if (requireText) {
      const input = h("input", { type: "text", placeholder: `Type “${requireText}” to confirm`, spellcheck: false });
      ok.disabled = true;
      input.addEventListener("input", () => {
        ok.disabled = input.value.trim().toLowerCase() !== requireText.toLowerCase();
      });
      input.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && !ok.disabled) closeModal(true);
      });
      bodyEl.append(input);
      $("modal").hidden = false;
      input.focus();
    } else {
      $("modal").hidden = false;
      ok.focus();
    }
  });
}
function closeModal(result) {
  $("modal").hidden = true;
  const r = modalResolve;
  modalResolve = null;
  if (r) r(result);
}
$("modal-confirm").addEventListener("click", () => closeModal(true));
$("modal-cancel").addEventListener("click", () => closeModal(false));
$("modal").addEventListener("mousedown", (e) => {
  if (e.target === $("modal")) closeModal(false);
});

// The standard "are you sure" for anything that deletes, with the backup one
// click away inside the dialog itself.
function confirmDelete(title, lines, { confirmLabel = "Delete", requireText } = {}) {
  return openModal({
    title,
    body: [...[].concat(lines), "It syncs to your other devices, and you can undo it from Recently removed."],
    confirmLabel,
    danger: true,
    requireText,
    extra: { label: "Download a backup first", run: () => exportBackup() }
  });
}

// ---------- never-block list ----------
function renderAllowlist() {
  const ul = $("allow-list");
  const list = (state.allowlist && typeof state.allowlist === "object" && state.allowlist) || {};
  const keys = Object.keys(list).sort((a, b) => (list[b].ts || 0) - (list[a].ts || 0));
  setNavCount("nav-allowlist", keys.length);
  $("allow-total").textContent = keys.length ? `(${keys.length})` : "";
  $("allow-clear").hidden = keys.length === 0;

  // Name lookup by every identity a blocklist entry answers to.
  const names = new Map();
  for (const [id, e] of Object.entries(state.channels || {})) {
    if (!e.name) continue;
    names.set(id[0] === "@" ? id.toLowerCase() : id, e.name);
    if (e.handle) names.set(String(e.handle).toLowerCase(), e.name);
    if (e.ucid) names.set(e.ucid, e.name);
  }
  ul.replaceChildren(
    ...keys.map((key) => {
      const name = names.get(key);
      return h(
        "li",
        null,
        avatarFor(name || key, key),
        h("div", { class: "row-main" }, h("div", { class: "item-name", text: name || key }), name && copyable(key)),
        h("button", {
          class: "unblock-btn",
          type: "button",
          text: "Remove",
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            await send({ type: MSG.DISALLOW_CHANNEL, id: key });
            toast(`“${name || key}” can be blocked again.`, {
              action: {
                label: "Undo",
                run: async () => {
                  await send({ type: MSG.ALLOW_CHANNEL, id: key });
                  refresh();
                }
              }
            });
            refresh();
          }
        })
      );
    })
  );
  $("allow-empty").hidden = keys.length > 0;
}

function initAllowlist() {
  const input = $("allow-input");
  keepPastedLines(input);
  const add = async () => {
    const tokens = input.value.split(/[\s,]+/).filter(Boolean);
    const keys = [...new Set(tokens.map(extractChannelKey).filter(Boolean))];
    if (!keys.length) {
      toast("Couldn't read a channel from that — paste an @handle, a UC… ID, or a channel URL.", { error: true });
      return;
    }
    input.value = "";
    await send({ type: MSG.ALLOW_CHANNEL, ids: keys });
    const bad = tokens.length - keys.length;
    toast(`Never block: added ${plural(keys.length, "channel")}.` + (bad > 0 ? ` ${bad} couldn't be read.` : ""));
    refresh();
  };
  $("allow-add-btn").addEventListener("click", add);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") add();
  });
  $("allow-clear").addEventListener("click", async () => {
    const n = Object.keys(state.allowlist || {}).length;
    if (!(await confirmDelete("Clear the never-block list?", `All ${plural(n, "channel")} on it can be blocked again.`, { confirmLabel: "Clear list" }))) {
      return;
    }
    const res = await send({ type: MSG.DELETE_DATA, allowlist: true });
    toast("Never-block list cleared.", { action: undoAction(res && res.undoTs) });
    refresh();
  });
}
initAllowlist();

// ---------- top-level pages ----------
function showPage(name) {
  if (!$("page-" + name)) name = "blocklist";
  document.querySelectorAll(".page-tab").forEach((b) => b.classList.toggle("active", b.dataset.page === name));
  document.querySelectorAll(".page").forEach((p) => (p.hidden = p.id !== "page-" + name));
  try {
    localStorage.setItem("bt-page", name);
  } catch {}
}
document.querySelectorAll(".page-tab").forEach((btn) => {
  btn.addEventListener("click", () => showPage(btn.dataset.page));
});
try {
  const saved = localStorage.getItem("bt-page");
  if (saved && $("page-" + saved)) showPage(saved);
} catch {}
// options.html#data (the popup's "Backup & import") opens straight onto a page.
if (location.hash && $("page-" + location.hash.slice(1))) showPage(location.hash.slice(1));

// ---------- blocklist toolbar ----------
let searchTimer = null;
$("search").addEventListener("input", (e) => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    filter = e.target.value.trim().toLowerCase();
    resetShown(); // a different set of rows — start from the top again
    render();
  }, 120);
});

function setTab(next) {
  tab = next;
  resetShown();
  render();
}
$("filter-by").addEventListener("change", (e) => setTab(e.target.value));
document.querySelectorAll(".stat[data-show]").forEach((b) =>
  b.addEventListener("click", () => {
    setTab(b.dataset.show);
    $("search").focus();
  })
);

$("sort-by").value = sortBy;
$("sort-by").addEventListener("change", (e) => {
  sortBy = e.target.value;
  savePrefs();
  resetShown();
  render();
});

$("hide-small").checked = hideSmall;
$("small-threshold").value = String(smallThreshold);
$("hide-small").addEventListener("change", (e) => {
  hideSmall = e.target.checked;
  savePrefs();
  render();
});
$("small-threshold").addEventListener("change", (e) => {
  smallThreshold = Math.max(0, Math.floor(Number(e.target.value) || 0));
  savePrefs();
  if (hideSmall) render();
});

// Thumbnails toggle lives in the ⋯ menu, next to the other view options.
(() => {
  const cb = h("input", { type: "checkbox", checked: thumbs });
  cb.addEventListener("change", () => {
    thumbs = cb.checked;
    savePrefs();
    render();
  });
  $("small-threshold").closest("label").after(h("label", { class: "menu-item ctl" }, cb, "Show video thumbnails"));
})();

// The ⋯ menu. Closes on outside click and on Escape, so it never strands.
const menuBtn = $("bl-menu-btn");
const menuEl = $("bl-menu");
function setMenu(open) {
  menuEl.hidden = !open;
  menuBtn.setAttribute("aria-expanded", String(open));
}
menuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  setMenu(menuEl.hidden);
});
menuEl.addEventListener("click", (e) => {
  // Leave the view options open — they're controls, not commands.
  if (!e.target.closest("label")) setMenu(false);
});
document.addEventListener("click", (e) => {
  if (!menuEl.hidden && !menuEl.contains(e.target) && e.target !== menuBtn) setMenu(false);
});

$("menu-export-btn").addEventListener("click", () => exportBackup());
$("menu-import-btn").addEventListener("click", () => $("import-input").click());

// ---------- delete-all actions ----------
async function deleteAll(kind) {
  const n = Object.keys((kind === "channels" ? state.channels : state.videos) || {}).length;
  if (!n) return;
  const ok = await confirmDelete(
    kind === "channels" ? `Delete all ${plural(n, "channel")}?` : `Delete all ${plural(n, "blocked video")}?`,
    kind === "channels"
      ? "Every blocked channel is unblocked and removed from the list. Blocked videos, keywords and the never-block list stay."
      : "Every individually blocked video is unblocked. Channels are not touched."
  );
  if (!ok) return;
  const res = await send({ type: MSG.DELETE_DATA, [kind]: "all" });
  await refresh();
  const r = (res && res.removed) || {};
  toast(`Deleted ${plural(r[kind] || 0, kind === "channels" ? "channel" : "video")}.`, {
    action: undoAction(res && res.undoTs)
  });
}
$("clear-videos-btn").addEventListener("click", () => deleteAll("videos"));
$("clear-channels-btn").addEventListener("click", () => deleteAll("channels"));
$("delete-all-videos-btn").addEventListener("click", () => deleteAll("videos"));
$("delete-all-channels-btn").addEventListener("click", () => deleteAll("channels"));

// ---------- bulk-select mode ----------
function setSelectMode(on) {
  selectMode = on;
  if (!on) {
    selected.clear();
    lastChecked = null;
  }
  render();
}
$("select-mode-btn").addEventListener("click", () => setSelectMode(!selectMode));

function shownKeys() {
  return Array.from(document.querySelectorAll("#page-blocklist .row-check")).map((cb) => cb.dataset.key);
}
$("bulk-select-all").addEventListener("click", () => {
  shownKeys().forEach((k) => selected.add(k));
  render();
});
$("bulk-clear-sel").addEventListener("click", () => {
  selected.clear();
  render();
});

const selectedIds = (kind) => [...selected].filter((k) => k[0] === kind).map((k) => k.slice(2));

// Run one bulk message, then refresh once. Every bulk message takes `ids`, so
// a selection of any size is a single storage write in the background.
async function bulkRun(label, run, confirmOpts) {
  if (!selected.size) return;
  if (confirmOpts && !(await openModal(confirmOpts))) return;
  const bar = $("bulk-bar");
  bar.querySelectorAll("button").forEach((b) => (b.disabled = true));
  suppressStorageRefresh = true;
  let res;
  try {
    res = await run();
  } finally {
    suppressStorageRefresh = false;
  }
  selected.clear();
  lastChecked = null;
  await refresh();
  toast(label, res && res.undoTs != null ? { action: undoAction(res.undoTs) } : undefined);
}

$("bulk-hide").addEventListener("click", () => {
  const ch = selectedIds("c");
  const vid = selectedIds("v");
  bulkRun(`Hidden from the list: ${ch.length + vid.length} — still blocked.`, async () => {
    if (ch.length) await send({ type: MSG.SET_ENTRY_HIDDEN, kind: "channel", ids: ch, hidden: true });
    if (vid.length) await send({ type: MSG.SET_ENTRY_HIDDEN, kind: "video", ids: vid, hidden: true });
  });
});
$("bulk-videoonly").addEventListener("click", () => {
  const ch = selectedIds("c");
  bulkRun(`Switched ${plural(ch.length, "channel")} to video-only.`, () =>
    send({ type: MSG.SET_CHANNEL_MODE, ids: ch, mode: CHANNEL_MODE.EXCEPT_WHITELIST })
  );
});
$("bulk-full").addEventListener("click", () => {
  const ch = selectedIds("c");
  bulkRun(`${plural(ch.length, "channel")} fully blocked.`, () =>
    send({ type: MSG.SET_CHANNEL_MODE, ids: ch, mode: CHANNEL_MODE.FULL })
  );
});
$("bulk-allow").addEventListener("click", () => {
  const ch = selectedIds("c");
  bulkRun(`Added ${plural(ch.length, "channel")} to never-block.`, () => send({ type: MSG.ALLOW_CHANNEL, ids: ch }), {
    title: `Never block ${plural(ch.length, "channel")}?`,
    body: "They stay in the blocklist, but nothing from them will be hidden while they're on the never-block list.",
    confirmLabel: "Never block"
  });
});
$("bulk-unblock").addEventListener("click", () => {
  const ch = selectedIds("c");
  const vid = selectedIds("v");
  const parts = [];
  if (ch.length) parts.push(plural(ch.length, "channel"));
  if (vid.length) parts.push(plural(vid.length, "video"));
  bulkRun(`Deleted ${parts.join(" and ")}.`, () => send({ type: MSG.DELETE_DATA, channels: ch, videos: vid }), {
    title: `Delete ${parts.join(" and ")}?`,
    body: "They're unblocked and removed from the list. You can undo it from Recently removed.",
    confirmLabel: "Delete",
    danger: true
  });
});

// ---------- sub counts ----------
// The lookup runs in the background (START_SWEEP) — it keeps going after this
// page closes, and pauses itself when YouTube throttles. This page only queues
// channels and shows the progress the background writes to `bt_sweep`.
async function bulkFetchSubs(ids, label) {
  if (!ids.length) {
    toast("Every channel here already has a subscriber count.");
    return;
  }
  const res = await send({ type: MSG.START_SWEEP, ids, label });
  if (res && res.sweep) renderSweep(res.sweep);
}

let sweepSeenRunning = false;
function renderSweep(sw) {
  const running = !!(sw && sw.queued > 0);
  bulkRunning = running;
  const progress = $("bulk-progress");
  const btn = $("fetch-all-subs-btn");
  progress.hidden = !running;
  if (running) {
    sweepSeenRunning = true;
    btn.hidden = false;
    btn.classList.add("bulk-active");
    btn.textContent = "Stop fetching";
    $("enrich-note").hidden = true;
    const done = sw.total - sw.queued;
    const paused = sw.pauseUntil > Date.now();
    $("bulk-progress-bar").style.width = sw.total ? `${(100 * done) / sw.total}%` : "0";
    $("bulk-progress-text").textContent =
      `Fetching sub counts and @handles… ${done.toLocaleString()} / ${sw.total.toLocaleString()}` +
      (paused
        ? ` · paused, YouTube is throttling — resuming ${new Date(sw.pauseUntil).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
        : " · keeps going if you close this page");
    return;
  }
  btn.classList.remove("bulk-active");
  if (sweepSeenRunning) {
    // It just finished (or was stopped) while this page was watching.
    sweepSeenRunning = false;
    toast(
      sw.stopped
        ? `Stopped — ${sw.got.toLocaleString()} of ${sw.total.toLocaleString()} fetched. Run it again to resume.`
        : `${sw.label || "Done"}: ${sw.got.toLocaleString()} fetched${sw.missed ? `, ${sw.missed.toLocaleString()} unavailable` : ""}.`,
      { ms: 6000 }
    );
    refresh();
  }
}
// Progress arrives as storage writes from the background.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.bt_sweep) {
    const { queue, ...rest } = changes.bt_sweep.newValue || { queue: [] };
    renderSweep({ ...rest, queued: (queue || []).length });
  }
});

const stopSweep = () => send({ type: MSG.STOP_SWEEP }).then((r) => r && renderSweep(r.sweep));
$("bulk-stop").addEventListener("click", stopSweep);

// "Load sub counts" — just the channels currently rendered.
$("load-subs-btn").addEventListener("click", () => {
  if (bulkRunning) return stopSweep();
  const ids = Array.from(document.querySelectorAll("#channel-list .channel-row")).map((li) => li.dataset.id);
  bulkFetchSubs(ids.filter((id) => state.channels[id] && !subsAttempted(state.channels[id])), "Done");
});

// "Fetch all sub counts" — the entire blocklist, not just what's on screen.
// Doubles as a Stop button while running. Resumable: re-running skips channels
// that already got a fresh count.
$("fetch-all-subs-btn").addEventListener("click", () => {
  if (bulkRunning) return stopSweep();
  const ids = Object.keys(state.channels).filter((id) => !subsAttempted(state.channels[id]));
  bulkFetchSubs(ids, "All done");
});

// ---------- quick add ----------
keepPastedLines($("quick-add-input"));
$("quick-add").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("quick-add-input");
  const t = parseTargets(input.value);
  if (!t.channels.length && !t.videos.length) {
    toast(
      t.unknown.length
        ? `Couldn't tell what “${t.unknown[0]}” is. Use an @handle, a UC… ID, or a channel or video link. (/c/ and /user/ links name no channel — open it and block from the page.)`
        : "Paste a channel or a video first.",
      { error: true, ms: 8000 }
    );
    return;
  }
  const mode = $("quick-add-mode").value;
  const channels = {};
  for (const k of t.channels) channels[k] = { name: "", mode, whitelist: {} };
  const videos = {};
  for (const v of t.videos) videos[v] = { title: "" };
  $("quick-add-btn").disabled = true;
  const res = await send({ type: MSG.IMPORT_BLOCKLIST, channels, videos });
  $("quick-add-btn").disabled = false;
  input.value = "";
  await refresh();

  const added = (res && res.added) || { channels: 0, videos: 0 };
  const already = t.channels.length + t.videos.length - added.channels - added.videos;
  const parts = [];
  if (added.channels) parts.push(plural(added.channels, "channel"));
  if (added.videos) parts.push(plural(added.videos, "video"));
  toast(
    (parts.length ? `Blocked ${parts.join(" and ")}.` : "Nothing new to block.") +
      (already > 0 ? ` ${already} already blocked.` : "") +
      (t.unknown.length ? ` ${t.unknown.length} not recognised.` : "")
  );

  // Fill in what a pasted key can't say: the channel's name, its other
  // identity (without which it doesn't block everywhere), its sub count —
  // and a video's title.
  if (t.videos.length) fillVideoTitles(t.videos);
  const fresh = t.channels.filter((k) => state.channels[k] && !subsAttempted(state.channels[k]));
  if (fresh.length) bulkFetchSubs(fresh, "Looked up");
});

// Titles for videos added by id. oEmbed is the same public, key-free endpoint
// the background already uses for /embed/ pages; the extension's youtube.com
// host permission is what lets this page read it.
async function fillVideoTitles(ids) {
  const videos = {};
  await Promise.all(
    ids.slice(0, 50).map(async (id) => {
      try {
        const r = await fetch(
          "https://www.youtube.com/oembed?format=json&url=" + encodeURIComponent("https://www.youtube.com/watch?v=" + id)
        );
        if (!r.ok) return;
        const d = await r.json();
        if (d && d.title) videos[id] = { title: String(d.title) };
      } catch {}
    })
  );
  if (Object.keys(videos).length) {
    await send({ type: MSG.IMPORT_BLOCKLIST, channels: {}, videos });
    refresh();
  }
}

// ---------- backup ----------
async function exportBackup() {
  const [bl, stored] = await Promise.all([
    send({ type: MSG.GET_BLOCKLIST }),
    chrome.storage.sync.get([KEYWORDS_KEY, SETTINGS_KEY])
  ]);
  const kw = stored[KEYWORDS_KEY] || {};
  const backup = {
    format: "xrntube-backup",
    version: 2,
    exportedAt: new Date().toISOString(),
    channels: bl.channels,
    videos: bl.videos,
    allowlist: bl.allowlist || {},
    keywords: {
      list: Array.isArray(kw.list) ? kw.list : [],
      durMinSec: Number(kw.durMinSec) || 0,
      durMaxSec: Number(kw.durMaxSec) || 0,
      commentLimit: kw.commentLimit === undefined ? DEFAULT_COMMENT_LIMIT : Number(kw.commentLimit) || 0
    },
    settings: resolveSettings(stored[SETTINGS_KEY])
  };
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = h("a", { href: url, download: `xrntube-backup-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast(
    `Backup saved — ${plural(Object.keys(backup.channels).length, "channel")}, ${plural(
      Object.keys(backup.videos).length,
      "video"
    )}, ${plural(backup.keywords.list.length, "keyword")}.`
  );
}
$("export-btn").addEventListener("click", () => exportBackup());

// ---------- import ----------
const CHANNEL_KEY_RE = /^(UC[\w-]{22}|@[\w.\-%]+)$/;
const VIDEO_ID_RE = /^[\w-]{11}$/;

// The original BlockTube extension's export → what XrnTube can take from it.
//
// Its filterData fields are text lists, one rule per line (an array of lines,
// or one newline-joined string, depending on the version that wrote it):
//   channelId  — a `// Blocked by … (<name>) (<date>)` comment, then the id
//   videoId    — the same shape, keyed by video id
//   title      — title keywords, `/regex/flags` or plain text
//   vidLength  — [minSeconds, maxSeconds]
//   channelName, comment, javascript — rules XrnTube has no equivalent for
// Everything that can't come across is listed in `skipped` with the reason,
// so an import can be checked line by line rather than trusted blindly.
function convertOldBlockTube(raw) {
  const fd = raw.filterData || (raw.storageData && raw.storageData.filterData) || {};
  const lines = (v) =>
    Array.isArray(v) ? v.map(String) : typeof v === "string" ? v.split(/\r?\n/) : [];
  const skipped = [];
  const skip = (field, value, why) => skipped.push({ field, value: String(value).trim(), why });

  // "// Blocked by context menu (Some (Name)) (7/13/2026, 11:56:13 PM)" —
  // greedy on the name so one with its own parentheses survives; the date is
  // the LAST parenthesised group, and only if it has a digit in it.
  const COMMENT_RE = /^\/\/\s*Blocked by\b[^(]*\((.*)\)\s*\(([^()]*\d[^()]*)\)\s*$/;
  const COMMENT_NO_DATE_RE = /^\/\/\s*Blocked by\b[^(]*\((.*)\)\s*$/;
  const toTs = (s) => {
    let t = Date.parse(s);
    if (Number.isNaN(t)) {
      // D/M/Y (en-GB and most of the world) or time-first locales
      const m = s.match(/(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
      if (m) t = Date.UTC(+m[3], +m[2] - 1, +m[1]);
    }
    return Number.isNaN(t) ? 0 : t;
  };

  const parseIds = (field, toId, what) => {
    const out = {};
    let name = "";
    let ts = 0;
    let partial = null; // a comment whose name ran onto the next line
    const all = lines(fd[field]);
    all.forEach((ln, i) => {
      // "UCxxxx  // note" — a trailing comment on an id line is just a note.
      const s = ln.trim().replace(/^([^/\s][^\s]*)\s+\/\/.*$/, "$1");
      if (!s) return;
      if (s.startsWith("//")) {
        partial = null;
        const m = s.match(COMMENT_RE) || s.match(COMMENT_NO_DATE_RE);
        if (m) {
          name = m[1].trim();
          ts = m[2] ? toTs(m[2]) : 0;
        } else if (/^\/\/\s*Blocked by\b/.test(s)) {
          partial = s; // unterminated: the channel's name had a line break in it
        }
        return; // any other comment is just a comment
      }
      const id = toId(s);
      if (id) {
        // A bare id with no comment gets a stamp that still keeps the file's
        // order (later lines are newer), so "Newest first" means something.
        if (!out[id]) out[id] = { name, ts: ts || Date.now() - (all.length - i) * 1000 };
        name = "";
        ts = 0;
        partial = null;
        return;
      }
      if (partial) {
        const m = (partial + " " + s).match(COMMENT_RE) || (partial + " " + s).match(COMMENT_NO_DATE_RE);
        if (m) {
          name = m[1].trim();
          ts = m[2] ? toTs(m[2]) : 0;
          partial = null;
          return;
        }
        partial += " " + s;
        return;
      }
      skip(field, s, `not ${what}`);
    });
    return out;
  };

  const channelIdOf = (s) => {
    if (CHANNEL_KEY_RE.test(s)) return s;
    const m = s.match(/youtube\.com\/(?:channel\/(UC[\w-]{22})|(@[\w.\-%]+))/i);
    return m ? m[1] || m[2] : null;
  };
  const videoIdOf = (s) => (VIDEO_ID_RE.test(s) ? s : extractVideoId(s));

  const channels = {};
  for (const [id, v] of Object.entries(parseIds("channelId", channelIdOf, "a channel ID, @handle or channel link"))) {
    channels[id] = { name: v.name, ts: v.ts, mode: CHANNEL_MODE.FULL, whitelist: {} };
  }
  const videos = {};
  for (const [id, v] of Object.entries(parseIds("videoId", videoIdOf, "a video ID or link"))) {
    videos[id] = { title: v.name, ts: v.ts };
  }

  const keywords = [];
  for (const ln of lines(fd.title)) {
    const s = ln.trim();
    if (!s || s.startsWith("//")) continue;
    const re = s.match(/^\/(.+)\/([a-z]*)$/);
    if (re) {
      try {
        new RegExp(re[1]);
        keywords.push({ p: re[1], re: true });
      } catch (e) {
        skip("title", s, "invalid regular expression");
      }
    } else {
      keywords.push({ p: s, re: false });
    }
  }

  // Display-name rules can't be honoured safely: two channels can share a
  // name, and blocking the wrong one is worse than blocking nothing.
  for (const ln of lines(fd.channelName)) {
    const s = ln.trim();
    if (s && !s.startsWith("//")) {
      skip("channelName", s, "XrnTube never blocks by display name (two channels can share one) — block it from YouTube instead");
    }
  }
  for (const ln of lines(fd.comment)) {
    const s = ln.trim();
    if (s && !s.startsWith("//")) skip("comment", s, "XrnTube has no comment-text filter");
  }
  // The JS filter ships as a do-nothing template; only report one that has
  // real code in it and was switched on.
  const js = typeof fd.javascript === "string" ? fd.javascript.trim() : "";
  const jsCode = js
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "")
    .replace(/\s+/g, "");
  const jsTrivial =
    !jsCode ||
    /^\(?[\w,]*\)?=>\{?(returnfalse;?)?\}?;?$/.test(jsCode) ||
    /^function\w*\([\w,]*\)\{(returnfalse;?)?\};?$/.test(jsCode);
  const jsOn = !(raw.options && raw.options.enable_javascript === false);
  if (!jsTrivial && jsOn) {
    skip("javascript", js.slice(0, 120) + (js.length > 120 ? "…" : ""), "custom JavaScript filters aren't supported");
  }
  if (Number(fd.percentWatchedHide) > 0) {
    skip("percentWatchedHide", `${fd.percentWatchedHide}%`, "hiding already-watched videos isn't supported");
  }

  let duration = null;
  if (Array.isArray(fd.vidLength)) {
    const min = Math.max(0, Math.floor(Number(fd.vidLength[0]) || 0));
    const max = Math.max(0, Math.floor(Number(fd.vidLength[1]) || 0));
    if (min || max) duration = { minSec: min, maxSec: max };
  }

  return { channels, videos, keywords, duration, skipped };
}

// Any supported file → one normalised plan. Throws with a readable message
// when the file isn't a blocklist at all.
function buildImportPlan(data) {
  if (Array.isArray(data)) {
    // A bare list of ids / links.
    const t = parseTargets(data.join(" "));
    const plan = emptyPlan("a list of channels and videos");
    for (const k of t.channels) plan.channels[k] = { name: "", mode: CHANNEL_MODE.FULL, whitelist: {} };
    for (const v of t.videos) plan.videos[v] = { title: "" };
    for (const u of t.unknown) plan.skipped.push({ field: "list", value: u, why: "not a channel or a video" });
    return plan;
  }
  if (!data || typeof data !== "object") throw new Error("the file holds no blocklist.");

  if (data.filterData || (data.storageData && data.storageData.filterData)) {
    const conv = convertOldBlockTube(data);
    const plan = emptyPlan("an export from the original BlockTube extension");
    Object.assign(plan, {
      channels: conv.channels,
      videos: conv.videos,
      keywords: conv.keywords,
      duration: conv.duration,
      skipped: conv.skipped
    });
    return plan;
  }

  if (data.channels || data.videos) {
    const when = data.exportedAt ? ` from ${new Date(data.exportedAt).toLocaleString()}` : "";
    const plan = emptyPlan(data.format === "xrntube-backup" ? `an XrnTube backup${when}` : "an XrnTube blocklist export");
    for (const [id, e] of Object.entries(data.channels || {})) {
      if (CHANNEL_KEY_RE.test(id) && e && typeof e === "object") plan.channels[id] = e;
      else plan.skipped.push({ field: "channels", value: id, why: "not a channel ID or @handle" });
    }
    for (const [id, e] of Object.entries(data.videos || {})) {
      if (VIDEO_ID_RE.test(id) && e && typeof e === "object") plan.videos[id] = e;
      else plan.skipped.push({ field: "videos", value: id, why: "not a video ID" });
    }
    if (data.allowlist && typeof data.allowlist === "object") {
      plan.allowlist = data.allowlist.list && typeof data.allowlist.list === "object" ? data.allowlist.list : data.allowlist;
    }
    const kw = data.keywords;
    if (kw && Array.isArray(kw.list)) {
      plan.keywords = kw.list.filter((k) => k && typeof k.p === "string" && k.p);
      if (Number(kw.durMinSec) > 0 || Number(kw.durMaxSec) > 0) {
        plan.duration = { minSec: Number(kw.durMinSec) || 0, maxSec: Number(kw.durMaxSec) || 0 };
      }
      if (kw.commentLimit !== undefined) plan.commentLimit = Math.max(0, Number(kw.commentLimit) || 0);
    }
    if (data.settings && typeof data.settings === "object") plan.settings = data.settings;
    return plan;
  }

  throw new Error("no channels, videos or BlockTube filterData in it.");
}

function emptyPlan(source) {
  return {
    source,
    channels: {},
    videos: {},
    allowlist: null,
    keywords: [],
    duration: null,
    commentLimit: undefined,
    settings: null,
    skipped: []
  };
}

function fmtDuration(sec) {
  const hh = Math.floor(sec / 3600);
  const mm = Math.floor((sec % 3600) / 60);
  const ss = sec % 60;
  return hh ? `${hh}:${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}` : `${mm}:${String(ss).padStart(2, "0")}`;
}

// How many of a plan's channels the blocklist already has, by any identity —
// the same matching the background's import does, so the preview's "new"
// count is the number that will actually be added.
function countNewChannels(planChannels) {
  const known = new Set();
  const idKey = (k) => (String(k).startsWith("@") ? String(k).toLowerCase() : String(k));
  for (const [id, e] of Object.entries(state.channels || {})) {
    known.add(idKey(id));
    if (e.handle) known.add(idKey(e.handle));
    if (e.ucid) known.add(idKey(e.ucid));
  }
  let fresh = 0;
  for (const [id, e] of Object.entries(planChannels)) {
    const hit = known.has(idKey(id)) || (e.handle && known.has(idKey(e.handle))) || (e.ucid && known.has(idKey(e.ucid)));
    if (!hit) fresh++;
    known.add(idKey(id));
    if (e.handle) known.add(idKey(e.handle));
    if (e.ucid) known.add(idKey(e.ucid));
  }
  return fresh;
}

// Show what a file will do, let the user pick the parts, then do it.
async function previewAndImport(plan) {
  const nCh = Object.keys(plan.channels).length;
  const nVid = Object.keys(plan.videos).length;
  const newCh = countNewChannels(plan.channels);
  const newVid = Object.keys(plan.videos).filter((id) => !(state.videos || {})[id]).length;
  const kwHave = new Set(keywords.list.map((k) => (k.re ? "re:" : "") + k.p));
  const newKw = plan.keywords.filter((k) => !kwHave.has((k.re ? "re:" : "") + k.p));
  const allowKeys = plan.allowlist ? Object.keys(plan.allowlist) : [];
  const withSubs = Object.values(plan.channels).filter((e) => e.subs).length;

  const rows = [];
  const choice = {};
  const addRow = (key, title, sub, checked = true) => {
    const cb = h("input", { type: "checkbox", checked });
    choice[key] = cb;
    rows.push(h("li", null, cb, h("div", null, h("div", { class: "plan-title", text: title }), sub && h("div", { class: "plan-sub", text: sub }))));
  };
  if (nCh) {
    const bits = [`${newCh.toLocaleString()} new`];
    if (nCh - newCh) bits.push(`${(nCh - newCh).toLocaleString()} already blocked — anything they're missing (sub count, @handle, name) is filled in`);
    if (withSubs) bits.push(`${withSubs.toLocaleString()} carry a sub count`);
    addRow("channels", `Channels — ${nCh.toLocaleString()}`, bits.join(" · "));
  }
  if (nVid) addRow("videos", `Videos — ${nVid.toLocaleString()}`, `${newVid.toLocaleString()} new`);
  if (plan.keywords.length) {
    addRow("keywords", `Title keywords — ${plan.keywords.length.toLocaleString()}`, `${newKw.length.toLocaleString()} new; yours are kept`);
  }
  if (plan.duration) {
    const d = plan.duration;
    const parts = [];
    if (d.minSec) parts.push(`shorter than ${fmtDuration(d.minSec)}`);
    if (d.maxSec) parts.push(`longer than ${fmtDuration(d.maxSec)}`);
    addRow("duration", `Length rule — block videos ${parts.join(" or ")}`, "Replaces your current length rule.");
  }
  if (plan.commentLimit !== undefined) {
    addRow("commentLimit", `Comment limit — ${plan.commentLimit ? plan.commentLimit + " comments" : "no limit"}`, "Replaces your current limit.");
  }
  if (allowKeys.length) addRow("allowlist", `Never-block list — ${allowKeys.length.toLocaleString()}`, "Merged with yours.");
  if (plan.settings) {
    addRow("settings", "“What gets hidden” switches", "Replaces your current switches with the backup's.");
  }

  const body = [h("p", { text: `This is ${plan.source}.` })];
  if (rows.length) body.push(h("ul", { class: "plan" }, rows));
  else body.push(h("p", { text: "There's nothing in it XrnTube can import." }));

  if (plan.skipped.length) {
    const byWhy = new Map();
    for (const s of plan.skipped) {
      if (!byWhy.has(s.why)) byWhy.set(s.why, []);
      byWhy.get(s.why).push(s);
    }
    const report = [...byWhy]
      .map(([why, items]) => `${items.length} × ${why}:\n` + items.map((s) => `  [${s.field}] ${s.value}`).join("\n"))
      .join("\n\n");
    body.push(
      h(
        "details",
        { class: "skipped" },
        h("summary", { text: `${plural(plan.skipped.length, "line")} can't be imported — see which and why` }),
        h("pre", { text: report }),
        h("button", { class: "btn", type: "button", text: "Copy this list", onclick: () => copyText(report, "the list") })
      )
    );
  } else if (rows.length) {
    body.push(h("p", { class: "plan-sub", text: "✓ Every line in the file was recognised." }));
  }

  const go = await openModal({
    title: "Import",
    body,
    confirmLabel: rows.length ? "Import" : "Close",
    noCancel: !rows.length
  });
  if (!go || !rows.length) return;
  const want = (k) => choice[k] && choice[k].checked;

  const res = await send({
    type: MSG.IMPORT_BLOCKLIST,
    channels: want("channels") ? plan.channels : {},
    videos: want("videos") ? plan.videos : {},
    allowlist: want("allowlist") ? plan.allowlist : null
  });
  if (!res || !res.ok) {
    toast("The import failed — nothing was changed.", { error: true });
    return;
  }

  // Keywords / length / comment limit share one stored record.
  let kwChanged = false;
  if (want("keywords") && newKw.length) {
    keywords.list = keywords.list.concat(newKw);
    kwChanged = true;
  }
  if (want("duration")) {
    keywords.durMinSec = plan.duration.minSec || 0;
    keywords.durMaxSec = plan.duration.maxSec || 0;
    kwChanged = true;
  }
  if (want("commentLimit")) {
    keywords.commentLimit = plan.commentLimit;
    kwChanged = true;
  }
  if (kwChanged) await saveKeywords();
  if (want("settings")) await writeSettings(resolveSettings(plan.settings));

  await refresh();
  const bits = [];
  if (res.added.channels) bits.push(plural(res.added.channels, "channel"));
  if (res.added.videos) bits.push(plural(res.added.videos, "video"));
  if (want("keywords") && newKw.length) bits.push(plural(newKw.length, "keyword"));
  if (res.allowAdded) bits.push(`${res.allowAdded} never-block`);
  const extra = res.enriched ? ` Updated ${plural(res.enriched, "existing entry", "existing entries")}.` : "";
  toast((bits.length ? `Imported ${bits.join(", ")}.` : "Nothing new to import.") + extra, { ms: 7000 });

  // An imported UC…-only channel blocks nothing in feeds until its @handle is
  // known, so the lookup starts straight away rather than behind a prompt —
  // on the Blocklist page, where its progress bar is.
  const need = Object.keys(state.channels).filter((id) => !subsAttempted(state.channels[id]));
  if (need.length) {
    showPage("blocklist");
    bulkFetchSubs(need, "Import finished — sub counts");
  }
}

async function importFile(file) {
  if (!file) return;
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    toast(`“${file.name}” isn't valid JSON — is it the right file?`, { error: true, ms: 7000 });
    return;
  }
  let plan;
  try {
    plan = buildImportPlan(data);
  } catch (err) {
    toast(`Couldn't use “${file.name}”: ${err.message}`, { error: true, ms: 7000 });
    return;
  }
  await previewAndImport(plan);
}

$("import-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  e.target.value = ""; // so choosing the same file again still fires
  await importFile(file);
});
(() => {
  const zone = $("import-drop");
  const over = (on) => (e) => {
    e.preventDefault();
    zone.classList.toggle("over", on);
  };
  zone.addEventListener("dragover", over(true));
  zone.addEventListener("dragenter", over(true));
  zone.addEventListener("dragleave", over(false));
  zone.addEventListener("drop", (e) => {
    over(false)(e);
    importFile(e.dataTransfer.files[0]);
  });
})();

// ---------- backup & data page ----------
function renderDataPage() {
  const nCh = Object.keys(state.channels || {}).length;
  const nVid = Object.keys(state.videos || {}).length;
  const nKw = keywords.list.length;
  const nAllow = Object.keys(state.allowlist || {}).length;
  $("backup-summary").textContent = `Right now: ${plural(nCh, "channel")} · ${plural(nVid, "video")} · ${plural(
    nKw,
    "keyword"
  )} · ${nAllow.toLocaleString()} never-block.`;
  const set = (id, n, text) => {
    $(id + "-desc").textContent = n ? text : "Nothing to delete.";
    $(id).disabled = !n;
  };
  set("danger-channels", nCh, `${plural(nCh, "channel")}, with their sub counts and video-only exceptions.`);
  set("danger-videos", nVid, `${plural(nVid, "individually blocked video")}.`);
  set("danger-keywords", nKw, `${plural(nKw, "title keyword")}. The length and comment limits stay.`);
  set("danger-allowlist", nAllow, `${plural(nAllow, "channel")} that can never be blocked.`);
  const f = lookupFailures();
  set(
    "danger-failed",
    f.gone.length + f.failed.length + f.hidden.length,
    `${f.gone.length.toLocaleString()} gone · ${f.failed.length.toLocaleString()} whose lookup failed · ${f.hidden.length.toLocaleString()} hiding their sub count. You pick which.`
  );
  $("danger-all").disabled = !(nCh || nVid || nKw || nAllow);
}

// Channels the sub-count lookup has already tried and couldn't use, in three
// groups. A channel not looked up yet is in none of them — after a big import
// thousands are only waiting their turn, and that is not a failure.
//   gone   — YouTube says it doesn't exist (deleted, terminated, renamed)
//   failed — looked up, but no sub count, or its other identity never found
//   hidden — a live, resolved channel that keeps its count private; a real
//            block, so it is offered but never pre-selected
function lookupFailures() {
  const out = { gone: [], failed: [], hidden: [] };
  for (const [id, e] of Object.entries(state.channels || {})) {
    if (e.gone) {
      out.gone.push(id);
      continue;
    }
    if (!subsAttempted(e)) continue;
    const unresolved = id.startsWith("UC") ? !e.handle : !e.ucid;
    if (e.subs === "hidden" && !unresolved) out.hidden.push(id);
    else if (unresolved || subsToNumber(e.subs) == null) out.failed.push(id);
  }
  return out;
}

async function deleteLookupFailures() {
  const f = lookupFailures();
  const groups = [
    ["gone", "Gone", "YouTube says these channels no longer exist — deleted, terminated or renamed.", true],
    ["failed", "Lookup failed", "Looked up, but no sub count came back, or the channel's other ID (@handle / UC…) was never found.", true],
    ["hidden", "Hide their sub count", "Live channels that just keep the number private — still real blocks.", false]
  ].filter(([key]) => f[key].length);
  if (!groups.length) {
    toast("Nothing to clean up — every channel that has been looked up resolved fine.");
    return;
  }
  const boxes = {};
  const pending = Object.values(state.channels || {}).filter((e) => !e.gone && !subsAttempted(e)).length;
  const body = [
    h(
      "ul",
      { class: "plan" },
      groups.map(([key, title, sub, checked]) => {
        boxes[key] = h("input", { type: "checkbox", checked });
        return h(
          "li",
          null,
          boxes[key],
          h("div", null, h("div", { class: "plan-title", text: `${title} — ${f[key].length.toLocaleString()}` }), h("div", { class: "plan-sub", text: sub }))
        );
      })
    ),
    pending
      ? `Not included: ${plural(pending, "channel")} not looked up yet — let the sub-count fetch finish first to catch every one.`
      : "Deleted channels can be restored from Recently removed."
  ];
  if (!(await openModal({ title: "Delete channels that can't be looked up?", body, confirmLabel: "Delete selected", danger: true }))) {
    return;
  }
  const ids = groups.filter(([key]) => boxes[key].checked).flatMap(([key]) => f[key]);
  if (!ids.length) return;
  const res = await send({ type: MSG.DELETE_DATA, channels: ids });
  await refresh();
  toast(`Deleted ${plural(ids.length, "channel")}.`, { action: undoAction(res && res.undoTs) });
}
$("clean-failed-btn").addEventListener("click", () => deleteLookupFailures());
$("danger-failed").addEventListener("click", () => deleteLookupFailures());

$("danger-channels").addEventListener("click", () => deleteAll("channels"));
$("danger-videos").addEventListener("click", () => deleteAll("videos"));
$("danger-keywords").addEventListener("click", () => $("kw-clear").click());
$("danger-allowlist").addEventListener("click", () => $("allow-clear").click());
$("danger-all").addEventListener("click", async () => {
  const nCh = Object.keys(state.channels || {}).length;
  const nVid = Object.keys(state.videos || {}).length;
  const ok = await confirmDelete(
    "Delete everything?",
    `${plural(nCh, "channel")}, ${plural(nVid, "video")}, ${plural(keywords.list.length, "keyword")} and the never-block list will be gone.`,
    { confirmLabel: "Delete everything", requireText: "delete" }
  );
  if (!ok) return;
  const res = await send({ type: MSG.DELETE_DATA, channels: "all", videos: "all", keywords: true, allowlist: true });
  await refresh();
  toast("Everything deleted.", { action: undoAction(res && res.undoTs) });
});

// Live-refresh on any storage change, but coalesced — a bulk sub-count load
// fires one write per batch and we don't want a full re-render each time.
let refreshTimer = null;
let suppressStorageRefresh = false;
chrome.storage.onChanged.addListener((changes, area) => {
  if (suppressStorageRefresh) return;
  // The sweep's own progress is handled by renderSweep().
  if (area === "local" && Object.keys(changes).length === 1 && changes.bt_sweep) return;
  // a toggle flip touches only bt_settings — initSettings handles that itself
  if (area === "sync" && Object.keys(changes).length === 1 && changes[SETTINGS_KEY]) return;
  clearTimeout(refreshTimer);
  // A running sweep writes every few seconds; repaint at a calmer pace then.
  refreshTimer = setTimeout(refresh, bulkRunning ? 2500 : 300);
});

// ---------------- "What gets hidden" ----------------
// Two levels: a group is a heading with a master switch, and every leaf under
// it is one thing removed from YouTube. Only leaves are stored (see
// SETTING_GROUPS in shared/constants.js) — the master is derived from its
// leaves, so it can never disagree with what is actually applied.
let currentSettings = { ...DEFAULT_SETTINGS };
let settingsFilter = "";

async function writeSettings(next) {
  currentSettings = next;
  await chrome.storage.sync.set({ [SETTINGS_KEY]: currentSettings });
  renderSettings();
}

function matchesSettingFilter(group, item) {
  if (!settingsFilter) return true;
  const hay = `${group.label} ${group.desc} ${item.label} ${item.desc}`.toLowerCase();
  return hay.includes(settingsFilter);
}

function buildToggle(className, checked, onChange, key) {
  const label = document.createElement("label");
  label.className = className;
  if (key) label.dataset.key = key;
  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = checked;
  cb.addEventListener("change", () => onChange(cb.checked));
  const slider = document.createElement("span");
  slider.className = "slider";
  label.append(cb, slider);
  return { label, cb };
}

function renderSettings() {
  const list = $("settings-list");
  list.replaceChildren();
  let count = 0;

  for (const group of SETTING_GROUPS) {
    const items = group.items.filter((it) => matchesSettingFilter(group, it));
    if (!items.length) continue;
    count += items.length;

    const section = document.createElement("section");
    section.className = "sgroup";
    section.dataset.group = group.id;

    const head = document.createElement("header");
    head.className = "sgroup-head";

    const title = document.createElement("div");
    title.className = "sgroup-title";
    const h2 = document.createElement("h2");
    h2.textContent = group.label;
    const sub = document.createElement("p");
    sub.textContent = group.desc;
    title.append(h2, sub);

    // The master reflects the group's leaves: on when all are on, off when
    // none are, mixed otherwise. Clicking it sets every leaf in the group.
    const on = group.items.filter((it) => currentSettings[it.key] !== false).length;
    const all = group.items.length;

    const meta = document.createElement("div");
    meta.className = "sgroup-meta";
    const countEl = document.createElement("span");
    countEl.className = "sgroup-count";
    countEl.textContent = on === all ? `all ${all} hidden` : on === 0 ? "none hidden" : `${on} of ${all} hidden`;
    const { label: master, cb: masterCb } = buildToggle("group-toggle", on === all, async (checked) => {
      const next = { ...currentSettings };
      for (const it of group.items) next[it.key] = checked;
      await writeSettings(next);
    });
    masterCb.indeterminate = on > 0 && on < all;
    master.title = `Turn everything in “${group.label}” ${on === all ? "off" : "on"}`;
    meta.append(countEl, master);
    head.append(title, meta);

    const ul = document.createElement("ul");
    ul.className = "sitems";
    for (const item of items) {
      const li = document.createElement("li");
      li.className = "sitem";
      const text = document.createElement("div");
      text.className = "sitem-text";
      const lab = document.createElement("div");
      lab.className = "setting-label";
      lab.textContent = item.label;
      const desc = document.createElement("div");
      desc.className = "setting-desc";
      desc.textContent = item.desc || "";
      text.append(lab, desc);
      const { label: sw } = buildToggle(
        "switch",
        currentSettings[item.key] !== false,
        (checked) => writeSettings({ ...currentSettings, [item.key]: checked }),
        item.key
      );
      li.append(text, sw);
      ul.appendChild(li);
    }

    section.append(head, ul);
    list.appendChild(section);
  }

  $("settings-empty").hidden = count > 0;
  const total = SETTING_GROUPS.reduce((n, g) => n + g.items.length, 0);
  const active = SETTING_GROUPS.reduce((n, g) => n + g.items.filter((it) => currentSettings[it.key] !== false).length, 0);
  $("nav-settings").textContent = `${active}/${total}`;
}

async function initSettings() {
  const res = await chrome.storage.sync.get({ [SETTINGS_KEY]: null });
  currentSettings = resolveSettings(res[SETTINGS_KEY]);
  renderSettings();

  $("settings-search").addEventListener("input", (e) => {
    settingsFilter = e.target.value.trim().toLowerCase();
    renderSettings();
  });

  $("settings-reset").addEventListener("click", async () => {
    const before = { ...currentSettings };
    await writeSettings({ ...DEFAULT_SETTINGS });
    toast("Switches reset to defaults.", { action: { label: "Undo", run: () => writeSettings(before) } });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[SETTINGS_KEY]) {
      currentSettings = resolveSettings(changes[SETTINGS_KEY].newValue);
      renderSettings();
    }
  });
}

initSettings();

// ---------- sync through your own server ----------
const sync = {
  card: $("sync-card"),
  url: $("sync-url"),
  user: $("sync-user"),
  password: $("sync-password"),
  save: $("sync-save"),
  status: $("sync-status"),
  actions: $("sync-actions"),
  now: $("sync-now"),
  history: $("sync-history"),
  disconnect: $("sync-disconnect")
};

// The server keeps the copy each push replaces (server/xrntube-sync.py →
// history). Restoring one is an import, not a rollback: entries come back
// with fresh timestamps, so they beat the tombstones every other device holds
// for them, and nothing added since is removed. Writing the old copy back to
// the server would lose to those tombstones on the next sync.
async function restoreFromServerHistory() {
  const res = await send({ type: MSG.SYNC_HISTORY });
  if (!res || !res.ok) {
    const why =
      res && res.status === 404
        ? "this server keeps no history — update server/xrntube-sync.py on it."
        : (res && res.error) || "unknown error";
    toast("Couldn't list the server's copies: " + why, { error: true, ms: 8000 });
    return;
  }
  if (!res.items.length) {
    await openModal({
      title: "No earlier copies yet",
      body: "The server keeps one each time a device pushes a change, so there will be some after the next edit.",
      confirmLabel: "Close",
      noCancel: true
    });
    return;
  }
  const when = (it) => (it.updated ? new Date(it.updated).toLocaleString() : it.name);
  let picked = res.items[0].name;
  const list = h(
    "ul",
    { class: "plan history-list" },
    res.items.map((it, i) => {
      const radio = h("input", { type: "radio", name: "sync-history", value: it.name, checked: i === 0 });
      const choose = () => {
        radio.checked = true;
        picked = it.name;
      };
      return h(
        "li",
        { onclick: choose },
        radio,
        h(
          "div",
          null,
          h("div", { class: "plan-title", text: when(it) }),
          h("div", {
            class: "plan-sub",
            text: [
              plural(it.channels || 0, "channel"),
              plural(it.videos || 0, "video"),
              plural(it.keywords || 0, "keyword"),
              `${(it.allowlist || 0).toLocaleString()} never-block`,
              `version ${it.version}`
            ].join(" · ")
          })
        )
      );
    })
  );
  const go = await openModal({
    title: "Restore an earlier copy",
    body: [
      "Each copy is the whole list as it stood at that time. Restoring adds back what it has and this list doesn't — nothing added since is removed. You'll see what it contains before anything changes.",
      list
    ],
    confirmLabel: "Preview"
  });
  if (!go) return;
  const item = await send({ type: MSG.SYNC_HISTORY_GET, name: picked });
  if (!item || !item.ok) {
    toast("Couldn't fetch that copy: " + ((item && item.error) || "unknown error"), { error: true });
    return;
  }
  let plan;
  try {
    plan = buildImportPlan(item.data);
  } catch (err) {
    toast("That copy can't be read: " + err.message, { error: true });
    return;
  }
  const meta = res.items.find((it) => it.name === picked);
  plan.source = `the server's copy from ${meta ? when(meta) : picked}`;
  await previewAndImport(plan);
}

async function renderSyncStatus() {
  const s = await send({ type: MSG.GET_SYNC_STATUS });
  if (!s) return;
  $("nav-sync").textContent = s.enabled ? (s.lastError ? "!" : "on") : "";
  sync.actions.hidden = !s.enabled;
  sync.status.hidden = !s.enabled;
  sync.save.textContent = s.enabled ? "Reconnect" : "Connect";
  if (s.enabled) {
    if (document.activeElement !== sync.url) sync.url.value = s.url || "";
    if (document.activeElement !== sync.user) sync.user.value = s.user || "";
    sync.password.value = "";
    sync.password.placeholder = "Password (saved — type to change)";
  }
  if (!s.enabled) return;
  if (s.lastError) {
    sync.status.className = "sync-status error";
    sync.status.textContent = "Sync error: " + s.lastError;
    return;
  }
  sync.status.className = "sync-status ok";
  sync.status.replaceChildren(
    h("div", {
      text:
        `Connected to ${new URL(s.url).host} as ${s.user} — ${s.remoteChannels.toLocaleString()} channels and ` +
        `${s.remoteVideos.toLocaleString()} videos on the server. Pushed ${fmtAgo(s.lastPushedAt)}, pulled ${fmtAgo(s.lastPulledAt)}.`
    }),
    h("div", {
      class: "sync-hint",
      text: "To add another device: open this page there → Sync → the same address and login → Connect. It pulls this list."
    })
  );
}

function initSync() {
  renderSyncStatus();

  const connect = async () => {
    const url = sync.url.value.trim();
    const user = sync.user.value.trim();
    const password = sync.password.value;
    if (!/^https?:\/\/[^/]+/i.test(url) || !user) {
      toast("Enter the server's address (https://…) and your user name.", { error: true });
      return;
    }
    const status = await send({ type: MSG.GET_SYNC_STATUS });
    if (!password && !(status && status.enabled)) {
      toast("Enter your password.", { error: true });
      sync.password.focus();
      return;
    }
    sync.save.disabled = true;
    sync.save.textContent = "Connecting…";
    const res = await send({
      type: MSG.SET_SYNC_CONFIG,
      // An empty password field on a connected device keeps the saved one.
      conn: { url, user, password: password || undefined }
    });
    sync.save.disabled = false;
    if (!res || res.ok === false) toast("Couldn't connect: " + ((res && res.error) || "unknown error"), { error: true });
    else toast("Connected — syncing now.");
    await renderSyncStatus();
    refresh();
  };
  sync.save.addEventListener("click", connect);
  for (const el of [sync.url, sync.user, sync.password]) {
    el.addEventListener("keydown", (e) => {
      if (e.key === "Enter") connect();
    });
  }

  sync.now.addEventListener("click", async () => {
    sync.now.disabled = true;
    sync.now.textContent = "Syncing…";
    const res = await send({ type: MSG.SYNC_NOW });
    sync.now.disabled = false;
    sync.now.textContent = "Sync now";
    if (res && res.ok === false && res.error) toast("Sync failed: " + res.error, { error: true });
    await renderSyncStatus();
    refresh();
  });

  sync.history.addEventListener("click", async () => {
    sync.history.disabled = true;
    try {
      await restoreFromServerHistory();
    } finally {
      sync.history.disabled = false;
    }
  });

  sync.disconnect.addEventListener("click", async () => {
    const ok = await openModal({
      title: "Stop syncing on this device?",
      body: "Your blocklist stays here; it just won't push or pull anymore.",
      confirmLabel: "Disconnect",
      danger: true
    });
    if (!ok) return;
    await send({ type: MSG.SET_SYNC_CONFIG, conn: null });
    sync.password.placeholder = "Password";
    await renderSyncStatus();
  });
}

initSync();

// ---------- title keywords, length, comment limit ----------
// How many top-level comment threads a watch page keeps. 0 means no cap.
// Also applied to a stored record that predates the setting, so "off" is
// an explicit 0 rather than a missing field.
const DEFAULT_COMMENT_LIMIT = 50;
let keywords = { list: [], ts: 0, durMinSec: 0, durMaxSec: 0, commentLimit: DEFAULT_COMMENT_LIMIT };

function readKeywordsRecord(k) {
  return k && Array.isArray(k.list)
    ? {
        list: k.list,
        ts: Number(k.ts) || 0,
        durMinSec: Number(k.durMinSec) || 0,
        durMaxSec: Number(k.durMaxSec) || 0,
        // A record saved before this setting existed carries no commentLimit,
        // which is not the same as the user choosing "no cap" — fall back to
        // the default rather than to 0.
        commentLimit: k.commentLimit === undefined ? DEFAULT_COMMENT_LIMIT : Number(k.commentLimit) || 0
      }
    : { list: [], ts: 0, durMinSec: 0, durMaxSec: 0, commentLimit: DEFAULT_COMMENT_LIMIT };
}

function renderKeywords() {
  const ul = $("kw-list");
  setNavCount("nav-keywords", keywords.list.length);
  $("kw-total").textContent = keywords.list.length ? `(${keywords.list.length})` : "";
  $("kw-clear").hidden = keywords.list.length === 0;
  ul.replaceChildren(
    ...keywords.list.map((k, i) =>
      h(
        "li",
        null,
        h("span", { class: "item-name", style: k.re ? "font-family:monospace" : "", text: k.p }),
        k.re && h("span", { class: "mode-tag", text: "regex" }),
        h("span", { class: "spacer" }),
        h("button", {
          class: "unblock-btn",
          type: "button",
          text: "Remove",
          onclick: () => {
            const [gone] = keywords.list.splice(i, 1);
            saveKeywords();
            toast(`Removed “${gone.p}”.`, {
              action: {
                label: "Undo",
                run: () => {
                  keywords.list.splice(Math.min(i, keywords.list.length), 0, gone);
                  return saveKeywords();
                }
              }
            });
          }
        })
      )
    )
  );
  $("kw-empty").hidden = keywords.list.length > 0;
  renderDataPage();
}

async function saveKeywords() {
  keywords.ts = Date.now();
  await chrome.storage.sync.set({
    [KEYWORDS_KEY]: {
      list: keywords.list,
      ts: keywords.ts,
      durMinSec: keywords.durMinSec || 0,
      durMaxSec: keywords.durMaxSec || 0,
      commentLimit: keywords.commentLimit || 0
    }
  });
  send({ type: MSG.SYNC_NOW }).catch(() => {});
  renderKeywords();
}

function renderDuration() {
  $("dur-min").value = keywords.durMinSec ? String(keywords.durMinSec) : "";
  $("dur-max").value = keywords.durMaxSec ? String(Math.round(keywords.durMaxSec / 60)) : "";
  $("comment-limit").value = keywords.commentLimit ? String(keywords.commentLimit) : "";
}

function initKeywords() {
  chrome.storage.sync.get(KEYWORDS_KEY).then((r) => {
    keywords = readKeywordsRecord(r[KEYWORDS_KEY]);
    renderKeywords();
    renderDuration();
  });

  $("dur-save").addEventListener("click", () => {
    keywords.durMinSec = Math.max(0, Math.floor(Number($("dur-min").value) || 0));
    keywords.durMaxSec = Math.max(0, Math.floor(Number($("dur-max").value) || 0)) * 60;
    saveKeywords();
    renderDuration();
    toast(keywords.durMinSec || keywords.durMaxSec ? "Length rule saved." : "Length rule off.");
  });
  $("comment-save").addEventListener("click", () => {
    keywords.commentLimit = Math.max(0, Math.floor(Number($("comment-limit").value) || 0));
    saveKeywords();
    renderDuration();
    toast(keywords.commentLimit ? `Watch pages keep ${keywords.commentLimit} comments.` : "Comments are no longer capped.");
  });

  // Adds one pattern or, when several lines were pasted, each line.
  const addPatterns = (patterns) => {
    const isRe = $("kw-regex").checked;
    let added = 0;
    for (const p of patterns) {
      if (isRe) {
        try {
          new RegExp(p);
        } catch (e) {
          toast(`“${p}” isn't a valid regular expression: ${e.message}`, { error: true, ms: 7000 });
          continue;
        }
      }
      if (!keywords.list.some((k) => k.p === p && !!k.re === isRe)) {
        keywords.list.unshift({ p, re: isRe });
        added++;
      }
    }
    if (added) {
      saveKeywords();
      if (patterns.length > 1) toast(`Added ${plural(added, "keyword")}.`);
    } else if (patterns.length) {
      toast("Already on the list.");
    }
  };
  const add = () => {
    const input = $("kw-input");
    const p = input.value.trim();
    if (!p) return;
    addPatterns([p]);
    input.value = "";
    $("kw-regex").checked = false;
  };
  $("kw-add-btn").addEventListener("click", add);
  $("kw-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") add();
  });
  $("kw-input").addEventListener("paste", (e) => {
    const text = e.clipboardData && e.clipboardData.getData("text");
    if (!text || !/[\r\n]/.test(text)) return;
    e.preventDefault();
    addPatterns(text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean));
  });
  $("kw-clear").addEventListener("click", async () => {
    const n = keywords.list.length;
    if (!(await confirmDelete(`Remove all ${plural(n, "title keyword")}?`, "The length rule and comment limit stay.", { confirmLabel: "Remove all" }))) {
      return;
    }
    const res = await send({ type: MSG.DELETE_DATA, keywords: true });
    toast(`Removed ${plural(n, "keyword")}.`, { action: undoAction(res && res.undoTs) });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[KEYWORDS_KEY]) {
      keywords = readKeywordsRecord(changes[KEYWORDS_KEY].newValue);
      renderKeywords();
      renderDuration();
    }
  });
}
initKeywords();

// ---------- "recently removed" undo list ----------
function describeRecord(rec) {
  if (rec.t !== "bulk") {
    const e = rec.entry || {};
    return { name: e.name || e.title || rec.id, kind: rec.kind === "video" ? "video" : "channel" };
  }
  if (rec.entries) {
    const n = Object.keys(rec.entries).length;
    return { name: plural(n, rec.kind === "channel" ? "channel" : "blocked video") + " (cleared together)", kind: "bulk" };
  }
  const parts = [];
  const nCh = Object.keys(rec.channels || {}).length;
  const nVid = Object.keys(rec.videos || {}).length;
  if (nCh) parts.push(plural(nCh, "channel"));
  if (nVid) parts.push(plural(nVid, "video"));
  if (rec.keywords && rec.keywords.length) parts.push(plural(rec.keywords.length, "keyword"));
  if (rec.allowlist && Object.keys(rec.allowlist).length) parts.push(`${Object.keys(rec.allowlist).length} never-block`);
  return { name: (parts.join(", ") || "nothing") + " (deleted together)", kind: "bulk" };
}

async function renderRecentUnblocks() {
  const box = $("recent-unblocks");
  const res = await send({ type: MSG.GET_RECENT_UNBLOCKS });
  const log = (res && res.log) || [];
  $("recent-count").textContent = String(log.length);
  box.hidden = log.length === 0;
  $("recent-list").replaceChildren(
    ...log.map((rec, i) => {
      const d = describeRecord(rec);
      return h(
        "li",
        null,
        h(
          "div",
          { class: "row-main" },
          h("div", { class: "item-name", text: d.name }),
          h("div", { class: "row-meta" }, h("span", { class: "item-date", text: `${d.kind === "bulk" ? "" : d.kind + " · "}removed ${fmtAgo(rec.ts)}` }))
        ),
        h("button", {
          class: "hide-btn",
          type: "button",
          text: "Restore",
          onclick: async (e) => {
            e.currentTarget.disabled = true;
            await send(rec.ts != null ? { type: MSG.RESTORE_UNBLOCK, ts: rec.ts } : { type: MSG.RESTORE_UNBLOCK, index: i });
            await refresh();
            toast(`Restored ${d.name.replace(/ \(.*\)$/, "")}.`);
          }
        })
      );
    })
  );
}
$("recent-clear").addEventListener("click", async () => {
  await send({ type: MSG.CLEAR_RECENT_UNBLOCKS });
  renderRecentUnblocks();
});

// ---------- keyboard ----------
const isTyping = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (!$("modal").hidden) return closeModal(false);
    if (!menuEl.hidden) return setMenu(false);
    if (document.activeElement === $("search") && $("search").value) {
      $("search").value = "";
      $("search").dispatchEvent(new Event("input"));
      return;
    }
    if (selectMode) return setSelectMode(false);
    return;
  }
  if (e.key === "/" && !isTyping(e.target) && $("modal").hidden && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    showPage("blocklist");
    $("search").focus();
    $("search").select();
  }
});

// Opening this page fetches the subscriber counts (and @handles, and real
// names) for channels that have never been looked up — queued to the
// background sweep, which syncs them when it finishes. It is self-limiting: only
// channels with no recorded attempt qualify, so once the blocklist is
// resolved this does nothing on subsequent opens, and counts already cached
// are never re-fetched (see subsAttempted). Resolving @handles is not just
// cosmetic — a UC…-keyed channel doesn't block modern feed tiles until its
// handle is known.
//
// Progress shows in the usual place with a Stop button; it just isn't waiting
// on a click.
async function autoFetchMissingSubs() {
  // The background drops ids already queued, so an open page joining a
  // running sweep adds nothing twice.
  const ids = Object.keys(state.channels || {}).filter((id) => !subsAttempted(state.channels[id]));
  if (!ids.length) return;
  await bulkFetchSubs(ids, "Auto-fetched");
}

send({ type: MSG.GET_SWEEP })
  .then((r) => r && renderSweep(r.sweep))
  .catch(() => {});
refresh().then(autoFetchMissingSubs);
