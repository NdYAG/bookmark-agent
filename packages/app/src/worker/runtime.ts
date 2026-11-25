import { dirname, join } from "node:path";
import {
  type AgentMessage,
  type BookmarkAgentStreamEvent as AgentStreamEvent,
  AppSessionStore,
  BookmarkAgent,
  CollectionsMcpBridge,
  GeminiLlmProvider,
  type LlmProvider,
} from "@bookmark-agent/agent-core";
import type {
  CollectionsChangedEvent,
  ItemListParams,
  MetaResponse,
  RelatedResponse,
  SendMessageRequest,
  SyncProgressEvent,
} from "../shared/types.js";

export interface AgentRuntimeOptions {
  mcpServerScriptPath: string;
  collectionsDbPath: string;
  appDbPath: string;
  seedFixturePath?: string;
  apiKey?: string;
  chatModel?: string;
  mcpConfigPath?: string;
  runMcpAsElectronNode?: boolean;
  llm?: LlmProvider;
  onChatStream?: (sessionId: string, event: AgentStreamEvent) => void;
  onSyncProgress?: (ev: SyncProgressEvent) => void;
  onCollectionsChanged?: (ev: CollectionsChangedEvent) => void;
}

/**
 * Core runtime hosted inside Electron's `utilityProcess` (and directly testable in Vitest):
 * - Owns `CollectionsMcpBridge` (spawning `collections-mcp` via stdio with `ELECTRON_RUN_AS_NODE=1` in Electron)
 * - Owns `AppSessionStore` (`app.db`) + `related_feedback` table for "不相关" dismissals
 * - Owns `BookmarkAgent` (`agent-core`) for A2UI streaming chat + LLM session title generation
 */
export class AgentRuntime {
  readonly mcpBridge: CollectionsMcpBridge;
  readonly sessionStore: AppSessionStore;
  readonly agent: BookmarkAgent;
  private allowWrites = false;
  private readonly apiKey: string;
  private readonly chatModel: string;
  private readonly onChatStream?: (sessionId: string, event: AgentStreamEvent) => void;
  private readonly onSyncProgress?: (ev: SyncProgressEvent) => void;
  private readonly onCollectionsChanged?: (ev: CollectionsChangedEvent) => void;

  constructor(private readonly opts: AgentRuntimeOptions) {
    this.apiKey = opts.apiKey || process.env.GEMINI_API_KEY || "";
    this.chatModel =
      opts.chatModel || process.env.BOOKMARK_AGENT_CHAT_MODEL || "gemini-3.1-flash-lite";
    this.onChatStream = opts.onChatStream;
    this.onSyncProgress = opts.onSyncProgress;
    this.onCollectionsChanged = opts.onCollectionsChanged;

    const mcpEnv: Record<string, string> = {
      COLLECTIONS_DB_PATH: opts.collectionsDbPath,
      COLLECTIONS_DATA_DIR: dirname(opts.collectionsDbPath),
    };
    const seedPath = opts.seedFixturePath || process.env.COLLECTIONS_SEED_PATH;
    if (seedPath) {
      mcpEnv.COLLECTIONS_SEED_PATH = seedPath;
    }
    if (this.apiKey) {
      mcpEnv.GEMINI_API_KEY = this.apiKey;
    }
    if (opts.mcpConfigPath) {
      mcpEnv.COLLECTIONS_MCP_CONFIG = opts.mcpConfigPath;
    }
    if (opts.runMcpAsElectronNode) {
      mcpEnv.ELECTRON_RUN_AS_NODE = "1";
    }

    this.mcpBridge = new CollectionsMcpBridge({
      serverScriptPath: opts.mcpServerScriptPath,
      env: mcpEnv,
      beforeToolCall: async ({ toolName, isWriteOperation }) => {
        if (isWriteOperation && !this.allowWrites) {
          return {
            allow: false,
            reason: `写操作 '${toolName}' 需要先在聊天区开启「允许写操作」后才能执行。`,
          };
        }
        return { allow: true };
      },
    });

    this.sessionStore = new AppSessionStore(opts.appDbPath);
    this.ensureFeedbackTable();

    const llm =
      opts.llm ||
      new GeminiLlmProvider({
        apiKey: this.apiKey,
        modelId: this.chatModel,
      });

    this.agent = new BookmarkAgent({
      mcpBridge: this.mcpBridge,
      llm,
      sessionStore: this.sessionStore,
    });
  }

  private ensureFeedbackTable(): void {
    this.sessionStore.db.exec(`
      CREATE TABLE IF NOT EXISTS related_feedback (
        target_id    TEXT NOT NULL,
        candidate_id TEXT NOT NULL,
        verdict      TEXT NOT NULL,
        created_at   TEXT NOT NULL,
        PRIMARY KEY (target_id, candidate_id)
      );
    `);
  }

  async start(): Promise<void> {
    await this.mcpBridge.connect();
  }

  async close(): Promise<void> {
    await this.mcpBridge.close();
    this.sessionStore.close();
  }

  setWriteMode(allowWrites: boolean): { allowWrites: boolean } {
    this.allowWrites = Boolean(allowWrites);
    return { allowWrites: this.allowWrites };
  }

  async listItems(params: ItemListParams = {}) {
    const filter: Record<string, string> = {};
    if (params.source) filter.source = params.source;
    if (params.category) filter.category = params.category;
    if (params.author) filter.author = params.author;
    if (params.mediaType) filter.mediaType = params.mediaType;
    if (params.query) filter.query = params.query;

    const out = await this.mcpBridge.callAppTool("app_list_items", {
      page: params.page ?? 1,
      pageSize: params.pageSize ?? 50,
      sort: params.sort ?? "first_seen_desc",
      ...(Object.keys(filter).length > 0 ? { filter } : {}),
    });
    return out.data;
  }

  async updateItem(
    id: string,
    patch: { title?: string; excerpt?: string; note?: string; category?: string },
  ) {
    const out = await this.mcpBridge.callAppTool("update", { id, ...patch });
    if (out.ok) {
      this.onCollectionsChanged?.({ ids: [id] });
    }
    return out.data;
  }

  async removeItem(id: string) {
    const out = await this.mcpBridge.callAppTool("remove", { id });
    if (out.ok) {
      this.onCollectionsChanged?.({ ids: [id] });
    }
    return out.data;
  }

  getDismissedRelatedIds(targetId: string): string[] {
    const rows = this.sessionStore.db
      .prepare(
        "SELECT candidate_id FROM related_feedback WHERE target_id = ? AND verdict = 'not_related'",
      )
      .all(targetId) as Array<{ candidate_id: string }>;
    return rows.map((r) => r.candidate_id);
  }

  dismissRelated(targetId: string, candidateId: string): { ok: boolean } {
    this.sessionStore.db
      .prepare(
        `INSERT INTO related_feedback (target_id, candidate_id, verdict, created_at)
         VALUES (?, ?, 'not_related', ?)
         ON CONFLICT(target_id, candidate_id) DO UPDATE SET verdict = 'not_related', created_at = excluded.created_at`,
      )
      .run(targetId, candidateId, new Date().toISOString());
    return { ok: true };
  }

  async getRelated(id: string, k = 12, mode?: string): Promise<RelatedResponse> {
    const dismissedIds = this.getDismissedRelatedIds(id);
    const dismissedSet = new Set(dismissedIds);
    const out = await this.mcpBridge.callAppTool("app_related", {
      id,
      k: Math.min(30, k + dismissedIds.length),
      ...(mode ? { mode } : {}),
    });
    if (!out.ok || !out.data || typeof out.data !== "object") {
      throw new Error(out.data?.error || "Failed to compute related items");
    }

    const rawItems: Array<Record<string, any>> = Array.isArray(out.data.items)
      ? out.data.items
      : [];
    const filtered = rawItems.filter((r) => !dismissedSet.has(String(r.id))).slice(0, k);
    const targetId = String(out.data.targetId || id);
    const lookupIds = Array.from(new Set([targetId, ...filtered.map((r) => String(r.id))]));
    const hydrated = await this.mcpBridge.lookupItemsByIds(lookupIds);
    const byId = new Map(hydrated.map((it) => [it.id, it]));

    return {
      targetId,
      target: (byId.get(targetId) as any) || null,
      mode: out.data.mode || mode || "feature-fusion",
      elapsedMs: out.data.elapsedMs ?? 0,
      related: filtered.map((r) => {
        const full = byId.get(String(r.id));
        return {
          id: String(r.id),
          source: full?.source || (String(r.id).startsWith("xhs:") ? "xhs" : "x"),
          title: full?.title ?? r.title ?? null,
          author: full?.author ?? r.author ?? null,
          excerpt: full?.excerpt ?? r.excerpt ?? "",
          url: full?.url ?? r.url ?? "",
          cover_url: (full as any)?.cover_url ?? null,
          media_type: full?.media_type ?? "post",
          category: full?.category ?? r.category ?? null,
          score: Number(r.score ?? 0),
          cos: Number(r.cos ?? 0),
          decisionScore: r.decisionScore,
          signals: Array.isArray(r.signals) ? r.signals : [],
          item: full,
        };
      }),
      dismissedIds,
    };
  }

  async getMeta(): Promise<MetaResponse> {
    const [statsOut, catsOut, sourcesOut] = await Promise.all([
      this.mcpBridge.callAppTool("stats", {}),
      this.mcpBridge.callAppTool("list_categories", {}),
      this.mcpBridge.callAppTool("app_sources", {}),
    ]);
    return {
      stats: statsOut.data,
      categories: catsOut.data?.categories || [],
      categoryCounts: catsOut.data?.counts || [],
      sources: sourcesOut.data?.sources || [],
    };
  }

  async proposeTaxonomy(useDecisionsFallback = false) {
    const out = await this.mcpBridge.callAppTool("app_taxonomy_propose", {
      useDecisionsFallback,
    });
    if (out.ok) {
      this.onCollectionsChanged?.({ ids: [] });
    }
    return out.data;
  }

  async editCategories(
    categories: Array<{
      id: string;
      name: string;
      description?: string;
      examples?: string[];
      sort?: number;
    }>,
  ) {
    const out = await this.mcpBridge.callAppTool("app_categories_edit", {
      categories,
      useDecisionsFallback: false,
    });
    if (out.ok) {
      this.onCollectionsChanged?.({ ids: [] });
    }
    return out.data;
  }

  async listPending(limit = 30) {
    const out = await this.mcpBridge.callAppTool("app_pending", { limit });
    return out.data;
  }

  async confirmCategory(itemId: string, categoryId: string) {
    const out = await this.mcpBridge.callAppTool("app_confirm", { itemId, categoryId });
    if (out.ok) {
      this.onCollectionsChanged?.({ ids: [itemId] });
    }
    return out.data;
  }

  async loginCheck(sourceId: string) {
    const out = await this.mcpBridge.callAppTool("app_login_check", { sourceId });
    return out.data;
  }

  async loginHandoff(sourceId: string) {
    const out = await this.mcpBridge.callAppTool("app_login_handoff", { sourceId });
    return out.data;
  }

  async loginForget(sourceId: string) {
    const out = await this.mcpBridge.callAppTool("app_login_forget", { sourceId });
    return out.data;
  }

  async syncSource(sourceId: string, maxItems = 200) {
    this.onSyncProgress?.({
      sourceId,
      progress: 0,
      total: maxItems,
      message: `正在同步 ${sourceId} 收藏...`,
      status: "running",
    });

    const out = await this.mcpBridge.callAppTool("app_sync", {
      sourceId,
      maxItems,
    });

    if (!out.ok) {
      const isNeedsLogin = out.data?.code === "NEEDS_LOGIN";
      this.onSyncProgress?.({
        sourceId,
        progress: 0,
        total: maxItems,
        message: out.data?.message || "同步失败",
        status: isNeedsLogin ? "needs_login" : "error",
      });
      return out.data;
    }

    const inserted = Number(out.data?.inserted ?? 0);
    const fetched = Number(out.data?.fetchedCount ?? out.data?.fetched ?? 0);
    const queued = Number(out.data?.postProcess?.queued ?? 0);
    const syncedMsg = `同步完成：扫描 ${fetched} 条，新增 ${inserted} 条`;
    this.onSyncProgress?.({
      sourceId,
      progress: fetched || maxItems,
      total: fetched || maxItems,
      message: queued > 0 ? `${syncedMsg}，正在富化与归类…` : syncedMsg,
      status: queued > 0 ? "running" : "done",
    });

    const changedIds: string[] = Array.isArray(out.data?.changedIds) ? out.data.changedIds : [];
    if (changedIds.length > 0) {
      this.onCollectionsChanged?.({ sourceId, ids: changedIds, inserted });
    }
    if (queued > 0) {
      void this.followPipeline(sourceId, syncedMsg, changedIds, inserted);
    }
    return out.data;
  }

  /**
   * Polls `app_pipeline_status` after a sync until the enrich → embed → classify queue drains,
   * relaying stage progress to the sync bar and refreshing the grid when done.
   */
  private async followPipeline(sourceId: string, syncedMsg: string, ids: string[], inserted: number) {
    const STAGE_LABEL: Record<string, string> = { enrich: "富化", embed: "计算向量", classify: "归类" };
    const deadline = Date.now() + 30 * 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      const st = await this.mcpBridge.callAppTool("app_pipeline_status", {}).catch(() => null);
      if (!st?.ok) break;
      const { state, current, lastRun } = st.data ?? {};
      if (state === "running" && current) {
        this.onSyncProgress?.({
          sourceId,
          progress: current.done,
          total: Math.max(1, current.total),
          message: `${syncedMsg}，正在${STAGE_LABEL[current.stage] ?? current.stage} ${current.done}/${current.total}`,
          status: "running",
        });
        continue;
      }
      if (state === "idle") {
        const failed = (lastRun?.enrichFailed?.length ?? 0) + (lastRun?.embedFailed?.length ?? 0);
        const summary = lastRun
          ? `，已富化 ${lastRun.enriched} 条、计算向量 ${lastRun.embedded} 条${failed ? `，${failed} 条待重试` : ""}`
          : "";
        this.onSyncProgress?.({
          sourceId,
          progress: 1,
          total: 1,
          message: `${syncedMsg}${summary}`,
          status: lastRun?.errors?.length && !lastRun.embedded ? "error" : "done",
        });
        this.onCollectionsChanged?.({ sourceId, ids, inserted });
        return;
      }
    }
  }

  listSessions() {
    return this.sessionStore.listSessions();
  }

  createSession(title = "新对话") {
    return this.sessionStore.createSession(title);
  }

  getMessages(sessionId: string) {
    return this.sessionStore.getSessionMessages(sessionId);
  }

  searchMessages(query: string, limit = 20) {
    return this.sessionStore.searchMessages(query, limit);
  }

  async sendMessage(req: SendMessageRequest): Promise<{ ok: boolean; error?: string }> {
    if (typeof req.allowWrites === "boolean") {
      this.allowWrites = req.allowWrites;
    }
    const existingCount = this.sessionStore.getSessionMessages(req.sessionId).length;
    let userMsg: AgentMessage;
    if (req.attachedItems && req.attachedItems.length > 0) {
      userMsg = {
        role: "user",
        type: "attached_items",
        items: req.attachedItems,
        prompt: req.text || "请分析这些收藏",
      };
    } else {
      userMsg = {
        role: "user",
        type: "text",
        text: req.text || "",
      };
    }

    try {
      await this.agent.runTurn(req.sessionId, userMsg, (ev) => {
        this.onChatStream?.(req.sessionId, ev);
      });

      // Generate concise session title after the first turn
      if (existingCount === 0 && req.text?.trim()) {
        void this.generateSessionTitle(req.sessionId, req.text.trim());
      }
      return { ok: true };
    } catch (err: any) {
      const msg = err?.message || String(err);
      this.onChatStream?.(req.sessionId, {
        type: "text_delta",
        delta: `\n[错误] ${msg}`,
      });
      return { ok: false, error: msg };
    }
  }

  private async generateSessionTitle(sessionId: string, firstPrompt: string): Promise<void> {
    if (!this.apiKey) return;
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.chatModel}:generateContent?key=${encodeURIComponent(this.apiKey)}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              role: "user",
              parts: [
                {
                  text: `请把下面用户的收藏对话问题概括成一个不超过 16 个字的中文标题，只输出标题本身，不要引号或标点：\n${firstPrompt}`,
                },
              ],
            },
          ],
          generationConfig: { temperature: 0.2, maxOutputTokens: 32 },
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return;
      const json = (await res.json()) as any;
      const title = json?.candidates?.[0]?.content?.parts?.[0]?.text
        ?.replace(/[\r\n"“”'‘’]/g, "")
        .trim()
        .slice(0, 24);
      if (title) {
        this.sessionStore.updateSessionTitle(sessionId, title);
      }
    } catch {
      // Keep the auto-truncated prompt title already set by AppSessionStore
    }
  }
}

export function resolveDefaultCollectionsDbPath(_repoRoot: string, userDataDir: string): string {
  return join(userDataDir, "collections.db");
}
