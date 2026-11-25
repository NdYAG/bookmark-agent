#!/usr/bin/env node
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type AgentMessage,
  AppSessionStore,
  BookmarkAgent,
  CollectionsMcpBridge,
  GeminiLlmProvider,
  type LlmProvider,
} from "@bookmark-agent/agent-core";
import { renderDevWebHtml } from "./ui.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");

export interface DevWebServerOptions {
  port?: number;
  mcpServerScriptPath?: string;
  collectionsDbPath?: string;
  appDbPath?: string;
  seedFixturePath?: string;
  llm?: LlmProvider;
  autoApproveWrites?: boolean;
}

const VALID_SORTS = new Set([
  "first_seen_desc",
  "first_seen_asc",
  "publish_desc",
  "publish_asc",
]);

async function readJsonBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  for await (const c of req) {
    chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  }
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendJson(res: ServerResponse, status: number, payload: unknown) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(payload));
}

function resolveDefaultCollectionsDbPath(): string {
  return join(repoRoot, ".worktrees-data/dev-collections.db");
}

export async function createDevWebServer(opts: DevWebServerOptions = {}) {
  const mcpServerScriptPath =
    opts.mcpServerScriptPath ||
    join(repoRoot, "packages/collections-mcp/dist/server.js");
  const collectionsDbPath =
    opts.collectionsDbPath ||
    process.env.COLLECTIONS_DB_PATH ||
    resolveDefaultCollectionsDbPath();
  const appDbPath =
    opts.appDbPath ||
    process.env.APP_DB_PATH ||
    join(repoRoot, ".worktrees-data/a1-app.db");

  let allowWrites = opts.autoApproveWrites ?? false;

  const seedPath = opts.seedFixturePath || process.env.COLLECTIONS_SEED_PATH;
  const mcpBridge = new CollectionsMcpBridge({
    serverScriptPath: mcpServerScriptPath,
    env: {
      COLLECTIONS_DB_PATH: collectionsDbPath,
      COLLECTIONS_DATA_DIR: dirname(collectionsDbPath),
      ...(seedPath ? { COLLECTIONS_SEED_PATH: seedPath } : {}),
    },
    beforeToolCall: async ({ toolName, isWriteOperation }) => {
      if (isWriteOperation && !allowWrites) {
        return {
          allow: false,
          reason: `写操作 '${toolName}' 需要用户在界面开启「允许写操作确认」后才能执行。`,
        };
      }
      return { allow: true };
    },
  });
  await mcpBridge.connect();

  const sessionStore = new AppSessionStore(appDbPath);
  const apiKey = process.env.GEMINI_API_KEY || "";
  const llm =
    opts.llm ||
    new GeminiLlmProvider({
      apiKey,
      modelId: process.env.BOOKMARK_AGENT_CHAT_MODEL || "gemini-3.1-flash-lite",
    });

  const agent = new BookmarkAgent({
    mcpBridge,
    llm,
    sessionStore,
  });

  const handleRequest = async (req: IncomingMessage, res: ServerResponse) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");

      if (req.method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        });
        res.end();
        return;
      }

      if (req.method === "GET" && url.pathname === "/") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(renderDevWebHtml());
        return;
      }

      // App Face endpoint: right-hand bookmark Grid (calls `app_list_items` directly without LLM)
      if (req.method === "GET" && url.pathname === "/api/items") {
        const page = Math.max(1, Number(url.searchParams.get("page") || "1") || 1);
        const pageSize = Math.min(
          100,
          Math.max(1, Number(url.searchParams.get("pageSize") || "36") || 36),
        );
        const source = url.searchParams.get("source") || undefined;
        const category = url.searchParams.get("category") || undefined;
        const author = url.searchParams.get("author") || undefined;
        const query = url.searchParams.get("query") || undefined;
        const mediaType = url.searchParams.get("mediaType") || undefined;
        const rawSort = url.searchParams.get("sort") || "first_seen_desc";
        const sort = VALID_SORTS.has(rawSort) ? rawSort : "first_seen_desc";

        const filter: Record<string, string> = {};
        if (source) filter.source = source;
        if (category) filter.category = category;
        if (author) filter.author = author;
        if (query) filter.query = query;
        if (mediaType) filter.mediaType = mediaType;

        const out = await mcpBridge.callAppTool("app_list_items", {
          page,
          pageSize,
          sort,
          ...(Object.keys(filter).length > 0 ? { filter } : {}),
        });
        sendJson(res, 200, out.data);
        return;
      }

      // App Face endpoint: stats + categories + sources metadata for filters & tabs
      if (req.method === "GET" && url.pathname === "/api/meta") {
        const [statsOut, catsOut, sourcesOut] = await Promise.all([
          mcpBridge.callAppTool("stats", {}),
          mcpBridge.callAppTool("list_categories", {}),
          mcpBridge.callAppTool("app_sources", {}),
        ]);
        sendJson(res, 200, {
          stats: statsOut.data,
          categories: catsOut.data?.categories || [],
          categoryCounts: catsOut.data?.counts || [],
          sources: sourcesOut.data?.sources || [],
        });
        return;
      }

      // App Face endpoint: related items view (calls `app_related` + hydrates target & metadata via `get_items`)
      if (req.method === "GET" && url.pathname === "/api/related") {
        const id = url.searchParams.get("id");
        if (!id) {
          sendJson(res, 400, { error: "Missing required query parameter 'id'" });
          return;
        }
        const k = Math.min(30, Math.max(1, Number(url.searchParams.get("k") || "12") || 12));
        const mode = url.searchParams.get("mode") || undefined;
        const out = await mcpBridge.callAppTool("app_related", {
          id,
          k,
          ...(mode ? { mode } : {}),
        });
        if (!out.ok || !out.data || typeof out.data !== "object") {
          sendJson(res, 500, out.data || { error: "Failed to compute related items" });
          return;
        }

        const relItems: Array<Record<string, any>> = Array.isArray(out.data.items)
          ? out.data.items
          : [];
        const lookupIds = Array.from(
          new Set([out.data.targetId || id, ...relItems.map((r) => String(r.id))]),
        );
        const hydrated = await mcpBridge.lookupItemsByIds(lookupIds);
        const byId = new Map(hydrated.map((it) => [it.id, it]));
        const target = byId.get(out.data.targetId || id) || null;
        const related = relItems.map((r) => {
          const full = byId.get(String(r.id));
          return {
            ...r,
            source: full?.source || (String(r.id).startsWith("xhs:") ? "xhs" : "x"),
            cover_url: (full as any)?.cover_url ?? null,
            media_type: full?.media_type ?? "post",
            item: full || r,
          };
        });

        sendJson(res, 200, {
          targetId: out.data.targetId || id,
          target,
          mode: out.data.mode,
          elapsedMs: out.data.elapsedMs,
          related,
          duplicates: out.data.duplicates || [],
        });
        return;
      }

      // Sessions endpoint
      if (req.method === "GET" && url.pathname === "/api/sessions") {
        const sessions = sessionStore.listSessions();
        sendJson(res, 200, { sessions });
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/sessions/")) {
        const sessionId = decodeURIComponent(url.pathname.slice("/api/sessions/".length));
        const messages = sessionStore.getSessionMessages(sessionId);
        sendJson(res, 200, { sessionId, messages });
        return;
      }

      // Toggle write-confirmation mode
      if (req.method === "POST" && url.pathname === "/api/settings/write-mode") {
        const body = await readJsonBody(req);
        allowWrites = Boolean(body.allowWrites);
        sendJson(res, 200, { allowWrites });
        return;
      }

      // SSE Streaming Chat endpoint (`text_delta` -> `A2uiGenerator.openStream().feed()` -> SSE)
      if (req.method === "POST" && url.pathname === "/api/chat/stream") {
        const body = await readJsonBody(req);
        const sessionId = body.sessionId || "default";
        if (typeof body.allowWrites === "boolean") {
          allowWrites = body.allowWrites;
        }

        let userMsg: AgentMessage;
        if (body.type === "attached_items") {
          userMsg = {
            role: "user",
            type: "attached_items",
            items: Array.isArray(body.items) ? body.items : [],
            prompt: body.prompt || body.text || "",
          };
        } else if (body.type === "ui_action") {
          userMsg = {
            role: "user",
            type: "ui_action",
            surfaceId: body.surfaceId || "main",
            action: body.action || "click",
            itemId: body.itemId,
            context: body.context,
          };
        } else {
          userMsg = {
            role: "user",
            type: "text",
            text: String(body.text || ""),
            attachedItems: Array.isArray(body.attachedItems) ? body.attachedItems : undefined,
          };
        }

        res.writeHead(200, {
          "Content-Type": "text/event-stream; charset=utf-8",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "Access-Control-Allow-Origin": "*",
        });

        const sendSse = (event: string, data: unknown) => {
          res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        try {
          await agent.runTurn(sessionId, userMsg, (ev) => {
            sendSse(ev.type, ev);
          });
        } catch (err: any) {
          sendSse("error", { message: err?.message || String(err) });
        } finally {
          res.end();
        }
        return;
      }

      sendJson(res, 404, { error: "Not found" });
    } catch (err: any) {
      sendJson(res, 500, { error: err?.message || String(err) });
    }
  };

  const server = createServer(handleRequest);

  const port = opts.port ?? Number(process.env.PORT || 4310);

  return {
    server,
    handleRequest,
    agent,
    mcpBridge,
    sessionStore,
    collectionsDbPath,
    async listen(listenPort = port): Promise<number> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(listenPort, "127.0.0.1", () => {
          const addr = server.address();
          const actualPort = typeof addr === "object" && addr ? addr.port : listenPort;
          resolve(actualPort);
        });
      });
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await mcpBridge.close();
      sessionStore.close();
    },
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  createDevWebServer()
    .then(async (app) => {
      const actualPort = await app.listen();
      console.log(
        `dev-web server listening on http://127.0.0.1:${actualPort} (db: ${app.collectionsDbPath})`,
      );
    })
    .catch((err) => {
      console.error("Failed to start dev-web:", err);
      process.exit(1);
    });
}
