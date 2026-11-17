import { readFileSync } from "fs";

// Pure Node: content.js's heartbeat — the scrubs re-run every 2s — lifted out
// of the shipped file and driven with a fake document and fake timers.
//   - it beats for a few beats after the page last grew, then stops; growth
//     starts it again
//   - it keeps beating while a tile or a shelf still waits to hydrate
//   - it never beats on a hidden tab, and stops when the tab is hidden
// It used to beat every 2s for as long as a YouTube tab stayed open, each
// beat some 16 whole-document passes. subsfeed-test checks the wiring in the
// real extension: a settled page isn't rescanned, and a change to it is.

const fail = (m) => {
  console.error("FAIL:", m);
  process.exitCode = 1;
};
const ok = (m) => console.log("ok:", m);

const src = readFileSync(new URL("../content/content.js", import.meta.url), "utf8");
const block = src.match(/\n  const HEARTBEAT_MS = [\s\S]*?\n  function heartbeatBeat\(\) \{[\s\S]*?\n  \}\n/);
if (!block) {
  console.error("FAIL: couldn't find the heartbeat (HEARTBEAT_MS … heartbeatBeat()) in content/content.js");
  process.exit(1);
}

function harness() {
  const timers = new Map();
  let nextId = 1;
  const doc = { hidden: false, waiting: false, querySelector: () => (doc.waiting ? {} : null) };
  const env = { scrubs: 0 };
  const make = new Function(
    "document",
    "setInterval",
    "clearInterval",
    "scheduleExtrasScrub",
    `${block[0]}; return { wakeHeartbeat, heartbeatBeat, running: () => heartbeat !== null, HEARTBEAT_MS, HEARTBEAT_QUIET_BEATS };`
  );
  const hb = make(
    doc,
    (fn, ms) => {
      timers.set(nextId, { fn, ms });
      return nextId++;
    },
    (id) => timers.delete(id),
    () => env.scrubs++
  );
  // Advance by n beats: every interval still set fires once per beat.
  const tick = (n = 1) => {
    for (let i = 0; i < n; i++) for (const t of [...timers.values()]) t.fn();
  };
  return { hb, doc, env, tick, timers };
}

// ---- after the page grows, a few beats, then nothing ----
{
  const { hb, env, tick, timers } = harness();
  hb.wakeHeartbeat();
  tick(60); // two minutes of a settled page
  const settled = env.scrubs;
  const stopped = !hb.running() && timers.size === 0;
  hb.wakeHeartbeat(); // the observer saw an element added
  tick(1);
  hb.HEARTBEAT_MS === 2000 && settled === hb.HEARTBEAT_QUIET_BEATS && stopped && env.scrubs === settled + 1
    ? ok(`a settled page gets ${settled} beats after it last grew, then none for the next two minutes; growth starts it again`)
    : fail("settled page: " + JSON.stringify({ settled, stopped, after: env.scrubs }));
}

// ---- a tile waiting to hydrate keeps it going ----
{
  const { hb, doc, env, tick } = harness();
  doc.waiting = true;
  hb.wakeHeartbeat();
  tick(25);
  const whileWaiting = env.scrubs;
  doc.waiting = false;
  tick(30);
  whileWaiting === 25 && env.scrubs === 25 + hb.HEARTBEAT_QUIET_BEATS && !hb.running()
    ? ok("while a tile or a shelf waits to hydrate it beats every time, and stops a few beats after the last one settles")
    : fail("waiting tile: " + JSON.stringify({ whileWaiting, total: env.scrubs, running: hb.running() }));
}

// ---- hidden tabs ----
{
  const { hb, doc, env, tick } = harness();
  doc.hidden = true;
  hb.wakeHeartbeat();
  tick(10);
  const hiddenStart = env.scrubs;
  doc.hidden = false;
  doc.waiting = true;
  hb.wakeHeartbeat();
  tick(3);
  doc.hidden = true; // switched to another tab, a tile still waiting
  tick(10);
  hiddenStart === 0 && env.scrubs === 3 && !hb.running()
    ? ok("a hidden tab gets no beats, and a tab hidden mid-way stops at once, even with a tile waiting")
    : fail("hidden tab: " + JSON.stringify({ hiddenStart, total: env.scrubs, running: hb.running() }));
}

console.log("\nDONE");
