import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { IdentityConfig } from "../../auth/index.js";
import { UpsertItemInput } from "../../db/index.js";
import { PageState, RawSocialItem, SocialSource } from "../framework.js";

const here = dirname(fileURLToPath(import.meta.url));

export interface XhsBookmarkRawItem extends RawSocialItem {
  id: string;
  dataIndex?: number | null;
  url: string;
  canonicalUrl?: string;
  title: string | null;
  text: string | null;
  author: {
    id: string | null;
    handle: string | null;
    name: string | null;
    avatar?: string | null;
    profileUrl?: string | null;
  };
  kind: "post" | "video";
  bookmarked: boolean;
  likes?: string | null;
  media: Array<{
    type: "photo" | "video";
    src: string;
    alt: string | null;
    width?: number | null;
    height?: number | null;
  }>;
}

function loadScript(filename: string): string {
  const candidates = [
    join(here, filename),
    join(here, "../../../src/sources/xhs", filename),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  throw new Error(`Could not find XHS script ${filename} in ${candidates.join(", ")}`);
}

export const XHS_EXTRACT_JS = loadScript("extract.js");
export const XHS_DETAIL_JS = loadScript("detail.js");

export const DEFAULT_XHS_USER_ID = process.env.XHS_USER_ID || "";

export function createXhsIdentity(
  account = "main",
  userId = DEFAULT_XHS_USER_ID,
): IdentityConfig {
  const listUrl = userId
    ? `https://www.xiaohongshu.com/user/profile/${userId}?tab=fav&subTab=note`
    : "https://www.xiaohongshu.com/explore";
  return {
    id: `xhs-prod-${account}`,
    mode: "external-chrome",
    checkUrl: listUrl,
    loginUrl: "https://www.xiaohongshu.com/explore",
    checkFn: "!!document.querySelector('section.note-item, .user-info')",
    cdpPort: Number(process.env.CHROME_DEBUG_PORT || 9333),
    notes: "Xiaohongshu (小红书) favorites via dedicated Chrome profile + CDP attach",
  };
}

export function validateXhsBookmarksPage(state: PageState): { ok: boolean; reason?: string } {
  try {
    const u = new URL(state.url);
    const validHost = u.hostname.endsWith("xiaohongshu.com");
    const validPath = u.pathname.startsWith("/user/profile/");
    if (!validHost || !validPath) {
      const hint =
        u.pathname === "/explore"
          ? " (set XHS_USER_ID or navigate to your profile favorites tab)"
          : "";
      return {
        ok: false,
        reason: `Not on Xiaohongshu user profile favorites page (url=${state.url})${hint}`,
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, reason: `Invalid URL: ${state.url}` };
  }
}

export function xhsItemToUpsertInput(
  rec: XhsBookmarkRawItem,
  index: number,
  baseTimeMs: number,
  account = "default",
): UpsertItemInput {
  const sourceItemId = String(rec.id);
  const name = rec.author?.name || "";
  const authorId = rec.author?.id || rec.author?.handle || "";
  const author = name || authorId || null;

  const excerptParts: string[] = [];
  if (rec.title) excerptParts.push(rec.title);
  if (rec.text && rec.text !== rec.title) excerptParts.push(rec.text);
  if (rec.likes) excerptParts.push(`[小红书点赞: ${rec.likes}]`);

  const coverUrl = rec.media?.[0]?.src || null;
  const canonicalUrl =
    rec.canonicalUrl || `https://www.xiaohongshu.com/explore/${sourceItemId}`;

  return {
    id: `xhs:${sourceItemId}`,
    source: "xhs",
    source_item_id: sourceItemId,
    account,
    url: rec.url || canonicalUrl,
    canonical_url: canonicalUrl,
    title: rec.title || null,
    excerpt: excerptParts.join("\n").trim() || null,
    author,
    cover_url: coverUrl,
    media_type: rec.kind || "post",
    publish_date: null,
    first_seen_at: new Date(baseTimeMs - index * 1000).toISOString(),
    raw: JSON.stringify(rec),
  };
}

export function createXhsSource(opts?: {
  id?: string;
  account?: string;
  userId?: string;
  identity?: IdentityConfig;
  extractOverride?: string;
}): SocialSource<XhsBookmarkRawItem> {
  const account = opts?.account || "default";
  const userId = opts?.userId || DEFAULT_XHS_USER_ID;
  const identity =
    opts?.identity ||
    createXhsIdentity(account === "default" ? "main" : account, userId);

  return {
    id: opts?.id || "xhs",
    account,
    adapter: "xhs",
    identity,
    listUrl: userId
      ? `https://www.xiaohongshu.com/user/profile/${userId}?tab=fav&subTab=note`
      : "https://www.xiaohongshu.com/explore",
    order: "newest-first",
    itemSelector: "section.note-item",
    extract: opts?.extractOverride ?? XHS_EXTRACT_JS,
    detailExtract: XHS_DETAIL_JS,
    validatePage: validateXhsBookmarksPage,
    scroll: {
      scrollJs:
        "window.scrollBy(0, Math.round(window.innerHeight * (0.85 + Math.random() * 0.35)))",
      pauseMs: [1200, 2500],
      maxIdleRounds: 8,
    },
    health: {
      requireNonEmptyOnFirstSync: true,
      minFieldsFilled: {
        id: {
          threshold: 1.0,
          check: (i) => Boolean(i.id && /^[0-9a-fA-F]{24}$/.test(String(i.id))),
        },
        url: {
          threshold: 1.0,
          check: (i) =>
            Boolean(i.url && i.url.startsWith("https://www.xiaohongshu.com/")),
        },
        "author.name": {
          threshold: 0.95,
          check: (i) => Boolean(i.author?.name),
        },
        bookmarked: {
          threshold: 1.0,
          check: (i) => i.bookmarked === true,
        },
        content: {
          // Every note must have a title or cover image
          threshold: 0.95,
          check: (i) =>
            Boolean(
              (i.title && i.title.trim()) ||
                (i.media && i.media.length > 0 && i.media[0]?.src),
            ),
        },
      },
    },
    toUpsertInput: (item, index, baseTimeMs) =>
      xhsItemToUpsertInput(item, index, baseTimeMs, account),
  };
}
