const { MSG, CHANNEL_MODE } = self.BlockTube;

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function init() {
  const [blocklist, tab] = await Promise.all([
    chrome.runtime.sendMessage({ type: MSG.GET_BLOCKLIST }),
    getActiveTab()
  ]);

  document.getElementById("channel-count").textContent = Object.keys(blocklist.channels || {}).length;
  document.getElementById("video-count").textContent = Object.keys(blocklist.videos || {}).length;

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
    const btn = document.getElementById("block-video-btn");
    if (blocklist.videos?.[target.videoId]) {
      btn.textContent = "Blocked";
      btn.disabled = true;
    } else {
      btn.addEventListener("click", async () => {
        await chrome.runtime.sendMessage({
          type: MSG.BLOCK_VIDEO,
          id: target.videoId,
          title: target.videoTitle
        });
        btn.textContent = "Blocked";
        btn.disabled = true;
      });
    }
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

    const existing = blocklist.channels?.[channel.key];
    if (existing) {
      const status = document.createElement("span");
      status.className = "block-btn";
      status.style.cursor = "default";
      status.textContent =
        existing.mode === CHANNEL_MODE.EXCEPT_WHITELIST ? "Videos blocked (whitelist)" : "Blocked";
      row.appendChild(status);
    } else {
      const btnGroup = document.createElement("div");
      btnGroup.className = "btn-group";

      const markBlocked = (statusText) => {
        btnGroup.replaceChildren();
        const status = document.createElement("span");
        status.className = "block-btn";
        status.style.cursor = "default";
        status.textContent = statusText;
        btnGroup.appendChild(status);
      };

      const fullBtn = document.createElement("button");
      fullBtn.className = "block-btn";
      fullBtn.textContent = "Block channel";
      fullBtn.addEventListener("click", async () => {
        await chrome.runtime.sendMessage({
          type: MSG.BLOCK_CHANNEL,
          id: channel.key,
          name: channel.name,
          mode: CHANNEL_MODE.FULL
        });
        markBlocked("Blocked");
      });
      btnGroup.appendChild(fullBtn);

      const softBtn = document.createElement("button");
      softBtn.className = "block-btn secondary";
      softBtn.textContent = "Block videos (allow some later)";
      softBtn.addEventListener("click", async () => {
        await chrome.runtime.sendMessage({
          type: MSG.BLOCK_CHANNEL,
          id: channel.key,
          name: channel.name,
          mode: CHANNEL_MODE.EXCEPT_WHITELIST
        });
        markBlocked("Videos blocked (whitelist)");
      });
      btnGroup.appendChild(softBtn);

      row.appendChild(btnGroup);
    }

    channelRows.appendChild(row);
  });
}

document.getElementById("manage-btn").addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

init();
