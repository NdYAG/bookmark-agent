import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AuthManager, BrowserSession, NeedsLoginError } from "../src/auth/index.js";
import { readItem } from "../src/content/index.js";
import { CollectionsDB } from "../src/db/index.js";
import { checkSourceHealth, syncSocialSource } from "../src/sources/framework.js";
import {
  createXSource,
  X_DETAIL_JS,
  X_EXTRACT_JS,
  XBookmarkRawItem,
} from "../src/sources/x/index.js";
import {
  createXhsSource,
  XHS_EXTRACT_JS,
  XhsBookmarkRawItem,
} from "../src/sources/xhs/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const datasetPath = join(repoRoot, "packages/eval/dataset/items.json");

function buildXBatchHtml(startIdx: number, count: number): string {
  const articles: string[] = [];
  for (let i = 0; i < count; i++) {
    const idx = startIdx + i;
    const id = `1000000000000001${String(idx).padStart(3, "0")}`;
    const handle = `synth_author_${idx}`;
    const iso = new Date(Date.UTC(2026, 10, 20, 12, 0, 0) - idx * 3600 * 1000).toISOString();
    articles.push(`
      <article data-testid="tweet">
        <div data-testid="User-Name">
          <span>Author ${idx}</span><span>@${handle}</span>
          <a href="/${handle}/status/${id}"><time datetime="${iso}">Nov 20</time></a>
        </div>
        <div data-testid="tweetText" lang="en">Synthetic engineering note #${idx}: WebGPU and Rust systems patterns.</div>
        <button data-testid="removeBookmark"></button>
      </article>
    `);
  }
  return `<div>${articles.join("\n")}</div>`;
}

function buildXhsBatchHtml(startIdx: number, count: number): string {
  const sections: string[] = [];
  for (let i = 0; i < count; i++) {
    const idx = startIdx + i;
    const noteId = `600000000000000000001${String(idx).padStart(3, "0")}`;
    const authorId = "a00000000000000000000001";
    sections.push(`
      <section class="note-item" data-note-id="${noteId}" data-index="${idx}" data-width="800" data-height="1000">
        <a class="cover" href="/explore/${noteId}">
          <img src="https://example.com/covers/${noteId}.jpg" />
        </a>
        <div class="footer">
          <a class="title"><span>合成收藏笔记 #${idx}：交互设计与效率工作流</span></a>
          <div class="author-wrapper">
            <a class="author" href="/user/profile/${authorId}?xsec_source=pc_collect">
              <span class="name">作者 ${idx}</span>
            </a>
          </div>
          <div class="like-wrapper"><span class="count">128</span></div>
        </div>
      </section>
    `);
  }
  return `<div class="tab-content-item"><div class="sub-tab-list"></div>${sections.join("\n")}</div>`;
}

/**
 * Evaluates an in-page extraction script (IIFE) against an HTML string using linkedom.
 */
function evalScriptOnHtml<T>(html: string, script: string): T {
  const { document, window } = parseHTML(`<!DOCTYPE html><html><body>${html}</body></html>`);
  const fn = new Function("document", "window", "Node", `return (\n${script}\n);`);
  return fn(document, window, { TEXT_NODE: 3 }) as T;
}

/**
 * Creates a mock BrowserSession backed by a list of virtual-scroll DOM batches.
 */
function createMockDomSession(opts: {
  batches: string[];
  url?: string;
  selectedTab?: string;
}): BrowserSession & { closed: boolean; scrollRounds: number } {
  let currentRound = 0;
  const pageUrl = opts.url ?? "https://x.com/i/history";
  const selectedTab = opts.selectedTab ?? "Bookmarks";

  const session = {
    sessionName: "mock-x-session",
    identityId: "x-prod-main",
    mode: "external-chrome" as const,
    closed: false,
    scrollRounds: 0,
    async waitSelector(_selector: string): Promise<void> {},
    async getUrl(): Promise<string> {
      return pageUrl;
    },
    async evalJs<T = unknown>(js: string): Promise<T> {
      if (js.includes("location.href") && js.includes("visibilityState")) {
        return {
          url: pageUrl,
          vis: "visible",
          focus: true,
          tab: selectedTab,
        } as unknown as T;
      }
      if (js.includes("window.scrollBy")) {
        session.scrollRounds++;
        currentRound = Math.min(currentRound + 1, opts.batches.length - 1);
        return undefined as unknown as T;
      }
      const html = opts.batches[currentRound] || "";
      return evalScriptOnHtml<T>(html, js);
    },
    async close(): Promise<void> {
      session.closed = true;
    },
  };
  return session;
}

describe("M1 · X Collection, SocialSource Framework, Auth & read_item", () => {
  let tempDir: string;
  let dbPath: string;
  let db: CollectionsDB;
  let auth: AuthManager;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "collections-mcp-m1-"));
    dbPath = join(tempDir, "collections.db");
    db = new CollectionsDB(dbPath);
    auth = new AuthManager({
      configPath: join(tempDir, "identities.json"),
      profileRoot: join(tempDir, "profiles"),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("extracts valid bookmarks from synthetic X DOM batches and passes health checks", () => {
    const xSource = createXSource();
    const batches = [buildXBatchHtml(0, 6), buildXBatchHtml(6, 6), buildXBatchHtml(12, 6)];
    const allExtracted: XBookmarkRawItem[] = [];

    for (const html of batches) {
      const batch = evalScriptOnHtml<XBookmarkRawItem[]>(html, X_EXTRACT_JS);
      expect(batch.length).toBeGreaterThan(0);

      const health = checkSourceHealth(xSource, batch);
      expect(health.healthy).toBe(true);
      expect(health.rates.id).toBe(1);
      expect(health.rates.url).toBe(1);
      expect(health.rates.bookmarked).toBe(1);
      expect(health.rates["author.handle"]).toBeGreaterThanOrEqual(0.95);
      expect(health.rates.time).toBeGreaterThanOrEqual(0.95);

      allExtracted.push(...batch);
    }

    expect(allExtracted.length).toBe(18);
  });

  it("performs initial full sync and then incremental sync that adds EXACTLY 3 new bookmarks and stops at cursor", async () => {
    const snap1 = buildXBatchHtml(0, 6);
    const snap2 = buildXBatchHtml(6, 6);
    const snap3 = buildXBatchHtml(12, 6);

    const xSource = createXSource();
    xSource.scroll.pauseMs = [1, 2];

    const session1 = createMockDomSession({ batches: [snap1, snap2, snap3] });
    const fullRes = await syncSocialSource({
      source: xSource,
      db,
      auth,
      customSession: session1,
    });

    expect(fullRes.hitCursor).toBe(false);
    expect(fullRes.inserted).toBe(18);
    expect(fullRes.newCursor).toBeTruthy();
    const initialCount = db.stats().total_active_items as number;
    expect(initialCount).toBe(18);

    const newThreeHtml = `
      <div>
        <article data-testid="tweet">
          <div data-testid="User-Name">
            <span>New Author 1</span><span>@new_author_1</span>
            <a href="/new_author_1/status/9990000000000000003"><time datetime="2026-11-23T03:00:00.000Z">Nov 23</time></a>
          </div>
          <div data-testid="tweetText" lang="zh">新增收藏第 3 条（最新）：Rust 异步运行时 Tokio 调度器深度剖析</div>
          <button data-testid="removeBookmark"></button>
        </article>
        <article data-testid="tweet">
          <div data-testid="User-Name">
            <span>New Author 2</span><span>@new_author_2</span>
            <a href="/new_author_2/status/9990000000000000002"><time datetime="2026-11-23T02:00:00.000Z">Nov 23</time></a>
          </div>
          <div data-testid="tweetText" lang="en">Newly bookmarked #2: WebGPU compute shaders in practice</div>
          <button data-testid="removeBookmark"></button>
        </article>
        <article data-testid="tweet">
          <div data-testid="User-Name">
            <span>New Author 3</span><span>@new_author_3</span>
            <a href="/new_author_3/status/9990000000000000001"><time datetime="2026-11-23T01:00:00.000Z">Nov 23</time></a>
          </div>
          <div data-testid="tweetText" lang="zh">新增收藏第 1 条：A2UI 生成式界面协议设计笔记</div>
          <button data-testid="removeBookmark"></button>
        </article>
        ${snap1}
      </div>
    `;

    const progressEvents: number[] = [];
    const session2 = createMockDomSession({ batches: [newThreeHtml, snap2, snap3] });
    const incRes = await syncSocialSource({
      source: xSource,
      db,
      auth,
      customSession: session2,
      onProgress: (p) => {
        progressEvents.push(p.fetched);
      },
    });

    expect(incRes.hitCursor).toBe(true);
    expect(incRes.fetchedCount).toBe(3);
    expect(incRes.inserted).toBe(3);
    expect(incRes.updated).toBe(0);
    expect(incRes.previousCursor).toBe(fullRes.newCursor);
    expect(incRes.newCursor).toBe("9990000000000000003");
    expect(incRes.changedIds).toEqual([
      "x:9990000000000000003",
      "x:9990000000000000002",
      "x:9990000000000000001",
    ]);
    expect(session2.scrollRounds).toBe(0);
    expect(progressEvents).toEqual([3]);
    expect(db.stats().total_active_items).toBe(initialCount + 3);
  });

  it("enforces login check: forget -> sync returns NEEDS_LOGIN -> login restored -> sync continues", async () => {
    const snap1 = buildXBatchHtml(0, 6);
    const xSource = createXSource();
    xSource.scroll.pauseMs = [1, 2];

    const forgetRes = await auth.forget(xSource.identity);
    expect(forgetRes.status).toBe("FORGOTTEN");

    const checkAfterForget = await auth.check(xSource.identity);
    expect(checkAfterForget.status).toBe("MISSING");

    let caughtError: NeedsLoginError | null = null;
    try {
      await syncSocialSource({
        source: xSource,
        db,
        auth,
      });
    } catch (err: any) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(NeedsLoginError);
    expect(caughtError?.code).toBe("NEEDS_LOGIN");
    expect(caughtError?.sourceId).toBe("x");
    expect(db.getSource("x")?.last_status).toBe("NEEDS_LOGIN");

    auth.markLoginCompleted(xSource.identity.id);
    const session = createMockDomSession({ batches: [snap1] });
    const resumed = await syncSocialSource({
      source: xSource,
      db,
      auth,
      customSession: session,
    });

    expect(resumed.inserted).toBe(6);
    expect(db.getSource("x")?.last_status).toBe("OK");
  });

  it("triggers HEALTH_CHECK_FAILED alarm when extract script is deliberately broken", async () => {
    const snap1 = buildXBatchHtml(0, 6);

    const brokenExtractJs = `(() => {
      return [...document.querySelectorAll('article[data-testid="tweet"]')].map((a, i) => ({
        id: String(1000 + i),
        url: "https://x.com/unknown/status/" + (1000 + i),
        author: { handle: null, name: null },
        time: null,
        text: "broken extraction",
        bookmarked: false,
        media: []
      }));
    })()`;

    const brokenSource = createXSource({ extractOverride: brokenExtractJs });
    brokenSource.scroll.pauseMs = [1, 2];
    const session = createMockDomSession({ batches: [snap1] });

    let healthErr: any = null;
    try {
      await syncSocialSource({
        source: brokenSource,
        db,
        auth,
        customSession: session,
      });
    } catch (err) {
      healthErr = err;
    }

    expect(healthErr).toBeTruthy();
    expect(healthErr.code).toBe("HEALTH_CHECK_FAILED");
    expect(healthErr.health.healthy).toBe(false);
    expect(healthErr.health.rates["author.handle"]).toBe(0);
    expect(healthErr.health.rates.bookmarked).toBe(0);
    expect(db.stats().total_active_items).toBe(0);
    expect(db.getSource("x")?.last_status).toContain("UNHEALTHY:");
  });

  it("extracts full tweet thread + expands short links + extracts Readability article body in read_item and caches to item_content", async () => {
    db.upsertItem({
      id: "x:1000000000000000201",
      source: "x",
      source_item_id: "1000000000000000201",
      account: "default",
      url: "https://x.com/frontend_eng/status/1000000000000000201",
      title: "Rebuilding Reactive Virtual Lists from Scratch",
      excerpt: "深入剖析虚拟滚动与状态解耦的前端技术长文… (truncated)",
      author: "@frontend_eng (Frontend Eng)",
      media_type: "post",
      publish_date: "2026-11-10T13:31:06.000Z",
      raw: JSON.stringify({
        id: "1000000000000000201",
        truncated: true,
        links: [{ href: "https://t.co/synthLink1", text: "engineering.example.com/virtual-list" }],
        enrichedCard: {
          summary: "前端架构重写与渲染流水线性能优化深度解析。",
          topics: ["前端架构", "性能优化"],
          imageCaptions: ["架构对比图：新旧 Web 渲染流水线的延迟差异"],
        },
      }),
    });

    const detailHtml = `
      <div>
        <article data-testid="tweet">
          <div data-testid="User-Name"><span>Frontend Eng</span><span>@frontend_eng</span></div>
          <a href="/frontend_eng/status/1000000000000000201"><time datetime="2026-11-10T13:31:06.000Z"></time></a>
          <div data-testid="tweetText">
            深入剖析虚拟滚动与状态解耦的前端技术文章，完整介绍了如何重写渲染流水线。
            <a href="https://t.co/synthLink1">https://engineering.example.com/virtual-list</a>
          </div>
        </article>
        <article data-testid="tweet">
          <div data-testid="User-Name"><span>Frontend Eng</span><span>@frontend_eng</span></div>
          <a href="/frontend_eng/status/1000000000000000202"><time datetime="2026-11-10T13:33:00.000Z"></time></a>
          <div data-testid="tweetText">线程补充第 2 条：其中最关键的改进是虚拟列表与状态树的解耦，首屏 TTI 降低了 45%。</div>
        </article>
        <article data-testid="tweet">
          <div data-testid="User-Name"><span>Other User</span><span>@someone_else</span></div>
          <a href="/someone_else/status/1000000000000000299"><time datetime="2026-11-10T14:00:00.000Z"></time></a>
          <div data-testid="tweetText">路人评论：确实很强！</div>
        </article>
      </div>
    `;

    const parsedDetail = evalScriptOnHtml<{
      thread: Array<{ text: string }>;
      links: Array<{ href: string }>;
    }>(detailHtml, X_DETAIL_JS);
    expect(parsedDetail.thread.length).toBe(2);
    expect(parsedDetail.thread[1].text).toContain("首屏 TTI 降低了 45%");

    const mockFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "https://t.co/synthLink1") {
        return new Response(
          `<html><head><title>https://engineering.example.com/virtual-list</title></head></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
      }
      if (url === "https://engineering.example.com/virtual-list") {
        const resp = new Response(
          `<!DOCTYPE html><html><head><title>Rebuilding Virtual Lists</title></head>
           <body><article><h1>Rebuilding Virtual Lists</h1>
           <p>By Frontend Engineering Team</p>
           <p>Over the past year, we rebuilt our web client architecture from the ground up to achieve sub-second interactive rendering and modular state management.</p>
           <p>We replaced legacy coupled reducers with fine-grained reactive stores and a zero-allocation virtual scroller.</p>
           </article></body></html>`,
          { status: 200, headers: { "content-type": "text/html" } },
        );
        Object.defineProperty(resp, "url", { value: url });
        return resp;
      }
      return new Response("Not found", { status: 404 });
    }) as typeof fetch;

    const detailSession = createMockDomSession({ batches: [detailHtml] });
    const firstRead = await readItem(db, auth, "x:1000000000000000201", {
      customSession: detailSession,
      customFetch: mockFetch,
    });

    expect(firstRead.cached).toBe(false);
    expect(firstRead.content).toContain("推文正文与作者线程 (共 2 条)");
    expect(firstRead.content).toContain("首屏 TTI 降低了 45%");
    expect(firstRead.content).not.toContain("路人评论");
    expect(firstRead.content).toContain("架构对比图：新旧 Web 渲染流水线的延迟差异");
    expect(firstRead.content).toContain("Rebuilding Virtual Lists");
    expect(firstRead.content).toContain("zero-allocation virtual scroller");
    expect(firstRead.expanded_links?.[0]?.expanded).toBe(
      "https://engineering.example.com/virtual-list",
    );

    const secondRead = await readItem(db, auth, "x:1000000000000000201");
    expect(secondRead.cached).toBe(true);
    expect(secondRead.content).toBe(firstRead.content);
  });

  it("exposes M1 tools (read_item, app_sources, app_login_forget, app_sync NEEDS_LOGIN) over MCP stdio", async () => {
    db.close();
    const serverEntryPath = join(here, "../dist/server.js");
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [serverEntryPath],
      env: {
        ...process.env,
        COLLECTIONS_DB_PATH: dbPath,
        COLLECTIONS_SEED_PATH: datasetPath,
      },
    });

    const client = new Client(
      { name: "m1-verifier", version: "0.2.0" },
      { capabilities: {} },
    );
    await client.connect(transport);

    try {
      const sourcesRes = await client.callTool({ name: "app_sources", arguments: {} });
      const sourcesData = JSON.parse((sourcesRes.content as Array<{ text: string }>)[0].text);
      expect(sourcesData.sources.some((s: any) => s.id === "x")).toBe(true);

      const readRes = await client.callTool({
        name: "read_item",
        arguments: { id: "x:1000000000000000028", expandExternalLinks: false },
      });
      const readData = JSON.parse((readRes.content as Array<{ text: string }>)[0].text);
      expect(readData.id).toBe("x:1000000000000000028");
      expect(readData.content).toContain("克服拖延");

      const forgetRes = await client.callTool({
        name: "app_login_forget",
        arguments: { sourceId: "x" },
      });
      const forgetData = JSON.parse((forgetRes.content as Array<{ text: string }>)[0].text);
      expect(forgetData.status).toBe("FORGOTTEN");

      const syncRes = await client.callTool({
        name: "app_sync",
        arguments: { sourceId: "x" },
      });
      expect(syncRes.isError).toBe(true);
      const syncErr = JSON.parse((syncRes.content as Array<{ text: string }>)[0].text);
      expect(syncErr.code).toBe("NEEDS_LOGIN");
      expect(syncErr.sourceId).toBe("x");
    } finally {
      await client.close();
      db = new CollectionsDB(dbPath);
    }
  });

  it("extracts valid Xiaohongshu bookmarks from synthetic XHS DOM batches and passes health checks & incremental sync", async () => {
    const xhsSource = createXhsSource({ userId: "000000000000000000000001" });
    xhsSource.scroll.pauseMs = [1, 2];

    const html1 = buildXhsBatchHtml(0, 15);
    const html2 = buildXhsBatchHtml(15, 10);

    const batch1 = evalScriptOnHtml<XhsBookmarkRawItem[]>(html1, XHS_EXTRACT_JS);
    expect(batch1.length).toBe(15);

    const health = checkSourceHealth(xhsSource, batch1);
    expect(health.healthy).toBe(true);
    expect(health.rates.id).toBe(1);
    expect(health.rates.url).toBe(1);
    expect(health.rates["author.name"]).toBe(1);
    expect(health.rates.bookmarked).toBe(1);
    expect(health.rates.content).toBe(1);

    const session1 = createMockDomSession({
      batches: [html1, html2],
      url: "https://www.xiaohongshu.com/user/profile/000000000000000000000001?tab=fav&subTab=note",
    });

    const syncRes = await syncSocialSource({
      source: xhsSource,
      db,
      auth,
      customSession: session1,
    });

    expect(syncRes.inserted).toBe(25);
    expect(syncRes.newCursor).toBe(batch1[0].id);
    expect(db.getSource("xhs")?.last_status).toBe("OK");
  });
});
