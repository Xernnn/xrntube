// Shared across the content script (ISOLATED world) and the page hook (MAIN
// world): everything that answers "is this blocked?".
//
// Everything here is PURE — it takes a blocklist index plus a description of
// a thing, and returns a verdict. No DOM, no `chrome.*`. The page hook runs
// in the page's own world, where the extension APIs don't exist and there is
// no `chrome.storage` to read, so this file has to load there unchanged.
//
// It exists because the decision was about to be written twice. The DOM scrub
// and the JSON filter look at completely different inputs (an element vs. a
// renderer object), but they must reach the SAME verdict for the same video:
// otherwise a tile is hidden on one path and not the other, and the two
// layers disagree about what "blocked" means. **Layers may differ in what
// they can SEE; never in what they DECIDE.**
//
// Loaded as a plain classic script everywhere, hanging things off `self`.
// `shared/constants.js` must load first — CHANNEL_MODE comes from there.
self.XrnTube = self.XrnTube || {};

(() => {
  const { CHANNEL_MODE } = self.XrnTube;

  // Parses YouTube's relative "published" text ("3 days ago", "2 weeks ago",
  // "Streamed 5 months ago", "1 year ago") into an approximate age in days.
  // Language-independent: each entry matches "<number> <unit>" (in that order,
  // which holds for every locale YouTube ships — "vor 3 Wochen", "hace 3
  // semanas", "il y a 3 semaines", "3週間前", "3주 전", …) for one unit,
  // across ~15 languages' spellings. Ordered largest-unit-first so "month"
  // never loses to a partial "min" match. Returns null if nothing matches.
  // [unit spellings across ~15 languages, days-per-unit]. Anchored by the
  // preceding "<number><optional space>", which is enough on its own to stop
  // a short token (Turkish "ay" = month) matching inside a longer word
  // ("day"): after the digits the cursor sits on the first unit letter, so
  // "1 day" can only match the "day…" alternative, never "ay". Ordered
  // largest-unit-first. No \b — word boundaries don't work after the
  // diacritics / Cyrillic / CJK many of these end in.
  const AGE_UNITS = [
    [["years?", "yrs?", "années?", "ans?", "años?", "anos?", "jahren?", "anni", "anno", "jaar", "jaren", "tahun", "năm", "yıl", "годо?в?", "года?", "лет", "년", "年"], 365],
    [["months?", "mos?", "mois", "mes(?:es)?", "monaten?", "mesi", "mese", "maand(?:en)?", "bulan", "tháng", "ay", "месяц(?:ев|а)?", "개월", "ヶ月", "か月", "カ月", "ヵ月"], 30],
    [["weeks?", "wks?", "semaines?", "semanas?", "wochen?", "settiman[ae]", "weken?", "minggu", "tuần", "hafta", "недел(?:ь|и|ю)?", "주", "週間", "週"], 7],
    [["days?", "jours?", "d[ií]as?", "tag(?:en?)?", "giorni?", "dagen?", "hari", "ngày", "gün", "дн(?:ей|я)?", "день", "일", "日"], 1],
    [["hours?", "hrs?", "heures?", "horas?", "stunden?", "ore", "ora", "uur", "uren", "jam", "giờ", "saat", "час(?:ов|а)?", "시간", "時間"], 1 / 24],
    [["minutes?", "mins?", "minutos?", "minuten?", "minuti", "minuto", "menit", "phút", "dakika", "минут(?:ы|у)?", "분", "分"], 1 / 1440],
    [["seconds?", "secs?", "secondes?", "segundos?", "sekunden?", "secondi", "secondo", "seconden?", "detik", "giây", "saniye", "секунд(?:ы|у)?", "초", "秒"], 1 / 86400]
  ].map(([alts, days]) => [new RegExp(`(\\d+)\\s*(?:${alts.join("|")})`, "i"), days]);
  // Nothing on YouTube predates 2005, and a future date means we misread
  // something. A value outside this range is not an age, it is a parse bug.
  const MAX_PLAUSIBLE_AGE_DAYS = 100 * 365.25;

  function plausibleAgeDays(d) {
    return typeof d === "number" && Number.isFinite(d) && d >= -1 && d <= MAX_PLAUSIBLE_AGE_DAYS;
  }

  function parseAgeDays(text) {
    const t = text || "";
    // The compact form YouTube rolled out in 2026 — "3d ago", "2w ago", "7y
    // ago", "5h ago", "4mo ago": one letter, no space, which the table below
    // never matched, so every such tile read as undated and an age rule kept
    // all of them. Only taken with "ago" right after it: the same line
    // carries the view count ("6.7M"), which would otherwise read as minutes.
    const c = t.match(/(\d+)\s?(mo|[ywdhms])\s+ago\b/i);
    if (c) {
      const per = { y: 365, mo: 30, w: 7, d: 1, h: 1 / 24, m: 1 / 1440, s: 1 / 86400 };
      return parseInt(c[1], 10) * per[c[2].toLowerCase()];
    }
    for (const [re, days] of AGE_UNITS) {
      const m = t.match(re);
      if (m) return parseInt(m[1], 10) * days;
    }
    return null;
  }

  // "M:SS" / "H:MM:SS" → seconds; null if not parseable.
  function parseDurationSec(text) {
    const m = (text || "").match(/\b(\d{1,2}):([0-5]\d)(?::([0-5]\d))?\b/);
    if (!m) return null;
    return m[3] ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
  }

  const CHANNEL_HREF_RE = /^\/(channel\/UC[\w-]{22}|@[\w.-]+)/;

  function normalizeChannelKey(href) {
    const m = String(href || "").match(CHANNEL_HREF_RE);
    if (!m) return null;
    const path = m[1];
    return path.startsWith("channel/") ? path.slice("channel/".length) : path; // "UC..." or "@handle"
  }

  // Whether a given blocked channel entry blocks a specific video. Pass
  // `null` for videoId for "the channel page itself / a non-video tile".
  // `ageDays` is the video's approximate age (parseAgeDays), or null/undefined
  // if unknown.
  //  - FULL: blocks everything unconditionally.
  //  - EXCEPT_WHITELIST: the channel's own page and non-video tiles stay;
  //    whitelisted video IDs stay; then either every other video is blocked
  //    (no age rule) or only videos older than `blockOlderThanDays` are
  //    (recent uploads pass; unknown age is treated as "recent" so a
  //    parse failure never over-blocks a channel the user wants to keep
  //    partly visible).
  // A Short has NO publish date on any surface. Not "we couldn't parse it" —
  // there is nothing to parse: the tile renders a title and a view count, and
  // the JSON behind it (`shortsLockupViewModel`) carries
  // `"<title>, 1.4 million views – play Short"` and no date field at all
  // (confirmed live on a channel's Shorts tab, in the DOM and in
  // `ytInitialData`). So the "unknown age means recent, never over-block"
  // rule — which exists for a date that simply hasn't hydrated yet — quietly
  // exempted every short a channel has: an age-ruled channel's Videos tab
  // emptied while its Shorts tab stayed complete, which reads as the rule not
  // working at all.
  //
  // A dateless short is therefore treated as older than any threshold. It is
  // the only reading of "block their videos older than N days" that doesn't
  // leave half the channel behind, and unlike a missing byline there is no
  // later pass that could ever do better.
  const UNDATED_SHORT_AGE_DAYS = Number.MAX_SAFE_INTEGER;
  function ageForRule(ageDays, isShort) {
    return ageDays == null && isShort ? UNDATED_SHORT_AGE_DAYS : ageDays;
  }

  function channelBlocks(entry, videoId, ageDays) {
    if (!entry) return false;
    if (entry.mode === CHANNEL_MODE.EXCEPT_WHITELIST) {
      if (!videoId) return false;
      if (entry.whitelist && entry.whitelist[videoId]) return false;
      if (entry.blockOlderThanDays > 0) {
        return ageDays != null && ageDays >= entry.blockOlderThanDays;
      }
      return true;
    }
    return true;
  }

  // A channel has two identity formats (`UC…` and `@handle`) and any given
  // surface names exactly one, so every lookup goes through both side
  // indexes. `byHandle` is fed by an entry's own `@handle` key *and* its
  // scraped `entry.handle`; `byUcid` the same for `UC…` / `entry.ucid`. An
  // entry that knows only the format it was stored under is invisible on half
  // of YouTube — see docs/blocking-rules.md → Channel identity.
  function buildBlockIndex(blocklist) {
    const bl = blocklist || {};
    const channels = new Map(Object.entries(bl.channels || {}));
    const byHandle = new Map();
    const byUcid = new Map();
    for (const [key, entry] of channels) {
      if (key.charAt(0) === "@") byHandle.set(key.toLowerCase(), entry);
      else if (key.startsWith("UC")) byUcid.set(key, entry);
      if (entry && entry.handle) byHandle.set(String(entry.handle).toLowerCase(), entry);
      if (entry && entry.ucid) byUcid.set(String(entry.ucid), entry);
    }
    return {
      channels,
      byHandle,
      byUcid,
      videos: new Set(Object.keys(bl.videos || {})),
      allow: new Set(Object.keys(bl.allowlist || {}).map((k) => (k[0] === "@" ? k.toLowerCase() : k))),
      // True when at least one blocked channel carries `blockOlderThanDays`.
      // Gates the per-item publish-date parsing so the common case pays
      // nothing for it.
      anyAgeRule: Array.from(channels.values()).some((e) => e && e.blockOlderThanDays > 0)
    };
  }

  const EMPTY_INDEX = buildBlockIndex(null);

  // A hard "never hide anything from this channel", overriding every block
  // path (direct, collaborator, title keyword, duration, age rule).
  function isAllowedKey(index, key) {
    if (!key || !index || !index.allow.size) return false;
    return index.allow.has(key) || index.allow.has(String(key).toLowerCase());
  }

  // Resolve a channel key ("UC…" or "@handle") to a blocked entry, matching
  // the storage key, a scraped @handle, or a scraped UC id. Returns undefined
  // for an allow-listed channel, so callers can't accidentally skip that check.
  function lookupEntry(index, key) {
    if (!key || !index) return undefined;
    if (isAllowedKey(index, key)) return undefined; // allow-list wins over any block
    if (index.channels.has(key)) return index.channels.get(key);
    if (key.charAt(0) === "@") return index.byHandle.get(key.toLowerCase());
    if (key.startsWith("UC")) return index.byUcid.get(key);
    return undefined;
  }

  // The title-keyword + duration filter record (chrome.storage.sync) compiled
  // into something a hot loop can use. Capped at 200 patterns; a pattern that
  // doesn't compile is dropped rather than taking the page down with it.
  function compileFilters(rec) {
    const list = (rec && Array.isArray(rec.list) ? rec.list : []).slice(0, 200);
    const matchers = list
      .map(({ p, re }) => {
        const src = String(p || "").trim();
        if (!src) return null;
        try {
          return re ? new RegExp(src, "i") : new RegExp(src.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
        } catch {
          return null;
        }
      })
      .filter(Boolean);
    return {
      matchers,
      durMinSec: Math.max(0, Math.floor(Number(rec && rec.durMinSec) || 0)),
      durMaxSec: Math.max(0, Math.floor(Number(rec && rec.durMaxSec) || 0)),
      // How many top-level comment threads to keep on a watch page (0 = all).
      // Not a block rule — nothing downstream consults it in blockReasonFor()
      // — but it lives with the other numeric knobs so there is one place a
      // number the user typed gets read and clamped.
      commentLimit: Math.max(0, Math.floor(Number(rec && rec.commentLimit) || 0))
    };
  }

  const EMPTY_FILTERS = compileFilters(null);

  function anyFilterActive(filters) {
    return !!filters && (filters.matchers.length > 0 || filters.durMinSec > 0 || filters.durMaxSec > 0);
  }

  // The single verdict, for a thing described by whatever the caller could
  // see. `item` is a plain object; every field is optional, and a field the
  // caller couldn't read must be null/undefined rather than a guess:
  //   videoId, videoTitle, durationSec, ageDays, isPlaylist, isShort,
  //   channelKeys (iterable of "UC…" / "@handle")
  // Returns a short reason string, or null when nothing blocks it. "Blocked"
  // is just "reason != null" — keeping them one function is what stops the
  // debug log and the real decision ever disagreeing.
  function blockReasonFor(item, index, filters) {
    if (!item) return null;
    const idx = index || EMPTY_INDEX;
    const f = filters || EMPTY_FILTERS;
    // Materialised, not just accepted as-is: callers naturally pass
    // `someMap.keys()`, and this walks the list twice (allow-list first, then
    // the block check). An iterator is drained by the first pass, so the
    // second sees nothing and no channel ever matches — a full block that
    // silently stops blocking, with every other layer still behaving.
    const keys = item.channelKeys ? Array.from(item.channelKeys) : [];

    // Allow-list: a hard override, checked before anything else.
    for (const key of keys) if (isAllowedKey(idx, key)) return null;

    if (item.videoId && idx.videos.has(item.videoId)) return "blocked video id";
    if (item.videoId && item.videoTitle && f.matchers.some((r) => r.test(item.videoTitle))) {
      return `keyword match: "${String(item.videoTitle).slice(0, 60)}"`;
    }
    const d = item.durationSec;
    if (item.videoId && d != null && d > 0) {
      if (f.durMinSec > 0 && d < f.durMinSec) return `duration ${d}s < ${f.durMinSec}s`;
      if (f.durMaxSec > 0 && d > f.durMaxSec) return `duration ${d}s > ${f.durMaxSec}s`;
    }
    for (const key of keys) {
      const e = lookupEntry(idx, key);
      if (!e) continue;
      // A playlist made by a blocked channel goes regardless of block mode /
      // age rule — a playlist has no single publish date, and "block their
      // videos" naturally covers "block their playlists of those videos".
      if (item.isPlaylist) return `playlist by blocked channel ${key}`;
      if (channelBlocks(e, item.videoId, ageForRule(item.ageDays, item.isShort))) {
        return `channel ${key} (${e.mode || "full"}${e.blockOlderThanDays ? `, >${e.blockOlderThanDays}d` : ""})`;
      }
    }
    return null;
  }

  Object.assign(self.XrnTube, {
    AGE_UNITS,
    MAX_PLAUSIBLE_AGE_DAYS,
    plausibleAgeDays,
    parseAgeDays,
    parseDurationSec,
    UNDATED_SHORT_AGE_DAYS,
    ageForRule,
    CHANNEL_HREF_RE,
    normalizeChannelKey,
    channelBlocks,
    buildBlockIndex,
    EMPTY_INDEX,
    isAllowedKey,
    lookupEntry,
    compileFilters,
    EMPTY_FILTERS,
    anyFilterActive,
    blockReasonFor
  });
})();
