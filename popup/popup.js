const { MSG, CHANNEL_MODE } = self.XrnTube;

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

// The blocklist key this channel is stored under, by any identity it has —
// a channel blocked as "@foo" is still blocked when this page names it by its
// UC id, and the popup should say so rather than offer to block it twice.
function findChannelKey(blocklist, key) {
  const channels = blocklist.channels || {};
  if (channels[key]) return key;
  const want = key.startsWith("@") ? key.toLowerCase() : key;
  for (const [id, e] of Object.entries(channels)) {
    if ((id.startsWith("@") ? id.toLowerCase() : id) === want) return id;
    if (e.handle && e.handle.toLowerCase() === want) return id;
    if (e.ucid === want) return id;
  }
  return null;
}

// A "Blocked" label with an Unblock button next to it. `onUnblock` undoes the
// block and returns the controls to offer in its place.
function blockedStatus(text, onUnblock) {
  const wrap = document.createElement("div");
  wrap.className = "btn-group row-inline";
  const status = document.createElement("span");
  status.className = "status";
  status.textContent = text;
  const undo = document.createElement("button");
  undo.className = "unblock-btn";
  undo.textContent = "Unblock";
  undo.addEventListener("click", async () => {
    undo.disabled = true;
    const next = await onUnblock();
    wrap.replaceWith(next);
    refreshCounts();
  });
  wrap.append(status, undo);
  return wrap;
}

async function refreshCounts() {
  const blocklist = await chrome.runtime.sendMessage({ type: MSG.GET_BLOCKLIST });
  document.getElementById("channel-count").textContent = Object.keys(blocklist.channels || {}).length.toLocaleString();
  document.getElementById("video-count").textContent = Object.keys(blocklist.videos || {}).length.toLocaleString();
  return blocklist;
}

function videoControls(target) {
  const btn = document.createElement("button");
  btn.className = "block-btn";
  btn.id = "block-video-btn";
  btn.textContent = "Block video";
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    await chrome.runtime.sendMessage({ type: MSG.BLOCK_VIDEO, id: target.videoId, title: target.videoTitle });
    btn.replaceWith(
      blockedStatus("Video blocked", async () => {
        await chrome.runtime.sendMessage({ type: MSG.UNBLOCK_VIDEO, id: target.videoId });
        return videoControls(target);
      })
    );
    refreshCounts();
  });
  return btn;
}

function channelControls(channel) {
  const btnGroup = document.createElement("div");
  btnGroup.className = "btn-group";

  const block = (mode, label) => async () => {
    btnGroup.querySelectorAll("button").forEach((b) => (b.disabled = true));
    await chrome.runtime.sendMessage({ type: MSG.BLOCK_CHANNEL, id: channel.key, name: channel.name, mode });
    btnGroup.replaceWith(
      blockedStatus(label, async () => {
        await chrome.runtime.sendMessage({ type: MSG.UNBLOCK_CHANNEL, id: channel.key });
        return channelControls(channel);
      })
    );
    refreshCounts();
  };

  const fullBtn = document.createElement("button");
  fullBtn.className = "block-btn";
  fullBtn.textContent = "Block channel";
  fullBtn.addEventListener("click", block(CHANNEL_MODE.FULL, "Blocked"));

  const softBtn = document.createElement("button");
  softBtn.className = "block-btn secondary";
  softBtn.textContent = "Block videos (allow some later)";
  softBtn.addEventListener("click", block(CHANNEL_MODE.EXCEPT_WHITELIST, "Videos blocked (whitelist)"));

  btnGroup.append(fullBtn, softBtn);
  return btnGroup;
}

async function init() {
  const [blocklist, tab] = await Promise.all([refreshCounts(), getActiveTab()]);

  const isYouTube = tab?.url && /:\/\/(www|m)\.youtube\.com\//.test(tab.url);
  if (!isYouTube) {
    document.getElementById("no-target").hidden = false;
    return;
  }

  let target;
  try {
    target = await chrome.tabs.sendMessage(tab.id, { type: MSG.GET_PAGE_TARGET });
  } catch {
    target = null;
  }

  const channels = target?.channels || [];
  if (!target || (!target.videoId && channels.length === 0)) {
    document.getElementById("no-target").hidden = false;
    return;
  }

  document.getElementById("current-page").hidden = false;

  if (target.videoId) {
    const row = document.getElementById("video-row");
    row.hidden = false;
    document.getElementById("video-title").textContent = target.videoTitle || target.videoId;
    const placeholder = document.getElementById("block-video-btn");
    placeholder.replaceWith(
      blocklist.videos?.[target.videoId]
        ? blockedStatus("Video blocked", async () => {
            await chrome.runtime.sendMessage({ type: MSG.UNBLOCK_VIDEO, id: target.videoId });
            return videoControls(target);
          })
        : videoControls(target)
    );
  }

  // Usually one channel, but a video can list several via YouTube's
  // channel-collaboration feature — show a block button for each.
  const channelRows = document.getElementById("channel-rows");
  channels.forEach((channel) => {
    const row = document.createElement("div");
    row.className = "row";

    const label = document.createElement("span");
    label.className = "label";
    label.textContent = channels.length > 1 ? "Channel (collab)" : "This channel";
    row.appendChild(label);

    const title = document.createElement("span");
    title.className = "title";
    title.textContent = channel.name || channel.key;
    row.appendChild(title);

    const storedKey = findChannelKey(blocklist, channel.key);
    if (storedKey) {
      const existing = blocklist.channels[storedKey];
      row.appendChild(
        blockedStatus(
          existing.mode === CHANNEL_MODE.EXCEPT_WHITELIST ? "Videos blocked (whitelist)" : "Blocked",
          async () => {
            await chrome.runtime.sendMessage({ type: MSG.UNBLOCK_CHANNEL, id: storedKey });
            return channelControls(channel);
          }
        )
      );
    } else {
      row.appendChild(channelControls(channel));
    }

    channelRows.appendChild(row);
  });
}

document.getElementById("manage-btn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});
document.getElementById("backup-btn").addEventListener("click", () => {
  // The options page reopens on the page it last showed; point it at Backup.
  chrome.tabs.create({ url: chrome.runtime.getURL("options/options.html#data") });
});

init();
