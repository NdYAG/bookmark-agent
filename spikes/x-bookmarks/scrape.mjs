#!/usr/bin/env node
// S2 spike: scroll x.com/i/bookmarks as identity x-prod-main and save what extract.js finds.
//
//   node spikes/x-bookmarks/scrape.mjs [--max 200] [--snapshots 3] [--out fixtures/x] [--cdp 9333]
//
// Default: opens a never-save session through ab-login (the stored login can't be damaged).
// --cdp <port>: attaches to the dedicated Chrome that chrome-profile.sh started (log in there by hand,
// no automation involved), in its own pinned tab. Then
// alternates extract → scroll with human-paced pauses until --max items or the list stops growing.
// Reads only rendered page content; never cookies, storage, or network data.
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const AB_LOGIN = join(homedir(), ".claude/skills/browser-login/scripts/ab-login");
const IDENTITY = "x-prod-main";
const SESSION = `s2-${IDENTITY}`;
const LIST_URL = "https://x.com/i/bookmarks";

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const MAX = Number(args.max ?? 200);
const SNAPSHOTS = Number(args.snapshots ?? 3);
const OUT = args.out ?? join(here, "../../fixtures/x");
const MAX_IDLE_ROUNDS = 4;
const CDP = args.cdp ?? null;
const BASE = ["--session", SESSION, ...(CDP ? ["--cdp", CDP, "--pin-tab"] : [])];

// X answers HeadlessChrome with 403, so use a regular UA that matches the installed Chrome major version.
async function userAgent() {
  if (process.env.AGENT_BROWSER_USER_AGENT) return process.env.AGENT_BROWSER_USER_AGENT;
  const dirs = await readdir(join(homedir(), ".agent-browser/browsers")).catch(() => []);
  const major = dirs.map((d) => Number(d.match(/^chrome-(\d+)\./)?.[1])).filter(Boolean).sort((a, b) => a - b).at(-1) ?? 158;
  return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

const env = { ...process.env, AGENT_BROWSER_USER_AGENT: await userAgent() };
const ab = async (...a) => (await run("agent-browser", [...BASE, ...a], { env, maxBuffer: 64 << 20 })).stdout;
const evalJs = async (js) => {
  const child = execFile("agent-browser", [...BASE, "--json", "eval", "--stdin"], { env, maxBuffer: 64 << 20 });
  child.stdin.end(js);
  const stdout = await new Promise((res, rej) => {
    let buf = "";
    child.stdout.on("data", (d) => (buf += d));
    child.on("error", rej);
    child.on("close", () => res(buf));
  });
  const parsed = JSON.parse(stdout);
  if (!parsed.success) throw new Error(parsed.error);
  return parsed.data.result;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pause = () => sleep(1500 + Math.random() * 2000);

async function main() {
  if (CDP) {
    // `tab new` binds a fresh tab even if the session still remembers a tab from an earlier Chrome
    // (`open` fails with tab_gone, and `close` does not clear that binding).
    await ab("tab", "new", LIST_URL);
    await ab("wait", "--load", "domcontentloaded").catch(() => {});
    await sleep(3000);
    const url = (await ab("get", "url")).trim();
    if (/\/i\/flow\/login|\/i\/jf\/onboarding|\/login/.test(url)) {
      console.error(`NEEDS_LOGIN (landed on ${url}). Run: chrome-profile.sh stop, then chrome-profile.sh login, log in, Cmd+Q, start.`);
      await ab("close").catch(() => {});
      process.exit(2);
    }
  } else {
    try {
      const { stdout } = await run(AB_LOGIN, ["open", IDENTITY, SESSION, LIST_URL], { env });
      console.error(stdout.trim());
    } catch (e) {
      if (e.code === 2) {
        console.error(`NEEDS_LOGIN: run \`ab-login handoff ${IDENTITY}\` first.`);
        process.exit(2);
      }
      throw e;
    }
  }

  const extract = await readFile(join(here, "extract.js"), "utf8");
  await mkdir(join(OUT, "dom"), { recursive: true });
  const byId = new Map();
  let idle = 0;
  let snaps = 0;
  const visibility = {};

  try {
    await ab("wait", 'article[data-testid="tweet"]', "--timeout", "20000");
    for (let round = 1; byId.size < MAX && idle < MAX_IDLE_ROUNDS; round++) {
      // Never keep scraping if the tab was navigated away (a click, a redirect): other pages would be mistaken for bookmarks.
      // X now serves bookmarks at /i/history (tabs "Bookmarks" | "Likes"); /i/bookmarks redirects there. Accept
      // either path, but only while the Bookmarks tab is the selected one.
      const st = await evalJs(
        '({ url: location.href, vis: document.visibilityState, focus: document.hasFocus(), tab: document.querySelector("[role=tab][aria-selected=true]")?.innerText?.trim() ?? null })',
      );
      const path = new URL(st.url).pathname;
      const onBookmarks = (path === "/i/bookmarks" || path === "/i/history") && (st.tab === null || /bookmark/i.test(st.tab));
      if (!onBookmarks) {
        throw new Error(`not on the bookmarks list (url ${st.url}, selected tab ${st.tab}) at round ${round}; stopping with ${byId.size} items`);
      }
      const vk = `${st.vis}/${st.focus ? "focused" : "unfocused"}`;
      visibility[vk] = (visibility[vk] ?? 0) + 1;
      const batch = await evalJs(extract);
      let fresh = 0;
      for (const it of batch) if (!byId.has(it.id)) (byId.set(it.id, { ...it, order: byId.size }), fresh++);
      idle = fresh ? 0 : idle + 1;
      console.error(`round ${round}: +${fresh} (total ${byId.size})`);

      if (snaps < SNAPSHOTS && round % 3 === 1) {
        const html = await evalJs('document.querySelector("[data-testid=primaryColumn]")?.outerHTML ?? ""');
        await writeFile(join(OUT, "dom", `bookmarks-${++snaps}.html`), html);
      }
      await evalJs("window.scrollBy(0, Math.round(innerHeight * (0.6 + Math.random() * 0.3)))");
      await pause();
    }
  } finally {
    await ab("close").catch(() => {});
  }

  const items = [...byId.values()].slice(0, MAX);
  await copyFile(join(OUT, "bookmarks.json"), join(OUT, "bookmarks.prev.json")).catch(() => {}); // keep the last run for comparison
  await writeFile(join(OUT, "bookmarks.json"), JSON.stringify(items, null, 2));
  report(items);
  console.log(`tab state per round (visibilityState/focus): ${JSON.stringify(visibility)}`);
}

function report(items) {
  const n = items.length || 1;
  const rate = (f) => `${((items.filter(f).length / n) * 100).toFixed(1)}%`;
  const fields = {
    id: (i) => i.id,
    url: (i) => i.url,
    "author.handle": (i) => i.author?.handle,
    "author.name": (i) => i.author?.name,
    time: (i) => i.time,
    text: (i) => i.text,
  };
  console.log(`\nitems: ${items.length}  → ${join(OUT, "bookmarks.json")}`);
  console.log("required fields (target ≥ 95%):");
  for (const [k, f] of Object.entries(fields)) console.log(`  ${k.padEnd(14)} ${rate(f)}`);
  console.log("shape:");
  console.log(`  with media     ${rate((i) => i.media.length)}`);
  console.log(`  with quote     ${rate((i) => i.quote)}`);
  console.log(`  with card      ${rate((i) => i.card)}`);
  console.log(`  truncated      ${rate((i) => i.truncated)}`);
  console.log(`  bookmarked     ${rate((i) => i.bookmarked)}  (rows carrying X's removeBookmark marker; anything below 100% is not a bookmark)`);
  console.log(`  empty text     ${rate((i) => !i.text)}  (media-only posts are expected here)`);
  const times = items.map((i) => i.time).filter(Boolean);
  const sortedDesc = times.every((t, k) => k === 0 || times[k - 1] >= t);
  console.log(`  publish times in descending order: ${sortedDesc} (bookmark order ≠ publish order is normal)`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
