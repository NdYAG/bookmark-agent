#!/usr/bin/env node
// S2 spike for Xiaohongshu: scroll user profile favorites (?tab=fav&subTab=note) as identity xhs-prod-main
// and save what extract.js finds.
//
//   XHS_USER_ID=<your-user-id> node spikes/xhs-bookmarks/scrape.mjs [--user-id <id>] [--max 100] [--snapshots 2] [--out fixtures/xhs] [--cdp 9333]
//
// Reads only rendered page content; never cookies, storage, or network headers.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const IDENTITY = "xhs-prod-main";
const SESSION = `s2-${IDENTITY}`;

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .reduce((acc, a, i, all) => (a.startsWith("--") ? [...acc, [a.slice(2), all[i + 1]]] : acc), []),
);
const USER_ID = args["user-id"] || process.env.XHS_USER_ID || "";
const LIST_URL =
  process.env.XHS_FAV_URL ||
  (USER_ID ? `https://www.xiaohongshu.com/user/profile/${USER_ID}?tab=fav&subTab=note` : "");
if (!LIST_URL) {
  console.error("Missing XHS user id: pass --user-id <id> or set XHS_USER_ID / XHS_FAV_URL.");
  process.exit(1);
}
const MAX = Number(args.max ?? 100);
const SNAPSHOTS = Number(args.snapshots ?? 2);
const OUT = args.out ?? join(here, "../../fixtures/xhs");
const MAX_IDLE_ROUNDS = Number(args.maxIdle ?? 8);
const RESUME = args.resume === "true" || process.argv.includes("--resume");
const CDP = args.cdp ?? "9333";
const BASE = ["--session", SESSION, ...(CDP ? ["--cdp", String(CDP), "--pin-tab"] : [])];

const ab = async (...a) =>
  (await run("agent-browser", [...BASE, ...a], { env: process.env, maxBuffer: 64 << 20 })).stdout;

const evalJs = async (js) => {
  const child = execFile("agent-browser", [...BASE, "--json", "eval", "--stdin"], {
    env: process.env,
    maxBuffer: 64 << 20,
  });
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
const pause = () => sleep(2300 + Math.random() * 1900);

async function ensureOnFavoritesTab() {
  // Check if current page is already on the user's favorites tab; only reload if not
  const curUrl = (await ab("get", "url").catch(() => "")).trim();
  const onProfile = USER_ID ? curUrl.includes(`/user/profile/${USER_ID}`) : curUrl.includes("/user/profile/");
  if (!onProfile || !curUrl.includes("tab=fav")) {
    await ab("tab", "new", LIST_URL);
    await ab("wait", "--load", "domcontentloaded").catch(() => {});
    await sleep(3000);
  } else if (!RESUME) {
    // Scroll back to top so we start from index 0 cleanly unless --resume is passed
    await evalJs("window.scrollTo(0, 0)");
    await sleep(1500);
  }

  // Ensure "收藏" tab is clicked & active
  const tabState = await evalJs(`(() => {
    const activeTexts = [...document.querySelectorAll(".reds-tab-item.active")].map(e => e.innerText?.trim());
    if (!activeTexts.some(t => t === "收藏")) {
      const favTab = [...document.querySelectorAll(".reds-tab-item")].find(e => e.innerText?.trim() === "收藏");
      favTab?.click();
    }
    const totalBadge = [...document.querySelectorAll(".sub-tab-list .reds-tab-item")]
      .map(e => e.innerText?.trim())
      .find(t => t && t.startsWith("笔记"));
    const loginModal = !!document.querySelector(".login-container, .login-modal");
    return { url: location.href, activeTexts, totalBadge, loginModal };
  })()`);

  if (tabState.loginModal && !tabState.totalBadge) {
    console.error(`NEEDS_LOGIN on Xiaohongshu (${tabState.url}).`);
    process.exit(2);
  }
  await sleep(1000);
  return tabState;
}

async function main() {
  const tabInfo = await ensureOnFavoritesTab();
  console.error(`Connected to Xiaohongshu favorites: ${JSON.stringify(tabInfo)}`);

  const extract = await readFile(join(here, "extract.js"), "utf8");
  await mkdir(join(OUT, "dom"), { recursive: true });

  const byId = new Map();
  const outPath = join(OUT, "bookmarks.json");
  if (RESUME && existsSync(outPath)) {
    try {
      const existing = JSON.parse(await readFile(outPath, "utf8"));
      for (const it of existing) {
        if (it?.id) byId.set(it.id, it);
      }
      console.error(`Resuming from existing bookmarks.json with ${byId.size} items already collected!`);
    } catch {}
  }

  let idle = 0;
  let snaps = 0;
  const visibility = {};

  try {
    await ab("wait", "section.note-item", "--timeout", "20000");

    for (let round = 1; byId.size < MAX && idle < MAX_IDLE_ROUNDS; round++) {
      const st = await evalJs(`({
        url: location.href,
        vis: document.visibilityState,
        focus: document.hasFocus(),
        activeTabs: [...document.querySelectorAll(".reds-tab-item.active")].map(e => e.innerText?.trim()),
        endText: document.body.innerText.includes("THE END") || document.body.innerText.includes("没有更多了"),
        captcha: document.body.innerText.includes("Security Verification") || document.body.innerText.includes("拖动箭头完成拼图") || !!document.querySelector(".red-captcha-modal")
      })`);

      if (st.captcha) {
        const itemsNow = [...byId.values()];
        await writeFile(join(OUT, "bookmarks.json"), JSON.stringify(itemsNow, null, 2));
        console.error(
          `\n[CAPTCHA_REQUIRED] Xiaohongshu triggered a slider verification ("Security Verification / 拖动箭头完成拼图") at ${byId.size} items (round ${round}).\n` +
            `Saved all ${byId.size} items collected so far to ${join(OUT, "bookmarks.json")}.\n` +
            `Please complete the slider puzzle in the open Chrome window, then re-run with --resume.`,
        );
        process.exit(4);
      }

      if (!st.url.includes("/user/profile/") || !st.activeTabs.includes("收藏")) {
        throw new Error(
          `Not on Xiaohongshu Favorites tab (url=${st.url}, activeTabs=${JSON.stringify(st.activeTabs)}) at round ${round}; stopping with ${byId.size} items`,
        );
      }

      const vk = `${st.vis}/${st.focus ? "focused" : "unfocused"}`;
      visibility[vk] = (visibility[vk] ?? 0) + 1;

      const batch = await evalJs(extract);
      let fresh = 0;
      for (const it of batch) {
        if (!byId.has(it.id)) {
          byId.set(it.id, { ...it, order: byId.size });
          fresh++;
        } else {
          // If an existing item had no cover image loaded yet (lazy loading), update its media
          const prev = byId.get(it.id);
          if ((!prev.media?.length || !prev.media[0]?.src) && it.media?.[0]?.src) {
            prev.media = it.media;
          }
        }
      }

      idle = fresh ? 0 : idle + 1;
      console.error(
        `round ${round}: +${fresh} (total ${byId.size}/${MAX}, domBatch=${batch.length}, idle=${idle})`,
      );

      if (snaps < SNAPSHOTS && round % 4 === 1) {
        const html = await evalJs(`(() => {
          const tabContents = [...document.querySelectorAll(".tab-content-item")];
          const fav = tabContents.find(el => el.querySelector(".sub-tab-list")) || tabContents[1];
          return fav?.outerHTML ?? "";
        })()`);
        if (html) {
          await writeFile(join(OUT, "dom", `bookmarks-${++snaps}.html`), html);
        }
      }

      // Periodically checkpoint to disk every 20 rounds during large scrapes
      if (round % 20 === 0) {
        const partial = [...byId.values()];
        await writeFile(join(OUT, "bookmarks.partial.json"), JSON.stringify(partial, null, 2));
      }

      if (byId.size >= MAX || idle >= MAX_IDLE_ROUNDS) break;

      // Scroll down smoothly to trigger waterfall next page load.
      // If idle > 0 (network lag or virtual scroll threshold not crossed), scroll up 1200px then down to bottom.
      if (idle > 0) {
        await evalJs("window.scrollBy(0, -1200)");
        await sleep(800);
        await evalJs("window.scrollTo(0, document.documentElement.scrollHeight)");
        await sleep(2500 + idle * 500);
      } else {
        await evalJs(
          "window.scrollBy(0, Math.round(window.innerHeight * (0.8 + Math.random() * 0.3)))",
        );
        await pause();
      }
    }
  } finally {
    // Keep tab alive for subsequent commands or close session handle
  }

  const items = [...byId.values()].slice(0, MAX);
  await copyFile(outPath, join(OUT, "bookmarks.prev.json")).catch(() => {});
  await writeFile(outPath, JSON.stringify(items, null, 2));
  report(items, outPath);
  console.log(`tab state per round (visibilityState/focus): ${JSON.stringify(visibility)}`);
}

function report(items, outPath) {
  const n = items.length || 1;
  const rate = (f) => `${((items.filter(f).length / n) * 100).toFixed(1)}%`;
  const fields = {
    id: (i) => i.id && /^[0-9a-fA-F]{24}$/.test(i.id),
    url: (i) => i.url && i.url.startsWith("https://www.xiaohongshu.com/"),
    "author.name": (i) => i.author?.name,
    "author.id": (i) => i.author?.id,
    title: (i) => i.title && i.title.trim().length > 0,
    "media.cover": (i) => i.media?.length > 0 && Boolean(i.media[0]?.src),
    bookmarked: (i) => i.bookmarked === true,
  };
  console.log(`\nitems: ${items.length}  → ${outPath}`);
  console.log("required fields (target ≥ 95%):");
  for (const [k, f] of Object.entries(fields)) {
    console.log(`  ${k.padEnd(14)} ${rate(f)}`);
  }
  console.log("shape:");
  console.log(`  photo notes    ${rate((i) => i.kind === "post")}`);
  console.log(`  video notes    ${rate((i) => i.kind === "video")}`);
  console.log(`  empty title    ${rate((i) => !i.title)}  (titleless image/video notes)`);
}

main().catch((e) => {
  console.error(e.message ?? e);
  process.exit(1);
});
