const { MSG, STORAGE, CHANNEL_MODE, SETTINGS_KEY, DEFAULT_SETTINGS, KEYWORDS_KEY, SETTING_GROUPS, resolveSettings } =
  self.BlockTube;

let state = { channels: {}, videos: {} };
let filter = "";
// Which filter tab is active: "all" | "full" | "videoOnly" | "videos" | "nosubs" | "hidden"
let tab = "all";
// Channel sort: "recent" | "subsDesc" | "subsAsc" | "name".
// Biggest-first by default — the whole point of the sub counts is to see who
// the heavy hitters are; keep the <select> in options.html in step.
let sortBy = "subsDesc";
// Hide channels whose known sub count is below `smallThreshold` (unknown = kept).
let hideSmall = false;
let smallThreshold = 10000;
// "Fetch all sub counts" run control.
let bulkRunning = false;
let bulkStop = false;
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

// Bulk-select mode: channel rows grow a checkbox and an action bar appears.
let selectMode = false;
const selected = new Set();

async function refresh() {
  state = await chrome.runtime.sendMessage({ type: MSG.GET_BLOCKLIST });
  render();
  if (typeof renderAllowlist === "function") renderAllowlist();
  if (typeof renderRecentUnblocks === "function") renderRecentUnblocks();
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

// A row is normally excluded if hidden; the "Hidden" tab flips that.
function passesHidden(entry) {
  return tab === "hidden" ? !!entry.hidden : !entry.hidden;
}

function render() {
  const allChannels = Object.entries(state.channels || {});
  const allVideos = Object.entries(state.videos || {});
  const hiddenCount =
    allChannels.filter(([, e]) => e.hidden).length + allVideos.filter(([, e]) => e.hidden).length;

  const wantChannels =
    tab === "all" || tab === "full" || tab === "videoOnly" || tab === "nosubs" || tab === "hidden";
  const wantVideos = tab === "all" || tab === "videos" || tab === "hidden";

  const channelSort = {
    recent: (a, b) => (b[1].ts || 0) - (a[1].ts || 0),
    name: (a, b) => (a[1].name || a[0]).toLowerCase().localeCompare((b[1].name || b[0]).toLowerCase()),
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

  let hiddenBySmall = 0;
  const channelEntries = allChannels
    .filter(([id, e]) => matches(id + " " + (e.name || "") + " " + (e.handle || "")) && passesHidden(e))
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
    .sort(channelSort[sortBy] || channelSort.recent);

  const videoEntries = allVideos
    .filter(([id, e]) => matches(id + " " + (e.title || "")) && passesHidden(e))
    .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));

  // Tabs
  document.querySelectorAll(".filter-tab").forEach((b) => {
    b.classList.toggle("active", b.dataset.tab === tab);
  });
  const hiddenTab = document.querySelector('.filter-tab[data-tab="hidden"]');
  if (hiddenTab) hiddenTab.textContent = `Hidden (${hiddenCount})`;
  const noSubsTab = document.querySelector('.filter-tab[data-tab="nosubs"]');
  if (noSubsTab) {
    const n = allChannels.filter(([, e]) => subsToNumber(e.subs) == null && !e.hidden).length;
    noSubsTab.textContent = `No sub count (${n})`;
  }

  document.getElementById("channel-total").textContent = `(${allChannels.length})`;
  document.getElementById("video-total").textContent = `(${allVideos.length})`;

  const chSection = document.getElementById("channel-section");
  const vidSection = document.getElementById("video-section");
  chSection.hidden = !wantChannels;
  vidSection.hidden = !wantVideos;
  const chControls = document.querySelector(".channel-controls");
  if (chControls) chControls.hidden = !wantChannels && !bulkRunning;

  renderList(
    document.getElementById("channel-list"),
    document.getElementById("channel-empty"),
    document.getElementById("channel-more"),
    channelEntries,
    ([id, entry]) => buildChannelRow(id, entry),
    "channel"
  );
  renderList(
    document.getElementById("video-list"),
    document.getElementById("video-empty"),
    document.getElementById("video-more"),
    videoEntries,
    ([id, entry]) =>
      buildRow(entry.title || id, id, "video", entry, () =>
        chrome.runtime.sendMessage({ type: MSG.UNBLOCK_VIDEO, id })
      ),
    "video"
  );

  const subsBtn = document.getElementById("load-subs-btn");
  if (subsBtn) subsBtn.hidden = !bulkRunning && !wantChannels;
  const fetchAllBtn = document.getElementById("fetch-all-subs-btn");
  if (fetchAllBtn && !bulkRunning) {
    const missing = allChannels.filter(([, e]) => !subsAttempted(e)).length;
    fetchAllBtn.hidden = !wantChannels || missing === 0;
    fetchAllBtn.textContent = `Fetch all sub counts (${missing})`;
  }

  const smallNote = document.getElementById("small-note");
  if (smallNote) {
    smallNote.hidden = !hideSmall || hiddenBySmall === 0;
    smallNote.textContent = `${hiddenBySmall} channel${hiddenBySmall === 1 ? "" : "s"} under ${smallThreshold.toLocaleString()} subs hidden.`;
  }

  setNavCount("nav-blocklist", allChannels.length + allVideos.length);
  renderChannelStats(allChannels, allVideos);
  renderEnrichNote(allChannels);
  syncBulkBar();

  const clearVideosBtn = document.getElementById("clear-videos-btn");
  if (clearVideosBtn) {
    const total = allVideos.length;
    clearVideosBtn.hidden = !wantVideos || total === 0;
    clearVideosBtn.textContent = `Clear all ${total} blocked video${total === 1 ? "" : "s"}`;
  }

  const totalSynced =
    Object.values(state.channels || {}).filter((e) => !e.localOnly).length +
    Object.values(state.videos || {}).filter((e) => !e.localOnly).length;
  const warning = document.getElementById("quota-warning");
  if (totalSynced >= STORAGE.MAX_SYNC_ITEMS) {
    warning.hidden = false;
    warning.textContent =
      "Your account-sync storage is nearly full — extra blocks are stored on this device only. " +
      "They still sync via GitHub Gist if you've connected it below.";
  } else {
    warning.hidden = true;
  }
}

// One-line summary above the channel list: counts by mode + total reach.
function setNavCount(id, n) {
  const el = document.getElementById(id);
  if (el) el.textContent = n ? String(n) : "";
}

function renderChannelStats(allChannels, allVideos) {
  const el = document.getElementById("channel-stats");
  if (!el) return;
  if (!allChannels.length) {
    el.hidden = true;
    return;
  }
  let full = 0;
  let video = 0;
  let hidden = 0;
  let subSum = 0;
  let subKnown = 0;
  let biggest = null;
  for (const [, e] of allChannels) {
    if (e.mode === CHANNEL_MODE.EXCEPT_WHITELIST) video++;
    else full++;
    if (e.hidden) hidden++;
    const n = subsToNumber(e.subs);
    if (n != null) {
      subSum += n;
      subKnown++;
      if (!biggest || n > biggest.n) biggest = { n, name: e.name || e.handle };
    }
  }
  const parts = [
    `${allChannels.length.toLocaleString()} channels`,
    `${full.toLocaleString()} full`,
    `${video.toLocaleString()} video-only`
  ];
  if (hidden) parts.push(`${hidden.toLocaleString()} hidden`);
  parts.push(`${allVideos.length.toLocaleString()} videos`);
  if (subKnown) {
    parts.push(`~${fmtCount(subSum)} subs blocked (of ${subKnown.toLocaleString()} known)`);
    if (biggest) parts.push(`biggest: ${biggest.name} (${fmtCount(biggest.n)})`);
  }
  el.textContent = parts.join("  ·  ");
  el.hidden = false;
}

function fmtCount(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(1).replace(/\.0$/, "") + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1).replace(/\.0$/, "") + "K";
  return String(n);
}

// Warn about UC…-keyed channels with no scraped @handle yet — modern feed
// tiles link by @handle, so those can slip through until enriched.
function renderEnrichNote(allChannels) {
  const el = document.getElementById("enrich-note");
  if (!el) return;
  if (bulkRunning) {
    el.hidden = true;
    return;
  }
  // UC…-keyed, still no @handle, and not scraped in the last week (a fresh
  // scrape that still found no handle means the channel genuinely has none —
  // deleted/terminated — so stop nagging about it).
  const RECENTLY = 7 * 24 * 60 * 60 * 1000;
  const unresolved = allChannels
    .filter(([id, e]) => id.startsWith("UC") && !e.handle && !(e.subsAt && Date.now() - e.subsAt < RECENTLY))
    .map(([id]) => id);
  if (!unresolved.length) {
    el.hidden = true;
    return;
  }
  el.hidden = false;
  el.replaceChildren();
  el.append(
    `${unresolved.length.toLocaleString()} channel${unresolved.length === 1 ? "" : "s"} have no @handle yet — feed tiles link by @handle, so these may not be fully blocked until resolved. `
  );
  const b = document.createElement("button");
  b.textContent = "Resolve now";
  b.className = "linklike";
  b.addEventListener("click", () => {
    bulkFetchSubs(unresolved, document.getElementById("fetch-all-subs-btn"), "Resolved");
  });
  el.appendChild(b);
}

// Keep the bulk-select bar and per-row checkboxes in sync with `selectMode` /
// `selected`. Called at the end of every render().
function syncBulkBar() {
  const bar = document.getElementById("bulk-bar");
  const modeBtn = document.getElementById("select-mode-btn");
  if (!bar || !modeBtn) return;
  modeBtn.classList.toggle("active", selectMode);
  // Drop selections for rows no longer in the blocklist at all.
  for (const id of [...selected]) if (!state.channels || !state.channels[id]) selected.delete(id);
  bar.hidden = !selectMode;
  const countEl = document.getElementById("bulk-count");
  if (countEl) countEl.textContent = `${selected.size} selected`;
}

function renderList(listEl, emptyEl, moreEl, entries, build, key) {
  const limit = shown[key] || RENDER_CAP;
  listEl.innerHTML = "";
  entries.slice(0, limit).forEach((e) => listEl.appendChild(build(e)));
  emptyEl.hidden = entries.length > 0;
  if (!moreEl) return;

  // The rest of the list is reachable, not just announced: "Show more" grows
  // the limit a step at a time and "Show all" drops it entirely. Rendering
  // every row up front is what the cap exists to avoid, so growing on demand
  // keeps a 5,000-entry blocklist openable while still letting you get to the
  // bottom of it.
  moreEl.hidden = entries.length <= limit;
  if (entries.length <= limit) return;
  moreEl.replaceChildren();
  moreEl.append(`Showing ${limit.toLocaleString()} of ${entries.length.toLocaleString()}. `);

  const more = document.createElement("button");
  more.className = "linklike";
  const step = Math.min(RENDER_STEP, entries.length - limit);
  more.textContent = `Show ${step.toLocaleString()} more`;
  more.addEventListener("click", () => {
    shown[key] = limit + RENDER_STEP;
    render();
  });
  moreEl.appendChild(more);

  moreEl.append(" · ");
  const all = document.createElement("button");
  all.className = "linklike";
  all.textContent = `Show all ${entries.length.toLocaleString()}`;
  all.addEventListener("click", () => {
    shown[key] = Infinity;
    render();
  });
  moreEl.appendChild(all);
}

function buildRow(label, id, kind, entry, onUnblock) {
  // Same two-line shape as a channel row: title on its own line, id and any
  // tags underneath, actions on the right.
  const li = document.createElement("li");

  const main = document.createElement("div");
  main.className = "row-main";

  const name = document.createElement("div");
  name.className = "item-name";
  name.textContent = label;
  main.appendChild(name);

  const meta = document.createElement("div");
  meta.className = "row-meta";
  const idSpan = document.createElement("span");
  idSpan.className = "item-id";
  idSpan.textContent = id;
  meta.appendChild(idSpan);
  if (entry.localOnly) {
    const tag = document.createElement("span");
    tag.className = "local-tag";
    tag.textContent = "local only";
    meta.appendChild(tag);
  }
  main.appendChild(meta);
  li.appendChild(main);

  const actions = document.createElement("div");
  actions.className = "row-actions";
  actions.appendChild(buildHideBtn(kind, id, entry));
  const btn = document.createElement("button");
  btn.className = "unblock-btn";
  btn.textContent = "Unblock";
  btn.addEventListener("click", async () => {
    await onUnblock();
    refresh();
  });
  actions.appendChild(btn);
  li.appendChild(actions);

  return li;
}

function buildHideBtn(kind, id, entry) {
  const btn = document.createElement("button");
  btn.className = "hide-btn";
  const isHidden = !!entry.hidden;
  btn.textContent = isHidden ? "Unhide" : "Hide";
  btn.title = isHidden
    ? "Show this row in the blocklist manager again"
    : "Keep it blocked but stop showing it here";
  btn.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: MSG.SET_ENTRY_HIDDEN, kind, id, hidden: !isHidden });
    refresh();
  });
  return btn;
}

// CHANNEL_MODE.EXCEPT_WHITELIST channels get an extra "mode" tag, a toggle
// back to a full block, and an editable whitelist of video IDs that are
// let through despite the channel otherwise being fully video-blocked (see
// CHANNEL_MODE in shared/constants.js and channelBlocks() in content.js).
function buildChannelRow(id, entry) {
  const li = document.createElement("li");
  li.className = "channel-row";
  li.dataset.id = id; // real key (may be a UC… id); the visible label can differ

  const top = document.createElement("div");
  top.className = "row-top";

  if (selectMode) {
    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "row-check";
    check.checked = selected.has(id);
    check.addEventListener("change", () => {
      if (check.checked) selected.add(id);
      else selected.delete(id);
      syncBulkBar();
    });
    top.appendChild(check);
  }

  // Two lines, not one: the name reads on its own, and everything that used to
  // compete with it (id, sub count, block mode, local-only) drops to a quiet
  // meta line underneath. A row is scanned far more often than it is acted on.
  const main = document.createElement("div");
  main.className = "row-main";

  const name = document.createElement("div");
  name.className = "item-name";
  name.textContent = entry.name || entry.handle || id;
  main.appendChild(name);

  const meta = document.createElement("div");
  meta.className = "row-meta";

  // A channel keyed by @handle needs no separate id — the handle already is
  // one. A UC…-keyed channel shows its @handle once known (raw id as tooltip).
  const idLabel = id.startsWith("@") ? id : entry.handle || id;
  if (idLabel && idLabel !== name.textContent) {
    const idSpan = document.createElement("span");
    idSpan.className = "item-id";
    idSpan.textContent = idLabel;
    if (!id.startsWith("@") && entry.handle) idSpan.title = id;
    meta.appendChild(idSpan);
  }

  meta.appendChild(buildSubsChip(id, entry));

  const isSoft = entry.mode === CHANNEL_MODE.EXCEPT_WHITELIST;
  const modeTag = document.createElement("span");
  modeTag.className = "mode-tag" + (isSoft ? " soft" : "");
  modeTag.textContent = isSoft ? "Video-only" : "Full block";
  modeTag.title = isSoft
    ? "Its page stays reachable; its videos are blocked except the ones you allow."
    : "The channel and everything from it is gone.";
  meta.appendChild(modeTag);

  if (entry.localOnly) {
    const tag = document.createElement("span");
    tag.className = "local-tag";
    tag.textContent = "local only";
    tag.title = "Past the account-sync quota — stored on this device (still rides the gist, if connected).";
    meta.appendChild(tag);
  }
  main.appendChild(meta);
  top.appendChild(main);

  // Right-hand column: only the action you actually reach for, plus a
  // disclosure for the rest. Everything secondary lives in the drawer below
  // rather than as four more buttons fighting for the same line.
  const actions = document.createElement("div");
  actions.className = "row-actions";

  const moreBtn = document.createElement("button");
  moreBtn.className = "row-more-btn";
  moreBtn.textContent = "⋯";
  moreBtn.title = "More options";
  moreBtn.setAttribute("aria-expanded", "false");

  const unblockBtn = document.createElement("button");
  unblockBtn.className = "unblock-btn";
  unblockBtn.textContent = "Unblock";
  unblockBtn.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: MSG.UNBLOCK_CHANNEL, id });
    refresh();
  });
  actions.append(moreBtn, unblockBtn);
  top.appendChild(actions);
  li.appendChild(top);

  const drawer = document.createElement("div");
  drawer.className = "row-drawer";
  drawer.hidden = true;

  const drawerBtns = document.createElement("div");
  drawerBtns.className = "drawer-btns";
  const modeBtn = document.createElement("button");
  modeBtn.className = "mode-toggle-btn";
  modeBtn.textContent = isSoft ? "Switch to full block" : "Switch to video-only";
  modeBtn.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({
      type: MSG.SET_CHANNEL_MODE,
      id,
      mode: isSoft ? CHANNEL_MODE.FULL : CHANNEL_MODE.EXCEPT_WHITELIST
    });
    refresh();
  });
  drawerBtns.append(modeBtn, buildHideBtn("channel", id, entry));
  drawer.appendChild(drawerBtns);

  // The whitelist / age-rule editor only means anything in video-only mode.
  if (isSoft) drawer.appendChild(buildWhitelistSection(id, entry));
  li.appendChild(drawer);

  moreBtn.addEventListener("click", () => {
    drawer.hidden = !drawer.hidden;
    moreBtn.setAttribute("aria-expanded", String(!drawer.hidden));
    moreBtn.classList.toggle("open", !drawer.hidden);
  });

  return li;
}

function subsAttempted(entry) {
  return !!(entry && entry.subsAt);
}
function buildSubsChip(id, entry) {
  const chip = document.createElement("span");
  chip.className = "subs-chip";
  if (entry.subs) {
    chip.textContent = entry.subs === "hidden" ? "subs hidden" : entry.subs + " subs";
    chip.title = "Click to refresh";
  } else {
    chip.textContent = "get subs";
    chip.classList.add("action");
  }
  chip.addEventListener("click", async () => {
    if (chip.dataset.loading) return;
    chip.dataset.loading = "1";
    chip.textContent = "…";
    const res = await chrome.runtime.sendMessage({ type: MSG.FETCH_CHANNEL_SUBS, id });
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
// IDs always stay. Enforced by content.js's channelBlocks() (see there for the
// unknown-age / non-English-locale caveats).
function buildAgeRule(channelId, entry) {
  const box = document.createElement("div");
  box.className = "age-rule";

  const on = entry.blockOlderThanDays > 0;

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = on;
  cb.id = "age-" + channelId;

  const label = document.createElement("label");
  label.htmlFor = cb.id;
  label.textContent = "Only block videos older than";

  const days = document.createElement("input");
  days.type = "number";
  days.min = "1";
  days.className = "age-days";
  days.value = on ? String(entry.blockOlderThanDays) : "7";
  days.disabled = !on;

  const unit = document.createElement("span");
  unit.textContent = "days";

  const save = document.createElement("button");
  save.className = "age-save";
  save.textContent = "Save";
  save.disabled = !on;

  const commit = async (d) => {
    await chrome.runtime.sendMessage({ type: MSG.SET_CHANNEL_AGE_RULE, id: channelId, days: d });
    refresh();
  };
  cb.addEventListener("change", () => {
    days.disabled = save.disabled = !cb.checked;
    if (!cb.checked) commit(0);
  });
  save.addEventListener("click", () => {
    const d = Math.max(1, Math.floor(Number(days.value) || 0));
    commit(d);
  });

  box.append(cb, label, days, unit, save);
  return box;
}

function buildWhitelistSection(channelId, channelEntry) {
  const whitelist = channelEntry.whitelist || {};
  const wlCount = Object.keys(whitelist).length;
  const ageDays = channelEntry.blockOlderThanDays > 0 ? channelEntry.blockOlderThanDays : 0;

  // Collapsed by default so a page full of video-only channels stays short.
  const details = document.createElement("details");
  details.className = "whitelist-details";
  const summary = document.createElement("summary");
  const bits = [];
  if (ageDays) bits.push(`only block older than ${ageDays}d`);
  bits.push(`${wlCount} allowed`);
  summary.textContent = `Whitelist & age rule — ${bits.join(" · ")}`;
  details.appendChild(summary);

  const wrap = document.createElement("div");
  wrap.className = "whitelist";
  details.appendChild(wrap);

  wrap.appendChild(buildAgeRule(channelId, channelEntry));

  const entries = Object.entries(whitelist);
  const ageOn = channelEntry.blockOlderThanDays > 0;
  if (!entries.length) {
    const empty = document.createElement("p");
    empty.className = "empty-inline";
    empty.textContent = ageOn
      ? `No always-allow exceptions. Videos newer than ${channelEntry.blockOlderThanDays} days already stay visible.`
      : "No exceptions yet — every video from this channel is blocked.";
    wrap.appendChild(empty);
  } else {
    const list = document.createElement("ul");
    list.className = "whitelist-list";
    entries.forEach(([videoId, title]) => {
      const item = document.createElement("li");

      const label = document.createElement("span");
      label.className = "item-name";
      label.textContent = title || videoId;
      item.appendChild(label);

      const idSpan = document.createElement("span");
      idSpan.className = "item-id";
      idSpan.textContent = videoId;
      item.appendChild(idSpan);

      const removeBtn = document.createElement("button");
      removeBtn.className = "unblock-btn";
      removeBtn.textContent = "Remove";
      removeBtn.addEventListener("click", async () => {
        await chrome.runtime.sendMessage({ type: MSG.UNWHITELIST_CHANNEL_VIDEO, id: channelId, videoId });
        refresh();
      });
      item.appendChild(removeBtn);

      list.appendChild(item);
    });
    wrap.appendChild(list);
  }

  const addRow = document.createElement("div");
  addRow.className = "whitelist-add";
  const input = document.createElement("input");
  input.type = "text";
  input.placeholder = "Paste a video URL or ID to allow it";
  addRow.appendChild(input);
  const addBtn = document.createElement("button");
  addBtn.textContent = "Allow";
  addBtn.addEventListener("click", async () => {
    const videoId = extractVideoId(input.value.trim());
    if (!videoId) {
      alert(
        "Couldn't find a video ID in that — paste a full youtube.com/watch?v=... URL, a youtu.be link, or the 11-character video ID."
      );
      return;
    }
    await chrome.runtime.sendMessage({ type: MSG.WHITELIST_CHANNEL_VIDEO, id: channelId, videoId, title: "" });
    input.value = "";
    refresh();
  });
  addRow.appendChild(addBtn);
  wrap.appendChild(addRow);

  return details;
}

function extractVideoId(text) {
  if (!text) return null;
  const m =
    text.match(/[?&]v=([\w-]{11})/) ||
    text.match(/\/shorts\/([\w-]{11})/) ||
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

// ---------- "Never-block" allow-list ----------
function renderAllowlist() {
  const ul = document.getElementById("allow-list");
  if (!ul) return;
  const empty = document.getElementById("allow-empty");
  const list = (state.allowlist && typeof state.allowlist === "object" && state.allowlist) || {};
  const keys = Object.keys(list).sort((a, b) => (list[b].ts || 0) - (list[a].ts || 0));
  setNavCount("nav-allowlist", keys.length);
  ul.innerHTML = "";
  keys.forEach((key) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "item-name";
    // Show the channel's display name if it's also somewhere in the blocklist.
    const known = Object.entries(state.channels || {}).find(
      ([id, e]) => id === key || (e.handle || "").toLowerCase() === key || e.ucid === key
    );
    name.textContent = (known && known[1].name) || key;
    li.appendChild(name);
    if (known && known[1].name) {
      const idSpan = document.createElement("span");
      idSpan.className = "item-id";
      idSpan.textContent = key;
      li.appendChild(idSpan);
    }
    const rm = document.createElement("button");
    rm.className = "unblock-btn";
    rm.textContent = "Remove";
    rm.addEventListener("click", async () => {
      rm.disabled = true;
      await chrome.runtime.sendMessage({ type: MSG.DISALLOW_CHANNEL, id: key });
      refresh();
    });
    li.appendChild(rm);
    ul.appendChild(li);
  });
  if (empty) empty.hidden = keys.length > 0;
}

function initAllowlist() {
  const btn = document.getElementById("allow-add-btn");
  if (!btn) return;
  const input = document.getElementById("allow-input");
  const add = async () => {
    const key = extractChannelKey(input.value);
    if (!key) {
      alert("Couldn't read a channel from that — paste an @handle, a UC… ID, or a channel URL.");
      return;
    }
    input.value = "";
    await chrome.runtime.sendMessage({ type: MSG.ALLOW_CHANNEL, id: key });
    refresh();
  };
  btn.addEventListener("click", add);
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") add();
  });
}
initAllowlist();

// ---------- top-level page tabs (Blocklist / Settings / Sync) ----------
function showPage(name) {
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
  if (saved && document.getElementById("page-" + saved)) showPage(saved);
} catch {}

document.getElementById("search").addEventListener("input", (e) => {
  filter = e.target.value.trim().toLowerCase();
  resetShown(); // a different set of rows — start from the top again
  render();
});

document.querySelectorAll(".filter-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    tab = btn.dataset.tab;
    resetShown();
    render();
  });
});

document.getElementById("clear-videos-btn").addEventListener("click", async (e) => {
  const btn = e.currentTarget; // capture before any await (currentTarget nulls out after)
  const total = Object.keys(state.videos || {}).length;
  if (!total) return;
  if (!confirm(`Unblock all ${total} blocked videos? This can't be undone (channels are not touched).`)) return;
  btn.disabled = true;
  const res = await chrome.runtime.sendMessage({ type: MSG.CLEAR_BLOCKED_VIDEOS });
  btn.disabled = false;
  await refresh();
  if (res && res.ok) alert(`Cleared ${res.cleared} blocked videos.`);
});

document.getElementById("sort-by").addEventListener("change", (e) => {
  sortBy = e.target.value;
  resetShown();
  render();
});

document.getElementById("hide-small").addEventListener("change", (e) => {
  hideSmall = e.target.checked;
  render();
});
document.getElementById("small-threshold").addEventListener("change", (e) => {
  smallThreshold = Math.max(0, Math.floor(Number(e.target.value) || 0));
  if (hideSmall) render();
});

// ---------- bulk-select mode ----------
document.getElementById("select-mode-btn").addEventListener("click", () => {
  selectMode = !selectMode;
  if (!selectMode) selected.clear();
  render();
});

function shownChannelIds() {
  return Array.from(document.querySelectorAll("#channel-list .channel-row")).map((li) => li.dataset.id);
}

document.getElementById("bulk-select-all").addEventListener("click", () => {
  shownChannelIds().forEach((id) => selected.add(id));
  render();
});
document.getElementById("bulk-clear-sel").addEventListener("click", () => {
  selected.clear();
  render();
});

// Run one message per selected channel, then refresh once. `confirmMsg` is
// shown when destructive; `label` names the op in the final alert.
async function bulkApply(label, makeMsg, confirmMsg) {
  const ids = [...selected];
  if (!ids.length) return;
  if (confirmMsg && !confirm(confirmMsg.replace("%n", ids.length))) return;
  const bar = document.getElementById("bulk-bar");
  bar.querySelectorAll("button").forEach((b) => (b.disabled = true));
  suppressStorageRefresh = true;
  for (const id of ids) {
    const msg = makeMsg(id);
    if (msg) await chrome.runtime.sendMessage(msg).catch(() => {});
  }
  suppressStorageRefresh = false;
  selected.clear();
  bar.querySelectorAll("button").forEach((b) => (b.disabled = false));
  await refresh();
  alert(`${label}: ${ids.length} channel${ids.length === 1 ? "" : "s"}.`);
}

document.getElementById("bulk-hide").addEventListener("click", () =>
  bulkApply("Hidden", (id) => ({ type: MSG.SET_ENTRY_HIDDEN, kind: "channel", id, hidden: true }))
);
document.getElementById("bulk-videoonly").addEventListener("click", () =>
  bulkApply("Switched to video-only", (id) => ({
    type: MSG.SET_CHANNEL_MODE,
    id,
    mode: CHANNEL_MODE.EXCEPT_WHITELIST
  }))
);
document.getElementById("bulk-allow").addEventListener("click", () =>
  bulkApply(
    "Added to never-block",
    (id) => ({ type: MSG.ALLOW_CHANNEL, id }),
    "Never-block %n selected channel(s)? They stay in the blocklist but nothing from them will be hidden."
  )
);
document.getElementById("bulk-unblock").addEventListener("click", () =>
  bulkApply(
    "Unblocked",
    (id) => ({ type: MSG.UNBLOCK_CHANNEL, id }),
    "Unblock %n selected channel(s)? You can restore recent ones from “Recently unblocked”."
  )
);

// Scrape sub counts for a set of channel ids, a few in parallel, with a small
// stagger so youtube.com isn't hammered. Repaints once at the end.
async function bulkFetchSubs(ids, btn, doneLabel) {
  if (!ids.length) {
    alert("Every channel here already has a recent subscriber count.");
    return;
  }
  bulkRunning = true;
  bulkStop = false;
  suppressStorageRefresh = true;
  btn.classList.add("bulk-active");
  btn.dataset.orig = btn.textContent;
  btn.textContent = "Stop";
  const progress = document.getElementById("bulk-progress");
  progress.hidden = false;

  // Batch the ids and let the background worker fan out 8 concurrent fetches
  // per message, writing each batch's results with a single storage write.
  // Two batch-messages in flight. This replaced one message + one storage
  // write per channel, which is what made a few-thousand-channel sweep crawl.
  const BATCH = 40;
  const batches = [];
  for (let i = 0; i < ids.length; i += BATCH) batches.push(ids.slice(i, i + BATCH));
  let sent = 0;
  let got = 0;
  let rl = false;
  let next = 0;
  const runner = async () => {
    while (next < batches.length && !bulkStop) {
      const batch = batches[next++];
      const r = await chrome.runtime.sendMessage({ type: MSG.BULK_FETCH_CHANNEL_INFO, ids: batch });
      sent += batch.length;
      if (r && r.got) got += r.got;
      if (r && r.rateLimited) {
        rl = true;
        await new Promise((s) => setTimeout(s, 3000));
      }
      progress.textContent =
        `Fetched ${Math.min(sent, ids.length)}/${ids.length}` + (rl ? " · slowing down (YouTube rate-limited us)" : "…");
    }
  };
  await Promise.all([runner(), runner()]);

  suppressStorageRefresh = false;
  bulkRunning = false;
  btn.classList.remove("bulk-active");
  if (btn.dataset.orig) btn.textContent = btn.dataset.orig;
  const missed = Math.min(sent, ids.length) - got;
  progress.textContent = bulkStop
    ? `Stopped — ${got}/${ids.length} fetched.`
    : `${doneLabel}: ${got} fetched${missed > 0 ? `, ${missed} unavailable` : ""}.`;
  // Push the newly-fetched sub counts / handles / names to the gist once, and
  // re-broadcast so open YouTube tabs start matching by the new @handles
  // without a reload.
  chrome.runtime.sendMessage({ type: MSG.SYNC_NOW }).catch(() => {});
  chrome.runtime.sendMessage({ type: MSG.REBROADCAST_BLOCKLIST }).catch(() => {});
  await refresh();
}

// "Load sub counts" — just the channels currently rendered.
document.getElementById("load-subs-btn").addEventListener("click", (e) => {
  if (bulkRunning) {
    bulkStop = true;
    return;
  }
  const ids = Array.from(document.querySelectorAll("#channel-list .channel-row")).map((li) => li.dataset.id);
  bulkFetchSubs(
    ids.filter((id) => state.channels[id] && !subsAttempted(state.channels[id])),
    e.currentTarget,
    "Done"
  );
});

// "Fetch all sub counts" — the entire blocklist, not just what's on screen.
// Doubles as a Stop button while running. Resumable: re-running skips channels
// that already got a fresh count.
document.getElementById("fetch-all-subs-btn").addEventListener("click", (e) => {
  if (bulkRunning) {
    bulkStop = true;
    return;
  }
  const ids = Object.keys(state.channels).filter((id) => !subsAttempted(state.channels[id]));
  if (ids.length > 500 && !confirm(`Fetch subscriber counts for ${ids.length} channels? This takes a while — you can Stop and resume.`)) {
    return;
  }
  bulkFetchSubs(ids, e.currentTarget, "All done");
});

document.getElementById("export-btn").addEventListener("click", () => {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "blocktube-blocklist.json";
  a.click();
  URL.revokeObjectURL(url);
});

// Original BlockTube export → this extension's { channels, videos } shape.
// filterData.channelId / .videoId are text lists: each real id is preceded by
// a `// Blocked by … (<name>) (<M/D/YYYY, h:mm:ss AM/PM>)` line.
function convertOldBlockTube(raw) {
  const fd = raw.filterData || {};
  const COMMENT_RE = /^\/\/\s*Blocked by [^(]*\((.*)\) \((\d{1,2}\/\d{1,2}\/\d{4}[^)]*)\)\s*$/;
  const toTs = (s) => {
    const t = Date.parse(s);
    return Number.isNaN(t) ? Date.now() : t;
  };
  const parse = (lines, idRe) => {
    const out = {};
    let name = "";
    let ts = 0;
    for (const ln of lines || []) {
      const s = String(ln).trim();
      if (!s) continue;
      if (s.startsWith("//")) {
        const m = s.match(COMMENT_RE);
        if (m) {
          name = m[1].trim();
          ts = toTs(m[2]);
        } else if (!s.startsWith("// Add your")) {
          // name with a stray newline landed on the comment line — keep going
        }
        continue;
      }
      if (idRe.test(s) && !out[s]) {
        out[s] = { name, ts: ts || Date.now() };
        name = "";
        ts = 0;
      }
    }
    return out;
  };
  const chRaw = parse(fd.channelId, /^(UC[\w-]{22}|@[\w.-]+)$/);
  const vidRaw = parse(fd.videoId, /^[\w-]{11}$/);
  const channels = {};
  for (const [id, v] of Object.entries(chRaw)) {
    channels[id] = { name: v.name, ts: v.ts, mode: "full", whitelist: {} };
  }
  const videos = {};
  for (const [id, v] of Object.entries(vidRaw)) videos[id] = { title: v.name, ts: v.ts };
  return { channels, videos };
}

document.getElementById("import-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    let data = JSON.parse(await file.text());
    // Accept the original BlockTube export shape too (filterData.channelId is a
    // text list: a "// Blocked by … (Name) (Date)" comment then the id).
    if (data && data.filterData && Array.isArray(data.filterData.channelId)) {
      data = convertOldBlockTube(data);
      alert(
        `Detected an old-BlockTube export — converted to ${Object.keys(data.channels).length} ` +
          `channels and ${Object.keys(data.videos).length} videos.`
      );
    }
    if (!data || typeof data !== "object" || (!data.channels && !data.videos)) {
      throw new Error("no \"channels\" or \"videos\" object found");
    }
    const res = await chrome.runtime.sendMessage({
      type: MSG.IMPORT_BLOCKLIST,
      channels: data.channels || {},
      videos: data.videos || {}
    });
    await refresh();
    if (res && res.ok) {
      const need = Object.keys(state.channels).filter((id) => !subsAttempted(state.channels[id]));
      const go =
        need.length > 0 &&
        confirm(
          `Import done — ${res.channels} channels, ${res.videos} videos.\n\n` +
            `Fetch @handles + subscriber counts for ${need.length} channels now?\n\n` +
            `Recommended: channels imported as "UC…" ids only block once their ` +
            `@handle is known (YouTube's feed tiles link by @handle). ` +
            `Runs here in the background — you can Stop and it resumes.`
        );
      if (go) bulkFetchSubs(need, document.getElementById("fetch-all-subs-btn"), "All done");
      else alert(`Blocklist now holds ${res.channels} channels and ${res.videos} videos.`);
    }
  } catch (err) {
    alert("Couldn't read that file as a BlockTube blocklist export: " + err.message);
  } finally {
    e.target.value = "";
  }
});

// Live-refresh on any storage change, but coalesced — a bulk sub-count load
// fires one write per channel and we don't want a full re-render each time.
let refreshTimer = null;
let suppressStorageRefresh = false;
chrome.storage.onChanged.addListener((changes, area) => {
  if (suppressStorageRefresh) return;
  // a toggle flip touches only bt_settings — initSettings handles that itself
  if (area === "sync" && Object.keys(changes).length === 1 && changes[SETTINGS_KEY]) return;
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(refresh, 300);
});

// ---------- feature toggles ("What this extension changes") ----------
// ---------------- "What gets hidden" ----------------
// Two levels: a group is a heading with a master switch, and every leaf under
// it is one thing removed from YouTube. Only leaves are stored (see
// SETTING_GROUPS in shared/constants.js) — the master is derived from its
// leaves, so it can never disagree with what is actually applied.
let currentSettings = { ...DEFAULT_SETTINGS };
let settingsFilter = "";

const settingsListEl = () => document.getElementById("settings-list");

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
  const list = settingsListEl();
  if (!list) return;
  list.replaceChildren();
  let shown = 0;

  for (const group of SETTING_GROUPS) {
    const items = group.items.filter((it) => matchesSettingFilter(group, it));
    if (!items.length) continue;
    shown += items.length;

    const section = document.createElement("section");
    section.className = "sgroup";
    section.dataset.group = group.id;

    const head = document.createElement("header");
    head.className = "sgroup-head";

    const title = document.createElement("div");
    title.className = "sgroup-title";
    const h = document.createElement("h2");
    h.textContent = group.label;
    const sub = document.createElement("p");
    sub.textContent = group.desc;
    title.append(h, sub);

    // The master reflects the group's leaves: on when all are on, off when
    // none are, mixed otherwise. Clicking it sets every leaf in the group.
    const on = group.items.filter((it) => currentSettings[it.key] !== false).length;
    const all = group.items.length;

    const meta = document.createElement("div");
    meta.className = "sgroup-meta";
    const count = document.createElement("span");
    count.className = "sgroup-count";
    count.textContent = on === all ? `all ${all} hidden` : on === 0 ? "none hidden" : `${on} of ${all} hidden`;
    const { label: master, cb: masterCb } = buildToggle("group-toggle", on === all, async (checked) => {
      const next = { ...currentSettings };
      for (const it of group.items) next[it.key] = checked;
      await writeSettings(next);
    });
    masterCb.indeterminate = on > 0 && on < all;
    master.title = `Turn everything in “${group.label}” ${on === all ? "off" : "on"}`;
    meta.append(count, master);
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

  const empty = document.getElementById("settings-empty");
  if (empty) empty.hidden = shown > 0;
  const navCount = document.getElementById("nav-settings");
  if (navCount) {
    const total = SETTING_GROUPS.reduce((n, g) => n + g.items.length, 0);
    const active = SETTING_GROUPS.reduce(
      (n, g) => n + g.items.filter((it) => currentSettings[it.key] !== false).length,
      0
    );
    navCount.textContent = `${active}/${total}`;
  }
}

async function initSettings() {
  if (!settingsListEl()) return;
  const res = await chrome.storage.sync.get({ [SETTINGS_KEY]: null });
  currentSettings = resolveSettings(res[SETTINGS_KEY]);
  renderSettings();

  const search = document.getElementById("settings-search");
  if (search) {
    search.addEventListener("input", (e) => {
      settingsFilter = e.target.value.trim().toLowerCase();
      renderSettings();
    });
  }

  document.getElementById("settings-reset").addEventListener("click", async () => {
    await writeSettings({ ...DEFAULT_SETTINGS });
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[SETTINGS_KEY]) {
      currentSettings = resolveSettings(changes[SETTINGS_KEY].newValue);
      renderSettings();
    }
  });
}

initSettings();

// ---------- cross-browser sync (GitHub Gist) ----------
const sync = {
  card: document.getElementById("sync-card"),
  token: document.getElementById("sync-token"),
  save: document.getElementById("sync-save"),
  status: document.getElementById("sync-status"),
  actions: document.getElementById("sync-actions"),
  now: document.getElementById("sync-now"),
  disconnect: document.getElementById("sync-disconnect")
};

function fmtAgo(ms) {
  if (!ms) return "never";
  const diff = Date.now() - ms;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return Math.round(diff / 60000) + " min ago";
  if (diff < 86400000) return Math.round(diff / 3600000) + " h ago";
  return new Date(ms).toLocaleString();
}

async function renderSyncStatus() {
  const s = await chrome.runtime.sendMessage({ type: MSG.GET_SYNC_STATUS });
  if (!s) return;
  if (s.enabled) {
    sync.token.value = "";
    sync.token.placeholder = "Connected — paste a new token to replace it";
    sync.save.textContent = "Replace token";
    sync.actions.hidden = false;
    sync.status.hidden = false;
    if (s.lastError) {
      sync.status.className = "sync-status error";
      sync.status.textContent = "Sync error: " + s.lastError;
    } else {
      sync.status.className = "sync-status ok";
      sync.status.replaceChildren();
      const line1 = document.createElement("div");
      line1.textContent =
        `Connected — ${s.remoteChannels.toLocaleString()} channels and ${s.remoteVideos.toLocaleString()} videos in the gist. ` +
        `Pushed ${fmtAgo(s.lastPushedAt)}, pulled ${fmtAgo(s.lastPulledAt)}.`;
      sync.status.appendChild(line1);
      if (s.gistUrl) {
        const a = document.createElement("a");
        a.href = s.gistUrl;
        a.target = "_blank";
        a.rel = "noopener";
        a.textContent = "View the gist on GitHub";
        sync.status.appendChild(a);
      }
      const line3 = document.createElement("div");
      line3.className = "sync-hint";
      line3.textContent =
        "To sync another device: open this page there → Sync → paste the same token → Connect. It pulls this list.";
      sync.status.appendChild(line3);
    }
  } else {
    sync.token.placeholder = "github_pat_…";
    sync.save.textContent = "Connect";
    sync.actions.hidden = true;
    sync.status.hidden = true;
  }
}

function initSync() {
  if (!sync.card) return;
  renderSyncStatus();

  sync.save.addEventListener("click", async () => {
    const token = sync.token.value.trim();
    if (!token) {
      alert("Paste a GitHub token first.");
      return;
    }
    sync.save.disabled = true;
    sync.save.textContent = "Connecting…";
    const res = await chrome.runtime.sendMessage({ type: MSG.SET_SYNC_CONFIG, token });
    sync.save.disabled = false;
    if (!res || res.ok === false) {
      alert("Couldn't connect: " + ((res && res.error) || "unknown error"));
    }
    await renderSyncStatus();
    refresh();
  });

  sync.now.addEventListener("click", async () => {
    sync.now.disabled = true;
    sync.now.textContent = "Syncing…";
    await chrome.runtime.sendMessage({ type: MSG.SYNC_NOW });
    sync.now.disabled = false;
    sync.now.textContent = "Sync now";
    await renderSyncStatus();
    refresh();
  });

  sync.disconnect.addEventListener("click", async () => {
    if (!confirm("Stop syncing on this device? Your blocklist stays; it just won't push or pull here anymore.")) {
      return;
    }
    await chrome.runtime.sendMessage({ type: MSG.SET_SYNC_CONFIG, token: null });
    await renderSyncStatus();
  });
}

initSync();

// ---------- title-keyword filters ----------
let keywords = { list: [], ts: 0, durMinSec: 0, durMaxSec: 0 };

function renderKeywords() {
  const ul = document.getElementById("kw-list");
  const empty = document.getElementById("kw-empty");
  if (!ul) return;
  setNavCount("nav-keywords", keywords.list.length);
  ul.innerHTML = "";
  keywords.list.forEach((k, i) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "item-name";
    name.style.fontFamily = k.re ? "monospace" : "";
    name.textContent = k.p;
    li.appendChild(name);
    if (k.re) {
      const tag = document.createElement("span");
      tag.className = "mode-tag";
      tag.textContent = "regex";
      li.appendChild(tag);
    }
    const rm = document.createElement("button");
    rm.className = "unblock-btn";
    rm.textContent = "Remove";
    rm.addEventListener("click", () => {
      keywords.list.splice(i, 1);
      saveKeywords();
    });
    li.appendChild(rm);
    ul.appendChild(li);
  });
  empty.hidden = keywords.list.length > 0;
}

async function saveKeywords() {
  keywords.ts = Date.now();
  await chrome.storage.sync.set({
    [KEYWORDS_KEY]: {
      list: keywords.list,
      ts: keywords.ts,
      durMinSec: keywords.durMinSec || 0,
      durMaxSec: keywords.durMaxSec || 0
    }
  });
  chrome.runtime.sendMessage({ type: MSG.SYNC_NOW }).catch(() => {});
  renderKeywords();
}

function renderDuration() {
  const mn = document.getElementById("dur-min");
  const mx = document.getElementById("dur-max");
  if (!mn) return;
  mn.value = keywords.durMinSec ? String(keywords.durMinSec) : "";
  mx.value = keywords.durMaxSec ? String(Math.round(keywords.durMaxSec / 60)) : "";
}

function initKeywords() {
  if (!document.getElementById("kw-list")) return;
  chrome.storage.sync.get(KEYWORDS_KEY).then((r) => {
    const k = r[KEYWORDS_KEY];
    if (k && Array.isArray(k.list)) {
      keywords = { list: k.list, ts: Number(k.ts) || 0, durMinSec: Number(k.durMinSec) || 0, durMaxSec: Number(k.durMaxSec) || 0 };
    }
    renderKeywords();
    renderDuration();
  });

  document.getElementById("dur-save").addEventListener("click", () => {
    keywords.durMinSec = Math.max(0, Math.floor(Number(document.getElementById("dur-min").value) || 0));
    keywords.durMaxSec = Math.max(0, Math.floor(Number(document.getElementById("dur-max").value) || 0)) * 60;
    saveKeywords();
    renderDuration();
  });

  const add = () => {
    const input = document.getElementById("kw-input");
    const isRe = document.getElementById("kw-regex").checked;
    const p = input.value.trim();
    if (!p) return;
    if (isRe) {
      try {
        new RegExp(p);
      } catch (e) {
        alert("That's not a valid regular expression: " + e.message);
        return;
      }
    }
    if (!keywords.list.some((k) => k.p === p && !!k.re === isRe)) {
      keywords.list.unshift({ p, re: isRe });
      saveKeywords();
    }
    input.value = "";
    document.getElementById("kw-regex").checked = false;
  };
  document.getElementById("kw-add-btn").addEventListener("click", add);
  document.getElementById("kw-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") add();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[KEYWORDS_KEY]) {
      const k = changes[KEYWORDS_KEY].newValue;
      keywords =
        k && Array.isArray(k.list)
          ? { list: k.list, ts: Number(k.ts) || 0, durMinSec: Number(k.durMinSec) || 0, durMaxSec: Number(k.durMaxSec) || 0 }
          : { list: [], ts: 0, durMinSec: 0, durMaxSec: 0 };
      renderKeywords();
      renderDuration();
    }
  });
}
initKeywords();

// ---------- "recently unblocked" undo list ----------
async function renderRecentUnblocks() {
  const box = document.getElementById("recent-unblocks");
  if (!box) return;
  const res = await chrome.runtime.sendMessage({ type: MSG.GET_RECENT_UNBLOCKS });
  const log = (res && res.log) || [];
  document.getElementById("recent-count").textContent = String(log.length);
  box.hidden = log.length === 0;
  const ul = document.getElementById("recent-list");
  ul.innerHTML = "";
  log.forEach((rec, i) => {
    const li = document.createElement("li");
    const name = document.createElement("span");
    name.className = "item-name";
    name.textContent =
      rec.t === "bulk"
        ? `${rec.count} blocked videos (cleared)`
        : (rec.entry && (rec.entry.name || rec.entry.title)) || rec.id;
    li.appendChild(name);
    const when = document.createElement("span");
    when.className = "item-id";
    when.textContent = fmtAgo(rec.ts);
    li.appendChild(when);
    const btn = document.createElement("button");
    btn.className = "unblock-btn";
    btn.textContent = "Restore";
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      await chrome.runtime.sendMessage({ type: MSG.RESTORE_UNBLOCK, index: i });
      await refresh();
      renderRecentUnblocks();
    });
    li.appendChild(btn);
    ul.appendChild(li);
  });
}
document.getElementById("recent-clear").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: MSG.CLEAR_RECENT_UNBLOCKS });
  renderRecentUnblocks();
});

// Opening this page fetches the subscriber counts (and @handles, and real
// names) for channels that have never been looked up, then pushes them to the
// gist — bulkFetchSubs() ends with SYNC_NOW. It is self-limiting: only
// channels with no recorded attempt qualify, so once the blocklist is
// resolved this does nothing on subsequent opens, and counts already cached
// are never re-fetched (see subsAttempted). Resolving @handles is not just
// cosmetic — a UC…-keyed channel doesn't block modern feed tiles until its
// handle is known.
//
// It runs as the normal bulk job, so the button doubles as Stop and progress
// shows in the usual place; it just isn't waiting on a click.
async function autoFetchMissingSubs() {
  if (bulkRunning) return;
  const ids = Object.keys(state.channels || {}).filter((id) => !subsAttempted(state.channels[id]));
  if (!ids.length) return;
  const btn = document.getElementById("fetch-all-subs-btn");
  if (!btn) return;
  await bulkFetchSubs(ids, btn, "Auto-fetched");
}

refresh().then(autoFetchMissingSubs);
