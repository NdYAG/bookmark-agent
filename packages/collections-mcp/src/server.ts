#!/usr/bin/env node
import { existsSync } from "node:fs";
import { setDefaultAutoSelectFamilyAttemptTimeout } from "node:net";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DiskAiCache } from "./ai/cache.js";
import { DecisionsClient } from "./ai/decisions.js";
import { Embedder, GeminiEmbedder } from "./ai/embedder/index.js";
import { EnrichService } from "./ai/enrich.js";
import { RateLimiterRegistry } from "./ai/limiter.js";
import { GeminiTaxonomyNamer, TaxonomyNamer } from "./ai/taxonomy-namer.js";
import { AuthManager, NeedsLoginError } from "./auth/index.js";
import {
  classifyItems,
  minVectorsForClusterTaxonomy,
  proposeClusterTaxonomy,
  proposeClusterTaxonomySync,
  retryTaxonomyNaming,
  shouldRetryTaxonomyNaming,
} from "./classify/index.js";
import { loadConfig, SecretStore, TIER_PRESETS } from "./config/index.js";
import { readItem } from "./content/index.js";
import {
  CollectionsDB,
  createManualItemInput,
  fetchUrlMetadata,
} from "./db/index.js";
import { reciprocalRankFusion, VectorIndex } from "./index/vector.js";
import { ItemPipeline } from "./pipeline/index.js";
import { findRelatedItems } from "./related/index.js";
import { SocialSource, syncSocialSource } from "./sources/framework.js";
import { createXSource } from "./sources/x/index.js";
import { createXhsSource } from "./sources/xhs/index.js";

export function createCollectionsMcpServer(opts?: {
  db?: CollectionsDB;
  auth?: AuthManager;
  sources?: Record<string, SocialSource<any>>;
  embedder?: Embedder;
  decisions?: DecisionsClient;
  vectorIndex?: VectorIndex;
  taxonomyNamer?: TaxonomyNamer;
  enrich?: EnrichService;
}) {
  const config = loadConfig();
  const db = opts?.db ?? new CollectionsDB(config.dbPath!);
  const auth = opts?.auth ?? new AuthManager();
  const sources: Record<string, SocialSource<any>> = opts?.sources ?? {
    x: createXSource(),
    xhs: createXhsSource(),
  };

  const limiter = new RateLimiterRegistry(
    config.limits ?? TIER_PRESETS[config.tier],
  );
  const aiCache = new DiskAiCache({
    dir: config.cache.dir!,
    enabled: config.cache.enabled,
  });
  const apiKey = config.privacy.allowCloudForContent
    ? SecretStore.resolve(config.embedding.apiKeyRef)
    : null;

  const embedder: Embedder =
    opts?.embedder ??
    new GeminiEmbedder({
      apiKey,
      model: config.embedding.model,
      dim: config.embedding.dim,
      limiter,
      cache: aiCache,
    });

  const decisions: DecisionsClient =
    opts?.decisions ??
    new DecisionsClient({
      apiKey,
      model: config.decisions.model,
      limiter,
      cache: aiCache,
    });

  const enrichApiKey = config.privacy.allowCloudForContent
    ? SecretStore.resolve(config.enrich.apiKeyRef)
    : null;
  const enrich: EnrichService =
    opts?.enrich ??
    new EnrichService({
      apiKey: enrichApiKey,
      primaryModel: config.enrich.model,
      overflowModels: config.enrich.overflowModels,
      promptVersion: config.enrich.promptVersion,
      limiter,
      cache: aiCache,
    });

  const taxonomyNamer: TaxonomyNamer =
    opts?.taxonomyNamer ??
    new GeminiTaxonomyNamer({
      apiKey: enrichApiKey,
      model: config.enrich.model,
      overflowModels: config.enrich.overflowModels,
      limiter,
      cache: aiCache,
    });

  // Ensure configured sources have an entry in the sources table
  for (const src of Object.values(sources)) {
    const existing = db.getSource(src.id);
    if (!existing) {
      db.upsertSource({
        id: src.id,
        adapter: src.adapter,
        account: src.account,
        identity: src.identity.id,
      });
    }
  }

  // Optional explicit seed from COLLECTIONS_SEED_PATH (comma-separated JSON snapshot paths) when DB is empty
  const activeCount = (db.stats().total_active_items as number) || 0;
  const tombstoneCount = (db.stats().total_deleted_tombstones as number) || 0;
  if (
    activeCount === 0 &&
    tombstoneCount === 0 &&
    !process.env.COLLECTIONS_NO_AUTOSEED &&
    process.env.COLLECTIONS_SEED_PATH
  ) {
    for (const seedPath of process.env.COLLECTIONS_SEED_PATH.split(",")) {
      const trimmed = seedPath.trim();
      if (trimmed && existsSync(trimmed)) {
        try {
          db.importFixturesFromFile(trimmed);
        } catch {
          // Ignore opt-in seed error
        }
      }
    }
  }

  const vectorIndex =
    opts?.vectorIndex ?? new VectorIndex(embedder.id, embedder.dim);
  vectorIndex.loadFromDB(db);

  const server = new McpServer({
    name: "collections-mcp",
    version: "0.3.0",
  });

  const notifyCollectionsChanged = (params: Record<string, unknown>) => {
    void server.server
      .notification({
        method: "notifications/collections/changed",
        params,
      })
      .catch(() => {});
  };

  // Auto-initialize cluster taxonomy when >= 25 vectors exist and no categories are saved yet;
  // otherwise retry LLM naming if temporary 'topics' names are waiting and backoff has elapsed.
  if (db.listCategories().length === 0 && vectorIndex.size >= minVectorsForClusterTaxonomy()) {
    proposeClusterTaxonomySync(db, vectorIndex);
    void classifyItems({ db, index: vectorIndex, useDecisionsFallback: false })
      .then(async () => {
        if (shouldRetryTaxonomyNaming(db, taxonomyNamer)) {
          await retryTaxonomyNaming(db, vectorIndex, taxonomyNamer);
        }
        notifyCollectionsChanged({ sourceId: "taxonomy", ids: [] });
      })
      .catch((err) => {
        process.stderr.write(`[collections-mcp] startup taxonomy init failed: ${String(err)}\n`);
      });
  } else if (shouldRetryTaxonomyNaming(db, taxonomyNamer)) {
    void retryTaxonomyNaming(db, vectorIndex, taxonomyNamer)
      .then((res) => {
        if (res.updated > 0) {
          notifyCollectionsChanged({ sourceId: "taxonomy", ids: [] });
        }
      })
      .catch((err) => {
        process.stderr.write(`[collections-mcp] startup taxonomy naming retry failed: ${String(err)}\n`);
      });
  }

  // Post-sync pipeline: enrich → embed → index → classify for newly synced (or backfilled) items
  const pipeline = new ItemPipeline({
    db,
    index: vectorIndex,
    enrich,
    embedder,
    namer: taxonomyNamer,
    decisions,
    useDecisionsFallback: config.decisions.classifyFallback,
    isAvailable: () => Boolean(enrichApiKey && apiKey) || Boolean(opts?.enrich && opts?.embedder),
    onProcessed: (report, ids) => {
      notifyCollectionsChanged({
        sourceId: "pipeline",
        ids,
        enriched: report.enriched,
        embedded: report.embedded,
        taxonomy: report.taxonomy,
      });
    },
  });

  function resolveSource(sourceId = "x"): SocialSource<any> {
    const src = sources[sourceId];
    if (!src) {
      throw new Error(
        `Unknown sourceId '${sourceId}'. Available: ${Object.keys(sources).join(", ")}`,
      );
    }
    return src;
  }

  // ===========================================================================
  // LLM Face Tools (search, get_items, read_item, related, list_categories, stats, add, update, remove)
  // ===========================================================================

  server.tool(
    "search",
    "在用户的个人收藏库中混合检索收藏条目（FTS5 全文检索 + 向量语义检索 RRF 倒数排名融合）。回答关于用户收藏的问题时应首先调用此工具。",
    {
      query: z
        .string()
        .describe("搜索关键词或自然语言问题（支持中英文混合，留空则返回最近收藏）"),
      category: z.string().optional().describe("可选：按分类 ID 过滤"),
      source: z.string().optional().describe("可选：按来源过滤（如 'x', 'xhs', 'manual'）"),
      from: z.string().optional().describe("可选：起始时间 ISO-8601"),
      to: z.string().optional().describe("可选：截止时间 ISO-8601"),
      limit: z.number().int().min(1).max(100).default(20).describe("返回条数上限（默认 20）"),
      hybrid: z
        .boolean()
        .default(true)
        .describe("是否启用 FTS + 向量 RRF 混合检索（默认开启）"),
    },
    async (args) => {
      const ftsResults = db.search({ ...args, limit: Math.max(args.limit * 2, 30) });

      // Upgrade to FTS + Vector RRF hybrid search when query is non-empty and vectors are loaded
      if (
        args.hybrid !== false &&
        args.query.trim().length > 0 &&
        vectorIndex.size > 0 &&
        apiKey
      ) {
        try {
          const qVec = await embedder.embedQuery(args.query, {
            priority: "interactive",
          });
          const vecMatches = vectorIndex.topK(qVec, Math.max(args.limit * 2, 30));
          const vecIds = vecMatches.map((m) => m.id);
          const ftsById = new Map(ftsResults.map((r) => [r.id, r]));

          const missingIds = vecIds.filter((id) => !ftsById.has(id));
          if (missingIds.length > 0) {
            const extraRows = db.getItems(missingIds) as Array<Record<string, any>>;
            for (const r of extraRows) {
              if (args.category) {
                if (args.category === "uncategorized") {
                  if (r.category !== null) continue;
                } else if (r.category !== args.category) {
                  continue;
                }
              }
              if (args.source && r.source !== args.source) continue;
              ftsById.set(String(r.id), {
                id: String(r.id),
                title: (r.title as string) ?? null,
                excerpt: String(r.excerpt || "").slice(0, 360),
                author: (r.author as string) ?? null,
                url: String(r.url),
                source: String(r.source),
                media_type: (r.media_type as string) ?? null,
                publish_date: (r.publish_date as string) ?? null,
                first_seen_at: String(r.first_seen_at),
                category: (r.category as string) ?? null,
              });
            }
          }

          const vecItems = vecIds
            .map((id) => ftsById.get(id))
            .filter((x): x is NonNullable<typeof x> => Boolean(x));

          const fused = reciprocalRankFusion([
            { items: ftsResults, weight: 1.0 },
            { items: vecItems, weight: 1.0 },
          ]).slice(0, args.limit);

          return {
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    mode: "hybrid-rrf",
                    count: fused.length,
                    items: fused.map((f) => ({
                      ...f.item,
                      rrf_score: Number(f.rrfScore.toFixed(5)),
                    })),
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        } catch {
          // Fall back cleanly to FTS results if query embed fails or is offline
        }
      }

      const sliced = ftsResults.slice(0, args.limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              { mode: "fts", count: sliced.length, items: sliced },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "get_items",
    "根据收藏条目 ID 列表批量获取完整的元数据（包括摘要卡片、主题标签、配图描述、引用推文、外链等）。",
    {
      ids: z
        .array(z.string())
        .min(1)
        .max(50)
        .describe("收藏条目 ID 列表（如 ['x:1000000000000000001', 'xhs:600000000000000000000001']）"),
    },
    async ({ ids }) => {
      const items = db.getItems(ids);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ count: items.length, items }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "read_item",
    "读取单条收藏的完整正文（支持 X 推文/线程、小红书笔记正文/标签及展开外链后的网页文章正文，使用 @mozilla/readability 提取并缓存到 item_content 表）。深入讨论某条收藏前应调用此工具。",
    {
      id: z.string().describe("收藏条目 ID（如 'x:1000000000000000001' 或 'xhs:600000000000000000000001'）"),
      forceRefresh: z.boolean().default(false).describe("是否忽略本地 item_content 缓存重新提取"),
      expandExternalLinks: z
        .boolean()
        .default(true)
        .describe("是否展开推文中的 t.co 外链并提取网页正文"),
      useBrowserForTweetDetail: z
        .boolean()
        .default(false)
        .describe("是否通过浏览器会话打开详情页拉取被截断推文全文/线程或小红书笔记正文"),
    },
    async ({ id, forceRefresh, expandExternalLinks, useBrowserForTweetDetail }) => {
      try {
        const res = await readItem(db, auth, id, {
          forceRefresh,
          expandExternalLinks,
          useBrowserForTweetDetail,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(res, null, 2),
            },
          ],
        };
      } catch (e: any) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: e?.message || String(e) }, null, 2),
            },
          ],
        };
      }
    },
  );

  server.tool(
    "related",
    "查找与指定收藏最相关的其他收藏（三路召回 + 特征融合 + 可选 gemini-decision-1 精判 + MMR 多样化），返回关联分数与原因标签 signals。",
    {
      id: z.string().describe("目标收藏条目 ID（如 'x:1000000000000000001' 或 'xhs:600000000000000000000001'）"),
      k: z.number().int().min(1).max(30).default(10).describe("返回相关条目数量（默认 10）"),
      mode: z
        .enum(["embedding-only", "feature-fusion", "decisions-rerank"])
        .optional()
        .describe("相关度计算模式（默认开启 decisions-rerank，无 API key 时自动降级 feature-fusion）"),
    },
    async ({ id, k, mode }) => {
      try {
        const res = await findRelatedItems({
          db,
          index: vectorIndex,
          decisions: config.decisions.rerank ? decisions : undefined,
          targetId: id,
          k,
          mode,
        });
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(res, null, 2),
            },
          ],
        };
      } catch (e: any) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({ error: e?.message || String(e) }, null, 2),
            },
          ],
        };
      }
    },
  );

  server.tool(
    "list_categories",
    "列出当前收藏分类体系（各分类 ID、名称、描述及该分类下的收藏数量）。",
    {},
    async () => {
      const categories = db.listCategories();
      const stats = db.stats();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                categories,
                counts: stats.by_category,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "stats",
    "获取用户收藏库的整体统计信息（总条数、来源分布、内容类型分布、分类分布、常收藏作者 Top-10 及时间跨度）。",
    {},
    async () => {
      const data = db.stats();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "add",
    "手动新增一条网页 URL 到收藏库（自动尝试抓取网页的 OpenGraph 标题、描述与封面图）。",
    {
      url: z.string().url().describe("要收藏的完整 URL"),
      note: z.string().optional().describe("可选：用户对该收藏的备注"),
      title: z
        .string()
        .optional()
        .describe("可选：自定义标题（若不传则自动抓取网页标题）"),
    },
    async ({ url, note, title }) => {
      const meta = await fetchUrlMetadata(url);
      if (title) meta.title = title;
      const input = createManualItemInput(url, meta, note);
      const res = db.upsertItem(input);
      const postProcess =
        res.status === "inserted" || res.status === "updated"
          ? { ...pipeline.enqueue([res.id]), status: pipeline.status().state }
          : { queued: 0, status: pipeline.status().state };
      const item = db.getItems([res.id])[0];
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ status: res.status, item, postProcess }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "update",
    "修改某条收藏的标题、摘要、备注或分类。用户修改过的字段会被记录在 user_overrides 中，后续重新导入或同步时绝不会被覆盖。",
    {
      id: z.string().describe("收藏条目 ID"),
      title: z.string().optional().describe("新的标题"),
      excerpt: z.string().optional().describe("新的正文摘要"),
      note: z.string().optional().describe("新的用户备注"),
      category: z.string().optional().describe("新的分类 ID"),
    },
    async ({ id, title, excerpt, note, category }) => {
      const res = db.updateItem(id, { title, excerpt, note, category });
      if (res.ok && category !== undefined && vectorIndex.size > 0) {
        // Active learning: user updated category -> recompute centroids and reclassify auto items
        await classifyItems({
          db,
          index: vectorIndex,
          useDecisionsFallback: false,
        });
      }
      return {
        isError: !res.ok,
        content: [
          {
            type: "text",
            text: JSON.stringify(res, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "remove",
    "从本地收藏库中软删除（墓碑标记）指定条目。软删除后的条目在后续重新同步或重新导入时不会复活。",
    {
      id: z.string().describe("要删除的收藏条目 ID"),
    },
    async ({ id }) => {
      const res = db.removeItem(id);
      if (res.ok && res.id) {
        vectorIndex.remove(res.id);
      }
      return {
        isError: !res.ok,
        content: [
          {
            type: "text",
            text: JSON.stringify(res, null, 2),
          },
        ],
      };
    },
  );

  // ===========================================================================
  // App Face Tools (app_* — intended for App UI Grid / management, not LLM)
  // ===========================================================================

  server.tool(
    "app_list_items",
    "[App UI 专用] 分页列出收藏条目，支持按来源、分类、作者、媒体类型、关键词过滤与排序。",
    {
      page: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(100).default(24),
      filter: z
        .object({
          source: z.string().optional(),
          category: z.string().optional(),
          author: z.string().optional(),
          mediaType: z.string().optional(),
          query: z.string().optional(),
        })
        .optional(),
      sort: z
        .enum(["first_seen_desc", "first_seen_asc", "publish_desc", "publish_asc"])
        .default("first_seen_desc"),
    },
    async (args) => {
      const res = db.appListItems(args);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(res, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "app_related",
    "[App UI 专用] 右键「相关收藏」关联视图接口，与 related 工具共用同一套召回、精判与 MMR 实现。",
    {
      id: z.string().describe("目标收藏条目 ID"),
      k: z.number().int().min(1).max(30).default(12),
      mode: z
        .enum(["embedding-only", "feature-fusion", "decisions-rerank"])
        .optional(),
    },
    async ({ id, k, mode }) => {
      const res = await findRelatedItems({
        db,
        index: vectorIndex,
        decisions: config.decisions.rerank ? decisions : undefined,
        targetId: id,
        k,
        mode,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(res, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "app_taxonomy_propose",
    "[App UI 专用] 基于向量聚类（k-means，silhouette 选 k）提议分类体系并运行三级分类器；需至少 25 条已向量化收藏，由 LLM 为各簇命名（不可用或失败时先以高频主题词命名并稍后重试），替换分类时会迁移用户已确认的归类。",
    {
      useDecisionsFallback: z.boolean().default(false),
    },
    async ({ useDecisionsFallback }) => {
      const minVectors = minVectorsForClusterTaxonomy();
      if (vectorIndex.size < minVectors) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  error: "NOT_ENOUGH_VECTORS",
                  minVectors,
                  totalVectors: vectorIndex.size,
                  message: `当前仅有 ${vectorIndex.size} 条已向量化收藏，至少需要 ${minVectors} 条才能自动聚类。`,
                },
                null,
                2,
              ),
            },
          ],
        };
      }
      let proposed;
      try {
        proposed = await proposeClusterTaxonomy(db, vectorIndex, {
          namer: taxonomyNamer,
          resetNamingMeta: true,
        });
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                { error: "TAXONOMY_PROPOSE_FAILED", message: err instanceof Error ? err.message : String(err) },
                null,
                2,
              ),
            },
          ],
        };
      }
      const classified = await classifyItems({
        db,
        index: vectorIndex,
        decisions: useDecisionsFallback ? decisions : undefined,
        useDecisionsFallback,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                nameSource: proposed.nameSource,
                fallbackReason: proposed.fallbackReason,
                namerModel: proposed.namerModel,
                userLabels: proposed.userLabels,
                categories: proposed.categories,
                clusteringStats: proposed.clusteringStats,
                classification: {
                  total: classified.total,
                  bySource: classified.bySource,
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "app_categories_edit",
    "[App UI 专用] 编辑分类体系（新增、改名、合并、删除分类），自动重算质心并重新分类自动分配的条目（用户已确认的不动）。",
    {
      categories: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          description: z.string().optional(),
          examples: z.array(z.string()).optional(),
          sort: z.number().int().optional(),
        }),
      ),
      useDecisionsFallback: z.boolean().default(false),
    },
    async ({ categories, useDecisionsFallback }) => {
      db.saveCategories(categories);
      const classified = await classifyItems({
        db,
        index: vectorIndex,
        decisions: useDecisionsFallback ? decisions : undefined,
        useDecisionsFallback,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                categories: db.listCategories(),
                reclassified: {
                  total: classified.total,
                  bySource: classified.bySource,
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "app_pending",
    "[App UI 专用] 获取「待确认」分类托盘队列（按不确定度从高到低排序，用于主动学习）。",
    {
      limit: z.number().int().min(1).max(100).default(20),
    },
    async ({ limit }) => {
      const items = db.listPendingItems(limit);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ count: items.length, items }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "app_confirm",
    "[App UI 专用] 用户一键确认或修正某条收藏的分类（记为 source='user' 样本，自动更新质心与 kNN 并后台重新分类自动分配的条目）。",
    {
      itemId: z.string().describe("收藏条目 ID"),
      categoryId: z.string().describe("确认的分类 ID"),
    },
    async ({ itemId, categoryId }) => {
      const upd = db.updateItem(itemId, { category: categoryId });
      if (!upd.ok) {
        return {
          isError: true,
          content: [{ type: "text", text: JSON.stringify(upd, null, 2) }],
        };
      }
      const reclassified = await classifyItems({
        db,
        index: vectorIndex,
        useDecisionsFallback: false,
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                confirmed: { itemId: upd.item?.id, categoryId },
                reclassified: {
                  total: reclassified.total,
                  bySource: reclassified.bySource,
                },
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.tool(
    "app_import_fixtures",
    "[App / 开发专用] 从本地 JSON 快照文件导入收藏，遵循软删除墓碑与 user_overrides 保护。",
    {
      path: z.string().describe("要导入的书签快照 JSON 文件路径"),
      source: z
        .enum(["x", "xhs"])
        .optional()
        .describe("可选：显式指定来源（'x' 或 'xhs'），不传时自动按路径或内容推断"),
    },
    async ({ path, source }) => {
      const stats = db.importFixturesFromFile(path, source ? { source } : undefined);
      vectorIndex.loadFromDB(db);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ path, ...stats }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "app_sources",
    "[App UI 专用] 列出已配置的收藏来源及其同步游标（cursor）、上次同步时间与状态。",
    {},
    async () => {
      const rows = db.listSources();
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ sources: rows }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "app_login_check",
    "[App UI 专用] 检查指定收藏来源（默认 'x'）的登录状态，返回 VALID、EXPIRED 或 MISSING。",
    {
      sourceId: z.string().default("x").describe("来源 ID（如 'x' 或 'xhs'）"),
    },
    async ({ sourceId }) => {
      const src = resolveSource(sourceId);
      const res = await auth.check(src.identity);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ sourceId: src.id, ...res }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "app_login_handoff",
    "[App UI 专用] 启动人工交接登录窗口（X 默认使用无自动化特征的专用 Chrome 窗口；其他站点可选 ab-login 有头交接）。",
    {
      sourceId: z.string().default("x").describe("来源 ID（如 'x' 或 'xhs'）"),
      timeoutSec: z.number().int().min(10).max(1800).default(600),
    },
    async ({ sourceId, timeoutSec }) => {
      const src = resolveSource(sourceId);
      const res = await auth.handoff(src.identity, { timeoutSec });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ sourceId: src.id, ...res }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "app_login_forget",
    "[App UI / 测试专用] 清除指定来源的登录状态（相当于 ab-login forget），使下次同步触发 NEEDS_LOGIN。",
    {
      sourceId: z.string().default("x").describe("来源 ID（如 'x' 或 'xhs'）"),
    },
    async ({ sourceId }) => {
      const src = resolveSource(sourceId);
      const res = await auth.forget(src.identity);
      db.upsertSource({
        id: src.id,
        adapter: src.adapter,
        account: src.account,
        identity: src.identity.id,
        last_status: "NEEDS_LOGIN",
      });
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ sourceId: src.id, ...res }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "app_pipeline_status",
    "[App UI 专用] 查询同步后处理流水线（enrich → embedding → 索引 → 归类）的状态：idle/running、排队条数、当前阶段进度与最近一次运行报告。",
    {},
    async () => ({
      content: [{ type: "text", text: JSON.stringify(pipeline.status(), null, 2) }],
    }),
  );

  server.tool(
    "app_process_items",
    "[App UI 专用] 对指定条目（缺省为所有缺少 enrich 卡片或向量的条目）执行 enrich → embedding → 索引 → 归类，用于补齐冷启动数据或失败重试。wait=true 时等待完成并返回报告。",
    {
      itemIds: z.array(z.string()).optional().describe("条目 ID；缺省时自动选取待处理条目"),
      limit: z.number().int().min(1).max(5000).default(500).describe("缺省选取时的最大条数"),
      wait: z.boolean().default(false).describe("是否等待处理完成"),
    },
    async ({ itemIds, limit, wait }) => {
      const ids = itemIds ?? db.listItemIdsNeedingProcessing(embedder.id, limit);
      const { queued } = pipeline.enqueue(ids);
      const lastRun = wait ? await pipeline.drain() : null;
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ requested: ids.length, queued, ...(wait ? { report: lastRun } : {}), status: pipeline.status() }, null, 2),
          },
        ],
      };
    },
  );

  server.tool(
    "app_sync",
    "[App UI 专用] 执行来源增量同步（带进度通知与健康检查；未登录时返回结构化错误 NEEDS_LOGIN {sourceId}；完成时发送 notifications/collections/changed）。",
    {
      sourceId: z.string().default("x").describe("来源 ID（如 'x' 或 'xhs'）"),
      maxItems: z.number().int().min(1).max(5000).default(200).describe("单次最大抓取条数（上限 5000）"),
      ignoreCursor: z.boolean().default(false).describe("是否忽略增量 cursor 强制全量扫描"),
    },
    async ({ sourceId, maxItems, ignoreCursor }, extra) => {
      const src = resolveSource(sourceId);
      const progressToken = extra?._meta?.progressToken;

      try {
        const res = await syncSocialSource({
          source: src,
          db,
          auth,
          maxItems,
          ignoreCursor,
          onProgress: async (p) => {
            if (progressToken !== undefined && extra?.sendNotification) {
              await extra
                .sendNotification({
                  method: "notifications/progress",
                  params: {
                    progressToken,
                    progress: p.fetched,
                    total: p.maxItems,
                    message: `Round ${p.round}: fetched ${p.fetched} items`,
                  },
                } as any)
                .catch(() => {});
            }
          },
        });

        const postProcess =
          res.changedIds.length > 0
            ? { ...pipeline.enqueue(res.changedIds), status: pipeline.status().state }
            : { queued: 0, status: pipeline.status().state };

        if (res.changedIds.length > 0) {
          await server.server
            .notification({
              method: "notifications/collections/changed",
              params: {
                sourceId: src.id,
                ids: res.changedIds,
                inserted: res.inserted,
              },
            })
            .catch(() => {});
        }

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ ...res, postProcess }, null, 2),
            },
          ],
        };
      } catch (err: any) {
        if (err instanceof NeedsLoginError || err?.code === "NEEDS_LOGIN") {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    code: "NEEDS_LOGIN",
                    sourceId: src.id,
                    identityId: src.identity.id,
                    message: err.message,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        if (err?.code === "HEALTH_CHECK_FAILED") {
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: JSON.stringify(
                  {
                    code: "HEALTH_CHECK_FAILED",
                    sourceId: src.id,
                    message: err.message,
                    health: err.health,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify(
                {
                  code: "SYNC_ERROR",
                  sourceId: src.id,
                  message: err?.message || String(err),
                },
                null,
                2,
              ),
            },
          ],
        };
      }
    },
  );

  return { server, db, auth, config, sources, vectorIndex, embedder, decisions, taxonomyNamer, enrich, pipeline, limiter, aiCache };
}

async function main() {
  // Under Electron (ELECTRON_RUN_AS_NODE, Node 22) fetch gives each resolved address only 250 ms to
  // connect before trying the next; on slower links every Google API address times out and fetch
  // fails with ETIMEDOUT. Node 26 tolerates the same network. Allow 2 s per attempt.
  setDefaultAutoSelectFamilyAttemptTimeout(2_000);
  const { server } = createCollectionsMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Run stdio server if invoked directly
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error("Fatal error in collections-mcp:", err);
    process.exit(1);
  });
}
