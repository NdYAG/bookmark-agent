import { Readability } from "@mozilla/readability";
import { parseHTML } from "linkedom";
import { AuthManager, BrowserSession } from "../auth/index.js";
import { CollectionsDB } from "../db/index.js";
import { createXSource, X_DETAIL_JS } from "../sources/x/index.js";
import { createXhsSource, XHS_DETAIL_JS } from "../sources/xhs/index.js";

export interface ReadItemOptions {
  forceRefresh?: boolean;
  expandExternalLinks?: boolean;
  useBrowserForTweetDetail?: boolean;
  customSession?: BrowserSession;
  customFetch?: typeof fetch;
}

export interface ReadItemResult {
  id: string;
  url: string;
  source: string;
  cached: boolean;
  status: string;
  fetched_at: string;
  content: string;
  expanded_links?: Array<{ original: string; expanded: string; article_title?: string; article_text?: string }>;
}

/**
 * Expands a shortlink (e.g., https://t.co/...) by following HTTP redirects or parsing HTML meta/title redirect.
 */
export async function expandShortUrl(
  shortUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<string> {
  try {
    const res = await fetchFn(shortUrl, {
      method: "GET",
      redirect: "follow",
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(6000),
    });
    if (res.url && res.url !== shortUrl) {
      return res.url;
    }
    const html = (await res.text()).slice(0, 8192);
    // X's t.co pages use <noscript><META http-equiv="refresh" content="0;URL=https://..."></noscript> or <title>https://...</title>
    const metaMatch = /content=["']\d+;\s*URL=([^"']+)["']/i.exec(html);
    if (metaMatch?.[1]) return metaMatch[1];
    const titleMatch = /<title[^>]*>(https?:\/\/[^<\s]+)<\/title>/i.exec(html);
    if (titleMatch?.[1]) return titleMatch[1];
    return shortUrl;
  } catch {
    return shortUrl;
  }
}

/**
 * Extracts clean article readable text from raw HTML using linkedom + @mozilla/readability.
 */
export function extractReadableArticleFromHtml(
  html: string,
  url = "https://example.com",
): { title: string | null; textContent: string | null; excerpt: string | null; byline: string | null } {
  try {
    const { document } = parseHTML(html);
    const reader = new Readability(document as any);
    const parsed = reader.parse();
    if (!parsed) {
      return { title: document.title || null, textContent: null, excerpt: null, byline: null };
    }
    return {
      title: parsed.title || null,
      textContent: parsed.textContent?.trim() || null,
      excerpt: parsed.excerpt?.trim() || null,
      byline: parsed.byline?.trim() || null,
    };
  } catch {
    return { title: null, textContent: null, excerpt: null, byline: null };
  }
}

/**
 * Fetches a web page URL and extracts its readable body via @mozilla/readability.
 */
export async function fetchAndExtractWebArticle(
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ url: string; title: string | null; textContent: string | null }> {
  const expandedUrl = /^https?:\/\/t\.co\//i.test(url)
    ? await expandShortUrl(url, fetchFn)
    : url;

  // Skip fetching x.com status links as web articles
  if (/^https?:\/\/(x|twitter)\.com\/[^/]+\/status\/\d+/i.test(expandedUrl)) {
    return { url: expandedUrl, title: null, textContent: null };
  }

  try {
    const res = await fetchFn(expandedUrl, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) {
      return { url: expandedUrl, title: null, textContent: null };
    }
    const contentType = res.headers.get("content-type") || "";
    if (!contentType.includes("html") && !contentType.includes("xml") && contentType !== "") {
      return { url: expandedUrl, title: null, textContent: null };
    }
    const html = await res.text();
    const extracted = extractReadableArticleFromHtml(html, res.url || expandedUrl);
    return {
      url: res.url || expandedUrl,
      title: extracted.title,
      textContent: extracted.textContent ? extracted.textContent.slice(0, 8000) : null,
    };
  } catch {
    return { url: expandedUrl, title: null, textContent: null };
  }
}

/**
 * M1 `read_item` implementation:
 * 1. Checks `item_content` cache first (unless `forceRefresh` is true).
 * 2. Assembles full text from the item's stored data (author, text, articleText, quote, enriched summary & imageCaptions).
 * 3. If the item is truncated (or `useBrowserForTweetDetail` is requested / `customSession` is provided),
 *    evaluates `X_DETAIL_JS` on the tweet detail page to pull the untruncated tweet + author thread.
 * 4. Expands `t.co` shortlinks and extracts linked article text via `@mozilla/readability` + `linkedom`.
 * 5. Caches the result in `item_content(item_id, text, fetched_at, status)`.
 */
export async function readItem(
  db: CollectionsDB,
  auth: AuthManager,
  rawId: string,
  opts: ReadItemOptions = {},
): Promise<ReadItemResult> {
  const fetchFn = opts.customFetch || fetch;
  const items = db.getItems([rawId]);
  if (!items.length) {
    throw new Error(`Item not found: ${rawId}`);
  }
  const item = items[0] as Record<string, any>;
  const itemId = String(item.id);

  if (!opts.forceRefresh) {
    const cached = db.getItemContent(itemId);
    if (cached && cached.text && cached.status === "ok") {
      return {
        id: itemId,
        url: String(item.url),
        source: String(item.source),
        cached: true,
        status: cached.status,
        fetched_at: cached.fetched_at,
        content: cached.text,
      };
    }
  }

  const sections: string[] = [];
  sections.push(`# ${item.title || item.author || item.id}`);
  sections.push(`- URL: ${item.url}`);
  if (item.author) sections.push(`- 作者: ${item.author}`);
  if (item.publish_date) sections.push(`- 发布时间: ${item.publish_date}`);
  if (item.note) sections.push(`- 用户备注: ${item.note}`);

  // Check if we should fetch live tweet detail & thread from X via browser session
  let threadFetched = false;
  const linksToExpand: string[] = [];

  if (item.source === "x" && (opts.customSession || opts.useBrowserForTweetDetail)) {
    const xSource = createXSource();
    let session: BrowserSession | null = null;
    try {
      session =
        opts.customSession ??
        (await auth.openSession(xSource.identity, `detail-${itemId.replace(":", "-")}`, String(item.url)));
      await session.waitSelector('article[data-testid="tweet"]', 15000).catch(() => {});
      const detail = await session.evalJs<{
        mainPost: { text: string | null; quoteText: string | null } | null;
        thread: Array<{ id: string | null; text: string | null; quoteText: string | null }>;
        links: Array<{ href: string; text: string | null }>;
      }>(X_DETAIL_JS);

      if (detail?.thread?.length) {
        threadFetched = true;
        sections.push(
          `\n## 推文正文与作者线程 (共 ${detail.thread.length} 条)\n` +
            detail.thread
              .map((p, idx) => {
                const body = p.text || "(无文字)";
                const quote = p.quoteText ? `\n  > [引用]: ${p.quoteText}` : "";
                return `${idx + 1}. ${body}${quote}`;
              })
              .join("\n\n"),
        );
        for (const l of detail.links || []) {
          if (l.href) linksToExpand.push(l.href);
        }
      }
    } catch {
      // Fall back to stored excerpt + link expansion if browser detail fetch is unavailable
    } finally {
      if (session) await session.close().catch(() => {});
    }
  } else if (item.source === "xhs" && (opts.customSession || opts.useBrowserForTweetDetail)) {
    const xhsSource = createXhsSource();
    let session: BrowserSession | null = null;
    try {
      session =
        opts.customSession ??
        (await auth.openSession(
          xhsSource.identity,
          `detail-${itemId.replace(":", "-")}`,
          String(item.url),
        ));
      await session.waitSelector("#detail-desc, .note-content", 15000).catch(() => {});
      const detail = await session.evalJs<{
        mainPost: {
          title: string | null;
          text: string | null;
          desc: string | null;
          dateText: string | null;
          tags: string[];
        } | null;
      }>(XHS_DETAIL_JS);
      if (detail?.mainPost?.text) {
        threadFetched = true;
        sections.push(`\n## 小红书笔记正文\n${detail.mainPost.text}`);
        if (detail.mainPost.tags?.length) {
          sections.push(`\n- 标签: ${detail.mainPost.tags.join(" ")}`);
        }
      }
    } catch {
      // Fall back to stored excerpt
    } finally {
      if (session) await session.close().catch(() => {});
    }
  }

  if (!threadFetched && item.excerpt) {
    sections.push(`\n## 收藏正文与卡片摘要\n${item.excerpt}`);
  }

  if (item.enriched_card) {
    const card = item.enriched_card as Record<string, any>;
    if (Array.isArray(card.imageCaptions) && card.imageCaptions.length > 0) {
      sections.push(`\n## 配图内容详情\n` + card.imageCaptions.map((c: string, i: number) => `${i + 1}. ${c}`).join("\n"));
    }
  }

  // Collect external links from item.links, item.url (for manual items), or card
  if (item.source === "manual" && item.url) {
    linksToExpand.push(String(item.url));
  }
  if (Array.isArray(item.links)) {
    for (const l of item.links) {
      if (l?.href) linksToExpand.push(String(l.href));
    }
  }

  const uniqueLinks = Array.from(new Set(linksToExpand)).slice(0, 3);
  const expandedLinks: ReadItemResult["expanded_links"] = [];

  if (opts.expandExternalLinks !== false && uniqueLinks.length > 0) {
    for (const rawHref of uniqueLinks) {
      const article = await fetchAndExtractWebArticle(rawHref, fetchFn);
      expandedLinks.push({
        original: rawHref,
        expanded: article.url,
        article_title: article.title ?? undefined,
        article_text: article.textContent ?? undefined,
      });
      if (article.textContent) {
        sections.push(
          `\n## 外链文章正文: ${article.title || article.url}\n- 原始链接: ${rawHref}\n- 展开地址: ${article.url}\n\n${article.textContent}`,
        );
      } else if (article.url !== rawHref) {
        sections.push(`\n## 展开链接\n- ${rawHref} -> ${article.url}`);
      }
    }
  }

  const fullText = sections.join("\n").trim();
  const fetchedAt = new Date().toISOString();
  const status = "ok";

  db.upsertItemContent({
    item_id: itemId,
    text: fullText,
    fetched_at: fetchedAt,
    status,
  });

  return {
    id: itemId,
    url: String(item.url),
    source: String(item.source),
    cached: false,
    status,
    fetched_at: fetchedAt,
    content: fullText,
    expanded_links: expandedLinks.length > 0 ? expandedLinks : undefined,
  };
}
