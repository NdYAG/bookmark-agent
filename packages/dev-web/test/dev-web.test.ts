import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  A1_CONVERSATION_SCENARIOS,
  createScriptedLlmProvider,
} from "@bookmark-agent/agent-core";
import { createDevWebServer } from "../src/server.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const mcpServerEntry = join(repoRoot, "packages/collections-mcp/dist/server.js");
const datasetPath = join(repoRoot, "packages/eval/dataset/items.json");

async function invokeHandler(
  app: Awaited<ReturnType<typeof createDevWebServer>>,
  opts: { method: string; url: string; body?: unknown },
): Promise<{ status: number; headers: Record<string, string>; text: string }> {
  const bodyBuf = opts.body ? Buffer.from(JSON.stringify(opts.body), "utf8") : null;
  const reqStream = Readable.from(bodyBuf ? [bodyBuf] : []) as any;
  reqStream.method = opts.method;
  reqStream.url = opts.url;
  reqStream.headers = { "content-type": "application/json" };

  return new Promise((resolve) => {
    let status = 200;
    let headers: Record<string, string> = {};
    const chunks: string[] = [];

    const resMock: any = {
      writeHead(s: number, h?: Record<string, string>) {
        status = s;
        if (h) {
          for (const [k, v] of Object.entries(h)) {
            headers[k.toLowerCase()] = v;
          }
        }
      },
      write(chunk: string | Buffer) {
        chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
      },
      end(chunk?: string | Buffer) {
        if (chunk) {
          chunks.push(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
        }
        resolve({ status, headers, text: chunks.join("") });
      },
    };

    app.handleRequest(reqStream, resMock);
  });
}

describe("dev-web Verification Server (Multi-Source Social Grid + SSE A2UI Chat)", () => {
  let tempDir: string;
  let app: Awaited<ReturnType<typeof createDevWebServer>>;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "dev-web-multi-"));
    const scriptedLlm = createScriptedLlmProvider(
      A1_CONVERSATION_SCENARIOS[0].scriptedTurns,
    );
    app = await createDevWebServer({
      port: 0,
      mcpServerScriptPath: mcpServerEntry,
      collectionsDbPath: join(tempDir, "collections.db"),
      appDbPath: join(tempDir, "app.db"),
      seedFixturePath: datasetPath,
      llm: scriptedLlm,
    });
  }, 30000);

  afterAll(async () => {
    await app.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("serves the upgraded multi-source split-pane HTML UI", async () => {
    const res = await invokeHandler(app, { method: "GET", url: "/" });
    expect(res.status).toBe(200);
    expect(res.text).toContain("Bookmark Agent · Dev-Web");
    expect(res.text).toContain("sourceTabs");
    expect(res.text).toContain("categoryBar");
    expect(res.text).toContain("window.highlightBookmarkInGrid");
  });

  it("returns seeded X + XHS bookmarks and supports source/sort/category filters on GET /api/items", async () => {
    const allRes = await invokeHandler(app, {
      method: "GET",
      url: "/api/items?page=1&pageSize=15",
    });
    expect(allRes.status).toBe(200);
    const allData = JSON.parse(allRes.text);
    expect(allData.total).toBe(60);
    expect(allData.items.length).toBe(15);

    const xRes = await invokeHandler(app, {
      method: "GET",
      url: "/api/items?page=1&pageSize=10&source=x",
    });
    const xData = JSON.parse(xRes.text);
    expect(xData.total).toBe(40);
    expect(xData.items.every((it: any) => it.source === "x")).toBe(true);

    const xhsRes = await invokeHandler(app, {
      method: "GET",
      url: "/api/items?page=1&pageSize=10&source=xhs&sort=first_seen_asc",
    });
    const xhsData = JSON.parse(xhsRes.text);
    expect(xhsData.total).toBe(20);
    expect(xhsData.items.every((it: any) => it.source === "xhs")).toBe(true);
  });

  it("returns stats, categories, and sources on GET /api/meta", async () => {
    const res = await invokeHandler(app, { method: "GET", url: "/api/meta" });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.text);
    expect(data.stats.total_active_items).toBe(60);
    expect(data.stats.by_source).toEqual(
      expect.arrayContaining([
        { source: "x", count: 40 },
        { source: "xhs", count: 20 },
      ]),
    );
    expect(Array.isArray(data.categories)).toBe(true);
    expect(data.categories.length).toBeGreaterThan(0);
    expect(data.sources.map((s: any) => s.id)).toEqual(
      expect.arrayContaining(["x", "xhs"]),
    );
  });

  it("returns cross-platform related items on GET /api/related", async () => {
    const res = await invokeHandler(app, {
      method: "GET",
      url: "/api/related?id=xhs:600000000000000000000009&k=6&mode=feature-fusion",
    });
    expect(res.status).toBe(200);
    const data = JSON.parse(res.text);
    expect(data.target?.id).toBe("xhs:600000000000000000000009");
    expect(Array.isArray(data.related)).toBe(true);
    expect(data.related.length).toBeGreaterThan(0);
  });

  it("streams SSE events (tool_call_start -> text_delta -> surface_ready -> turn_complete) on POST /api/chat/stream", async () => {
    const res = await invokeHandler(app, {
      method: "POST",
      url: "/api/chat/stream",
      body: {
        sessionId: "sse-test-1",
        type: "text",
        text: "深挖 x:1000000000000000008",
      },
    });
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/event-stream");

    expect(res.text).toContain("event: turn_start");
    expect(res.text).toContain("event: tool_call_start");
    expect(res.text).toContain("event: text_delta");
    expect(res.text).toContain("event: surface_ready");
    expect(res.text).toContain("event: turn_complete");
    expect(res.text).toContain("x:1000000000000000008");
  });
});
