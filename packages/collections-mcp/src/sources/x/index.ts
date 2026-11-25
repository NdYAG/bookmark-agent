import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IdentityConfig } from "../../auth/index.js";
import { UpsertItemInput } from "../../db/index.js";
import { PageState, RawSocialItem, SocialSource } from "../framework.js";

const here = dirname(fileURLToPath(import.meta.url));

export interface XBookmarkRawItem extends RawSocialItem {
  id: string;
  url: string;
  author: {
    handle: string | null;
    name: string | null;
  };
  time: string | null;
  text: string | null;
  lang: string | null;
  truncated: boolean;
  bookmarked: boolean;
  rawText?: string;
  kind: "post" | "article";
  articleText?: string | null;
  articleCover?: string | null;
  links: Array<{ href: string; text: string | null }>;
  media: Array<{ type: "photo" | "video" | "gif"; src: string; alt: string | null }>;
  quote: {
    author: { name: string | null; handle: string | null };
    time: string | null;
    text: string | null;
    media: Array<{ type: "photo" | "video" | "gif"; src: string; alt: string | null }>;
  } | null;
  card: {
    href: string | null;
    text: string | null;
  } | null;
}

function loadScript(filename: string): string {
  const candidates = [
    join(here, filename),
    join(here, "../../../src/sources/x", filename),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  throw new Error(`Could not find X script ${filename} in ${candidates.join(", ")}`);
}

export const X_EXTRACT_JS = loadScript("extract.js");
export const X_DETAIL_JS = loadScript("detail.js");

export function createXIdentity(account = "main"): IdentityConfig {
  return {
    id: `x-prod-${account}`,
    mode: "external-chrome",
    checkUrl: "https://x.com/i/bookmarks",
    loginUrl: "https://x.com/i/flow/login",
    checkFn: "!!document.querySelector('[data-testid=\"AppTabBar_Home_Link\"], [data-testid=\"SideNav_AccountSwitcher_Button\"]')",
    cdpPort: Number(process.env.CHROME_DEBUG_PORT || 9333),
    notes: "X (Twitter) bookmarks via dedicated Chrome profile + CDP attach",
  };
}

export function validateXBookmarksPage(state: PageState): { ok: boolean; reason?: string } {
  try {
    const u = new URL(state.url);
    const validPath = u.pathname === "/i/bookmarks" || u.pathname === "/i/history";
    const validTab = state.tab === null || /bookmark/i.test(state.tab);
    if (!validPath || !validTab) {
      return {
        ok: false,
        reason: `Not on X Bookmarks tab (url=${state.url}, selectedTab=${state.tab})`,
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: `Invalid URL: ${state.url}` };
  }
}

export function xItemToUpsertInput(
  rec: XBookmarkRawItem,
  index: number,
  baseTimeMs: number,
  account = "default",
): UpsertItemInput {
  const sourceItemId = String(rec.id);
  const handle = rec.author?.handle || "";
  const name = rec.author?.name || "";
  const author =
    handle && name ? `@${handle} (${name})` : handle ? `@${handle}` : name || null;

  const excerptParts: string[] = [];
  if (rec.text) excerptParts.push(rec.text);
  if (rec.articleText) excerptParts.push(rec.articleText);
  if (rec.quote?.text) {
    const qHandle = rec.quote.author?.handle ? `@${rec.quote.author.handle}: ` : "";
    excerptParts.push(`[引用 ${qHandle}${rec.quote.text}]`);
  }
  if (rec.card?.text) {
    excerptParts.push(`[链接卡片: ${rec.card.text}]`);
  }

  const coverUrl =
    rec.articleCover ||
    rec.media?.[0]?.src ||
    rec.quote?.media?.[0]?.src ||
    null;

  return {
    id: `x:${sourceItemId}`,
    source: "x",
    source_item_id: sourceItemId,
    account,
    url: rec.url || `https://x.com/i/status/${sourceItemId}`,
    title: rec.card?.text || null,
    excerpt: excerptParts.join("\n").trim() || null,
    author,
    cover_url: coverUrl,
    media_type: rec.kind || "post",
    publish_date: rec.time || null,
    first_seen_at: new Date(baseTimeMs - index * 1000).toISOString(),
    raw: JSON.stringify(rec),
  };
}

export function createXSource(opts?: {
  id?: string;
  account?: string;
  identity?: IdentityConfig;
  extractOverride?: string;
}): SocialSource<XBookmarkRawItem> {
  const account = opts?.account || "default";
  const identity = opts?.identity || createXIdentity(account === "default" ? "main" : account);

  return {
    id: opts?.id || "x",
    account,
    adapter: "x",
    identity,
    listUrl: "https://x.com/i/bookmarks",
    order: "newest-first",
    itemSelector: 'article[data-testid="tweet"]',
    extract: opts?.extractOverride ?? X_EXTRACT_JS,
    detailExtract: X_DETAIL_JS,
    validatePage: validateXBookmarksPage,
    scroll: {
      scrollJs: "window.scrollBy(0, Math.round(innerHeight * (0.6 + Math.random() * 0.3)))",
      pauseMs: [1500, 3500],
      maxIdleRounds: 4,
    },
    health: {
      requireNonEmptyOnFirstSync: true,
      minFieldsFilled: {
        id: { threshold: 1.0, check: (i) => Boolean(i.id && /^\d+$/.test(String(i.id))) },
        url: { threshold: 1.0, check: (i) => Boolean(i.url && i.url.startsWith("https://x.com/")) },
        "author.handle": { threshold: 0.95, check: (i) => Boolean(i.author?.handle) },
        time: { threshold: 0.95, check: (i) => Boolean(i.time) },
        bookmarked: { threshold: 1.0, check: (i) => i.bookmarked === true },
        content: {
          // Every post must have at least one of: text, articleText, media, quote, or link card
          threshold: 0.95,
          check: (i) =>
            Boolean(
              (i.text && i.text.trim()) ||
                (i.articleText && i.articleText.trim()) ||
                (i.media && i.media.length > 0) ||
                i.quote ||
                i.card,
            ),
        },
      },
    },
    toUpsertInput: (item, index, baseTimeMs) =>
      xItemToUpsertInput(item, index, baseTimeMs, account),
  };
}
