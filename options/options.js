const { MSG, STORAGE, CHANNEL_MODE, SETTINGS_KEY, DEFAULT_SETTINGS, KEYWORDS_KEY } = self.BlockTube;

let state = { channels: {}, videos: {} };
let filter = "";
// Which filter tab is active: "all" | "full" | "videoOnly" | "videos" | "hidden"
let tab = "all";
// Channel sort: "recent" | "subsDesc" | "subsAsc" | "name"
let sortBy = "recent";
// Hide channels whose known sub count is below `smallThreshold` (unknown = kept).
let hideSmall = false;
let smallThreshold = 10000;
// "Fetch all sub counts" run control.
let bulkRunning = false;
let bulkStop = false;
// Cap on rows rendered per section — the blocklist can hold thousands; more
// than this and you're meant to narrow with search or a tab.
const RENDER_CAP = 300;

async function refresh() {
  state = await chrome.runtime.sendMessage({ type: MSG.GET_BLOCKLIST });
  render();
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

  const wantChannels = tab === "all" || tab === "full" || tab === "videoOnly" || tab === "hidden";
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
    ([id, entry]) => buildChannelRow(id, entry)
  );
  renderList(
    document.getElementById("video-list"),
    document.getElementById("video-empty"),
    document.getElementById("video-more"),
    videoEntries,
    ([id, entry]) =>
      buildRow(entry.title || id, id, "video", entry, () =>
        chrome.runtime.sendMessage({ type: MSG.UNBLOCK_VIDEO, id })
      )
  );

  const subsBtn = document.getElementById("load-subs-btn");
  if (subsBtn) subsBtn.hidden = !bulkRunning && !wantChannels;
  const fetchAllBtn = document.getElementById("fetch-all-subs-btn");
  if (fetchAllBtn && !bulkRunning) {
    const missing = allChannels.filter(([, e]) => !subsFresh(e)).length;
    fetchAllBtn.hidden = !wantChannels || missing === 0;
    fetchAllBtn.textContent = `Fetch all sub counts (${missing})`;
  }

  const smallNote = document.getElementById("small-note");
  if (smallNote) {
    smallNote.hidden = !hideSmall || hiddenBySmall === 0;
    smallNote.textContent = `${hiddenBySmall} channel${hiddenBySmall === 1 ? "" : "s"} under ${smallThreshold.toLocaleString()} subs hidden.`;
  }

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

function renderList(listEl, emptyEl, moreEl, entries, build) {
  listEl.innerHTML = "";
  entries.slice(0, RENDER_CAP).forEach((e) => listEl.appendChild(build(e)));
  emptyEl.hidden = entries.length > 0;
  if (moreEl) {
    moreEl.hidden = entries.length <= RENDER_CAP;
    if (entries.length > RENDER_CAP) {
      moreEl.textContent = `Showing ${RENDER_CAP} of ${entries.length}. Narrow with search or a tab.`;
    }
  }
}

function buildRow(label, id, kind, entry, onUnblock) {
  const li = document.createElement("li");

  const name = document.createElement("span");
  name.className = "item-name";
  name.textContent = label;
  li.appendChild(name);

  const idSpan = document.createElement("span");
  idSpan.className = "item-id";
  idSpan.textContent = id;
  li.appendChild(idSpan);

  if (entry.localOnly) {
    const tag = document.createElement("span");
    tag.className = "local-tag";
    tag.textContent = "local only";
    li.appendChild(tag);
  }

  li.appendChild(buildHideBtn(kind, id, entry));

  const btn = document.createElement("button");
  btn.className = "unblock-btn";
  btn.textContent = "Unblock";
  btn.addEventListener("click", async () => {
    await onUnblock();
    refresh();
  });
  li.appendChild(btn);

  return li;
}

// "Hide" removes a row from the blocklist manager without unblocking it — for
// entries you've reviewed and don't want to keep scrolling past. The Hidden tab
// shows them again with "Unhide".
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

  const name = document.createElement("span");
  name.className = "item-name";
  name.textContent = entry.name || entry.handle || id;
  top.appendChild(name);

  // Secondary identifier line. A channel keyed by @handle never gets one — the
  // handle is already a readable identifier and shows as/above the name. A
  // UC…-keyed channel shows its @handle once known (raw UC id kept as a
  // tooltip), or the UC id until then — but not if that just duplicates the
  // name line.
  const idLabel = id.startsWith("@") ? null : entry.handle || id;
  if (idLabel && idLabel !== (name.textContent || "")) {
    const idSpan = document.createElement("span");
    idSpan.className = "item-id";
    idSpan.textContent = idLabel;
    if (!id.startsWith("@") && entry.handle) idSpan.title = id;
    top.appendChild(idSpan);
  }

  top.appendChild(buildSubsChip(id, entry));

  if (entry.localOnly) {
    const tag = document.createElement("span");
    tag.className = "local-tag";
    tag.textContent = "local only";
    top.appendChild(tag);
  }

  const isSoft = entry.mode === CHANNEL_MODE.EXCEPT_WHITELIST;
  const modeTag = document.createElement("span");
  modeTag.className = "mode-tag";
  modeTag.textContent = isSoft ? "videos blocked (whitelist)" : "full block";
  top.appendChild(modeTag);

  const modeBtn = document.createElement("button");
  modeBtn.className = "mode-toggle-btn";
  modeBtn.textContent = isSoft ? "Switch to full block" : "Switch to whitelist mode";
  modeBtn.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({
      type: MSG.SET_CHANNEL_MODE,
      id,
      mode: isSoft ? CHANNEL_MODE.FULL : CHANNEL_MODE.EXCEPT_WHITELIST
    });
    refresh();
  });
  top.appendChild(modeBtn);

  top.appendChild(buildHideBtn("channel", id, entry));

  const unblockBtn = document.createElement("button");
  unblockBtn.className = "unblock-btn";
  unblockBtn.textContent = "Unblock";
  unblockBtn.addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: MSG.UNBLOCK_CHANNEL, id });
    refresh();
  });
  top.appendChild(unblockBtn);

  li.appendChild(top);
  if (isSoft) li.appendChild(buildWhitelistSection(id, entry));
  return li;
}

// Subscriber count chip. Shows the cached value if present, else a button that
// scrapes it once (background does the fetch — see FETCH_CHANNEL_SUBS).
const SUBS_STALE_MS = 30 * 24 * 60 * 60 * 1000;
function subsFresh(entry) {
  return entry && entry.subs && entry.subsAt && Date.now() - entry.subsAt < SUBS_STALE_MS;
}
function buildSubsChip(id, entry) {
  const chip = document.createElement("span");
  chip.className = "subs-chip";
  const fresh = subsFresh(entry);
  if (entry.subs) {
    chip.textContent = entry.subs === "hidden" ? "subs hidden" : entry.subs + " subs";
    chip.title = "Click to refresh";
    if (!fresh) chip.classList.add("stale");
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
  render();
});

document.querySelectorAll(".filter-tab").forEach((btn) => {
  btn.addEventListener("click", () => {
    tab = btn.dataset.tab;
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
    ids.filter((id) => state.channels[id] && !subsFresh(state.channels[id])),
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
  const ids = Object.keys(state.channels).filter((id) => !subsFresh(state.channels[id]));
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

document.getElementById("import-input").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
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
      const need = Object.keys(state.channels).filter((id) => !subsFresh(state.channels[id]));
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
const SETTING_DEFS = [
  {
    key: "removeShorts",
    label: "Remove Shorts",
    desc: "Shelves and tiles in feeds & search, the full-screen Shorts player, and /shorts links (all redirect to Subscriptions)."
  },
  {
    key: "redirectHomepage",
    label: "Skip the homepage",
    desc: "Open youtube.com straight to your Subscriptions feed instead of the recommendations home page."
  },
  {
    key: "logoToSubscriptions",
    label: "Logo → Subscriptions",
    desc: "The YouTube logo in the top bar goes to Subscriptions instead of the home feed."
  },
  {
    key: "cleanSidebar",
    label: "Trim the left sidebar",
    desc: "Hide Home, Shorts, Explore, More from YouTube, Report history, and the small-print footer. Subscriptions and Library stay."
  },
  {
    key: "cleanMasthead",
    label: "Trim the top bar",
    desc: "Hide the Create (+) and Notifications buttons."
  },
  {
    key: "removeRelated",
    label: "Hide related videos",
    desc: "Remove the “up next” column next to the player and widen the video/description/comments column into the space."
  },
  {
    key: "removeEndScreen",
    label: "Hide end-screen suggestions",
    desc: "Remove the grid of suggested videos that covers the player at the end, plus the teaser cards that pop up mid-video."
  },
  {
    key: "hideVoiceSearch",
    label: "Hide the voice-search button",
    desc: "Remove the microphone “Search with your voice” button next to the search bar."
  },
  {
    key: "accountButtonOnHover",
    label: "Auto-hide the account button",
    desc: "Fade out your account avatar in the top-right corner; it reappears when you hover that corner."
  },
  {
    key: "hideVideoActions",
    label: "Hide the video action buttons",
    desc: "On a watch page, remove Share, Save, Download, Clip and the “⋯” more menu (which is where Report lives). Like/Dislike and Subscribe stay."
  },
  {
    key: "hideMemberships",
    label: "Hide channel memberships",
    desc: "Remove the “Join” button, members-only videos and shelves wherever they appear, and the Membership tab on channels."
  },
  {
    key: "hideSearchSuggestions",
    label: "Hide search autocomplete",
    desc: "Remove the dropdown of suggested/trending searches that appears while you type in the search box."
  }
];

let currentSettings = { ...DEFAULT_SETTINGS };

function renderSettings() {
  const list = document.getElementById("settings-list");
  if (!list) return;
  list.innerHTML = "";
  for (const def of SETTING_DEFS) {
    const row = document.createElement("div");
    row.className = "setting-row";

    const text = document.createElement("div");
    text.className = "setting-text";
    const t = document.createElement("div");
    t.className = "setting-label";
    t.textContent = def.label;
    const d = document.createElement("div");
    d.className = "setting-desc";
    d.textContent = def.desc;
    text.append(t, d);

    const sw = document.createElement("label");
    sw.className = "switch";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = currentSettings[def.key] !== false;
    cb.addEventListener("change", async () => {
      currentSettings = { ...currentSettings, [def.key]: cb.checked };
      await chrome.storage.sync.set({ [SETTINGS_KEY]: currentSettings });
    });
    const slider = document.createElement("span");
    slider.className = "slider";
    sw.append(cb, slider);

    row.append(text, sw);
    list.appendChild(row);
  }
}

async function initSettings() {
  if (!document.getElementById("settings-card")) return;
  const res = await chrome.storage.sync.get({ [SETTINGS_KEY]: DEFAULT_SETTINGS });
  currentSettings = { ...DEFAULT_SETTINGS, ...(res[SETTINGS_KEY] || {}) };
  renderSettings();

  document.getElementById("settings-reset").addEventListener("click", async () => {
    currentSettings = { ...DEFAULT_SETTINGS };
    await chrome.storage.sync.set({ [SETTINGS_KEY]: currentSettings });
    renderSettings();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "sync" && changes[SETTINGS_KEY]) {
      currentSettings = { ...DEFAULT_SETTINGS, ...(changes[SETTINGS_KEY].newValue || {}) };
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
let keywords = { list: [], ts: 0 };

function renderKeywords() {
  const ul = document.getElementById("kw-list");
  const empty = document.getElementById("kw-empty");
  if (!ul) return;
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
  await chrome.storage.sync.set({ [KEYWORDS_KEY]: { list: keywords.list, ts: keywords.ts } });
  chrome.runtime.sendMessage({ type: MSG.SYNC_NOW }).catch(() => {});
  renderKeywords();
}

function initKeywords() {
  if (!document.getElementById("kw-list")) return;
  chrome.storage.sync.get(KEYWORDS_KEY).then((r) => {
    const k = r[KEYWORDS_KEY];
    if (k && Array.isArray(k.list)) keywords = { list: k.list, ts: Number(k.ts) || 0 };
    renderKeywords();
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
      keywords = k && Array.isArray(k.list) ? { list: k.list, ts: Number(k.ts) || 0 } : { list: [], ts: 0 };
      renderKeywords();
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

refresh();
