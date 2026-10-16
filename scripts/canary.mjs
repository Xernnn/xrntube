// The weekly canary: a few live tests against real YouTube, run on this
// machine on a timer, with a desktop notification when they fail.
//
// Why: what breaks this extension is YouTube renaming a tag or a JSON field,
// and the DOM scrub covers for most of it — blocked videos still go, a moment
// late — so nothing looks wrong until something does. These files touch the
// selectors and field paths that have moved before (docs/fragility.md).
// None of them looks channels up, so a weekly run doesn't add to the
// throttling a day of full-suite runs causes.
//
//   node scripts/canary.mjs              run it now (what the timer runs)
//   node scripts/canary.mjs --install    add a weekly systemd user timer
//   node scripts/canary.mjs --uninstall  remove it
//
// Logs go to ~/.cache/xrntube-canary/. A run with no network, or while
// YouTube is throttling this machine, is skipped rather than failed: neither
// says anything about the extension.
import { spawnSync, execFileSync } from "child_process";
import { mkdirSync, writeFileSync, rmSync, readdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const ROOT = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const TESTS = ["datalayer-live-test", "ownpage-test", "posts-playlists-test", "mobile-test", "settings-test"];
const LOG_DIR = join(homedir(), ".cache", "xrntube-canary");
const UNIT_DIR = join(homedir(), ".config", "systemd", "user");
const UNIT = "xrntube-canary";
const KEEP_LOGS = 12;

const arg = process.argv[2];
if (arg === "--install") install();
else if (arg === "--uninstall") uninstall();
else await run();

function notify(summary, body, urgency = "normal") {
  try {
    execFileSync("notify-send", ["-a", "XrnTube", "-u", urgency, summary, body]);
  } catch {
    // no notification daemon (or no notify-send): the log still has it
  }
}

async function youtubeState() {
  try {
    // The same probe the docs give for throttling: a /channel/UC… page
    // redirecting to google.com/sorry.
    const r = await fetch("https://www.youtube.com/channel/UCBJycsmduvYEL83R_U4JriQ", {
      redirect: "manual",
      signal: AbortSignal.timeout(15000)
    });
    const to = r.headers.get("location") || "";
    return /google\.com\/sorry/.test(to) ? "throttled" : "ok";
  } catch {
    return "offline";
  }
}

async function run() {
  mkdirSync(LOG_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const logFile = join(LOG_DIR, `${stamp}.log`);

  const state = await youtubeState();
  if (state !== "ok") {
    writeFileSync(logFile, `skipped: YouTube is ${state === "offline" ? "unreachable" : "throttling this machine"}\n`);
    console.log(`canary skipped (${state}); ${logFile}`);
    return;
  }

  const r = spawnSync("node", [join(ROOT, "test", "run.mjs"), ...TESTS], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    timeout: 40 * 60 * 1000
  });
  const out = (r.stdout || "") + (r.stderr || "");
  writeFileSync(logFile, out);
  pruneLogs();

  const failed = out.match(/^\s*(?:\x1b\[\d+m)?FAIL(?:\x1b\[0m)?\s+(\S+-test\.mjs)/gm) || [];
  const names = failed.map((l) => l.replace(/\x1b\[\d+m/g, "").trim().split(/\s+/)[1]);
  if (r.status === 0) {
    console.log(`canary passed (${TESTS.length} files); ${logFile}`);
    return;
  }
  const what = names.length ? names.join(", ") : `the run itself (exit ${r.status ?? r.signal})`;
  notify(
    "XrnTube: live tests failed",
    `${what}. YouTube may have changed something blocking relies on. Log: ${logFile}`,
    "critical"
  );
  console.error(`canary FAILED: ${what}; ${logFile}`);
  process.exitCode = 1;
}

function pruneLogs() {
  const logs = readdirSync(LOG_DIR).filter((f) => f.endsWith(".log")).sort();
  for (const f of logs.slice(0, Math.max(0, logs.length - KEEP_LOGS))) rmSync(join(LOG_DIR, f));
}

function systemctl(...a) {
  execFileSync("systemctl", ["--user", ...a], { stdio: "inherit" });
}

function install() {
  mkdirSync(UNIT_DIR, { recursive: true });
  // Absolute paths, resolved here: a user service doesn't get the login
  // shell's PATH, and the repo's location is this machine's business, not
  // something to write into the repo.
  writeFileSync(
    join(UNIT_DIR, `${UNIT}.service`),
    `[Unit]
Description=XrnTube weekly live-YouTube canary
Wants=network-online.target
After=network-online.target

[Service]
Type=oneshot
WorkingDirectory=${ROOT}
Environment=PATH=${process.env.PATH}
ExecStart=${process.execPath} ${join(ROOT, "scripts", "canary.mjs")}
Nice=10
`
  );
  // Monday morning, so a failure notification lands while someone's there to
  // see it. Persistent: a week the machine was off runs at the next start
  // instead of being skipped.
  writeFileSync(
    join(UNIT_DIR, `${UNIT}.timer`),
    `[Unit]
Description=Run the XrnTube canary weekly

[Timer]
OnCalendar=Mon *-*-* 10:00
Persistent=true
RandomizedDelaySec=30min

[Install]
WantedBy=timers.target
`
  );
  systemctl("daemon-reload");
  systemctl("enable", "--now", `${UNIT}.timer`);
  console.log(`installed: ${UNIT}.timer (weekly). Run once now with: systemctl --user start ${UNIT}.service`);
}

function uninstall() {
  try {
    systemctl("disable", "--now", `${UNIT}.timer`);
  } catch {
    // not installed
  }
  for (const f of [`${UNIT}.service`, `${UNIT}.timer`]) {
    const p = join(UNIT_DIR, f);
    if (existsSync(p)) rmSync(p);
  }
  systemctl("daemon-reload");
  console.log("removed the canary timer (logs stay in " + LOG_DIR + ")");
}
