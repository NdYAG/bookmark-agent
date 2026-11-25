import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiskAiCache } from "../src/ai/cache.js";
import { GeminiEmbedder } from "../src/ai/embedder/index.js";
import { EnrichService } from "../src/ai/enrich.js";
import { RateLimiterRegistry } from "../src/ai/limiter.js";
import { TaxonomyNamer } from "../src/ai/taxonomy-namer.js";
import { TAXONOMY_NAMING_META_KEY } from "../src/classify/index.js";
import { TIER_PRESETS } from "../src/config/index.js";
import { CollectionsDB } from "../src/db/index.js";
import { VectorIndex } from "../src/index/vector.js";
import { ItemPipeline } from "../src/pipeline/index.js";

const DIM = 8;
const TOPICS: Record<string, string> = {
  rust: "Rust",
  design: "UI动效",
  ai: "大模型",
  cooking: "食谱",
  travel: "旅行",
};

function xRaw(id: string, text: string) {
  return JSON.stringify({ id, text, author: { handle: "dev", name: "Dev" }, media: [], links: [] });
}

/** Fake Gemini: generateContent returns a card per "--- 收藏 [id]" block; embeddings depend on the topic. */
function fakeGemini(counters: { generate: number; embed: number; omit?: Set<string> }) {
  return (async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    const body = JSON.parse(String(init?.body));
    if (u.includes(":generateContent")) {
      counters.generate++;
      const text = body.contents[0].parts.map((p: any) => p.text ?? "").join("");
      const ids = [...text.matchAll(/--- 收藏 \[([^\]]+)\] 开始/g)].map((m) => m[1]);
      const cards = ids
        .filter((id) => !counters.omit?.has(id))
        .map((id) => {
          const group = id.split(":")[1].split("-")[0];
          return {
            id,
            summary: `${group} summary`,
            topics: [TOPICS[group] || group],
            kind: "tutorial",
            lang: "zh",
            imageCaptions: [],
          };
        });
      return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(cards) }] } }] }), {
        status: 200,
      });
    }
    if (u.includes(":batchEmbedContents")) {
      counters.embed++;
      const embeddings = body.requests.map((r: any) => {
        const text = JSON.stringify(r.content);
        const v = new Array(DIM).fill(0.01);
        const groupIdx = Object.entries(TOPICS).findIndex(([, label]) => text.includes(label));
        v[groupIdx >= 0 ? groupIdx : DIM - 1] = 1;
        return { values: v };
      });
      return new Response(JSON.stringify({ embeddings }), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
}

describe("Post-sync pipeline (enrich → embed → index → classify)", () => {
  let tempDir: string;
  let db: CollectionsDB;
  let index: VectorIndex;
  let counters: { generate: number; embed: number; omit?: Set<string> };
  let pipeline: ItemPipeline;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "collections-mcp-pipeline-"));
    db = new CollectionsDB(join(tempDir, "collections.db"));
    counters = { generate: 0, embed: 0 };
    const fetchFn = fakeGemini(counters);
    const limiter = new RateLimiterRegistry(TIER_PRESETS.paid);
    const cache = new DiskAiCache({ dir: join(tempDir, "cache") });
    const embedder = new GeminiEmbedder({ apiKey: "k", dim: DIM, limiter, cache, fetchFn });
    index = new VectorIndex(embedder.id, DIM);
    pipeline = new ItemPipeline({
      db,
      index,
      enrich: new EnrichService({ apiKey: "k", limiter, cache, fetchFn }),
      embedder,
      isAvailable: () => true,
      enrichBatchSize: 4,
      includeImages: false,
    });
    for (const g of ["rust", "design"]) {
      for (let i = 0; i < 5; i++) {
        db.upsertItem({ source: "x", source_item_id: `${g}-${i}`, url: `https://x.com/s/${g}-${i}`, excerpt: `${g} post ${i}`, raw: xRaw(`${g}-${i}`, `${g} post ${i}`) });
      }
    }
    db.saveCategories([
      { id: "rust", name: "Rust", description: "Rust", examples: ["x:rust-0", "x:rust-1"] },
      { id: "design", name: "设计", description: "UI", examples: ["x:design-0", "x:design-1"] },
    ]);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("enriches in batches, embeds, indexes and classifies newly synced items", async () => {
    const ids = db.listItemIdsNeedingProcessing(index.model);
    expect(ids).toHaveLength(10);

    expect(pipeline.enqueue(ids)).toEqual({ queued: 10 });
    expect(pipeline.enqueue(ids)).toEqual({ queued: 0 }); // deduplicated while queued
    const report = await pipeline.drain();

    expect(counters.generate).toBe(3); // 10 items / 4 per request
    expect(report).toMatchObject({ items: 10, enriched: 10, embedded: 10, enrichFailed: [], errors: [] });
    expect(index.size).toBe(10);
    expect(db.listItemIdsNeedingProcessing(index.model)).toEqual([]);

    const [item] = db.getItems(["x:rust-3"]) as Array<Record<string, any>>;
    expect(item.enriched_card.summary).toBe("rust summary");
    expect(item.excerpt).toContain("摘要: rust summary");
    expect(item.title).toBe("Rust");
    expect(item.category).toBe("rust");
    expect((db.getItems(["x:design-4"])[0] as any).category).toBe("design");
    expect(db.search({ query: "summary", limit: 20 }).length).toBe(10);
    expect(pipeline.status()).toMatchObject({ state: "idle", queued: 0 });
  });

  it("re-embeds only when the representation text changes and reports skipped items", async () => {
    counters.omit = new Set(["x:design-2"]);
    pipeline.enqueue(db.listItemIdsNeedingProcessing(index.model));
    const first = await pipeline.drain();
    expect(first?.enrichFailed).toEqual(["x:design-2"]);
    expect(first?.embedded).toBe(10); // the skipped item is still embedded from its excerpt
    expect(db.listItemIdsNeedingProcessing(index.model)).toEqual(["x:design-2"]);

    counters.omit = undefined;
    const embedCallsBefore = counters.embed;
    pipeline.enqueue(db.listItemIdsNeedingProcessing(index.model));
    const retry = await pipeline.drain();
    expect(retry).toMatchObject({ enriched: 1, embedded: 1, enrichFailed: [] });
    expect(counters.embed).toBe(embedCallsBefore + 1);

    pipeline.enqueue(["x:rust-0", "x:rust-1"]);
    const again = await pipeline.drain();
    expect(again).toMatchObject({ enriched: 0, embedded: 0, embedUnchanged: 2, enrichRequests: 0 });
  });

  it("keeps the enrich card when an item is re-synced", async () => {
    pipeline.enqueue(["x:rust-0"]);
    await pipeline.drain();
    db.upsertItem({ source: "x", source_item_id: "rust-0", url: "https://x.com/s/rust-0", excerpt: "rust post 0 (edited)", raw: xRaw("rust-0", "rust post 0 (edited)") });
    const [item] = db.getItems(["x:rust-0"]) as Array<Record<string, any>>;
    expect(item.enriched_card?.summary).toBe("rust summary");
    expect(item.excerpt).toBe("rust post 0 (edited)\n摘要: rust summary\n主题: Rust");
  });

  it("skips the run without an API key", async () => {
    const offline = new ItemPipeline({
      db,
      index,
      enrich: new EnrichService({ apiKey: null, limiter: new RateLimiterRegistry(TIER_PRESETS.free), cache: new DiskAiCache({ dir: join(tempDir, "c2") }) }),
      embedder: new GeminiEmbedder({ apiKey: null, dim: DIM, limiter: new RateLimiterRegistry(TIER_PRESETS.free), cache: new DiskAiCache({ dir: join(tempDir, "c3") }) }),
      isAvailable: () => false,
    });
    offline.enqueue(["x:rust-0"]);
    const report = await offline.drain();
    expect(report?.errors[0]).toContain("No API key");
    expect(report?.enrichFailed).toEqual(["x:rust-0"]);
    expect(counters.generate).toBe(0);
  });

  it("keeps < 25 items uncategorized, auto-creates cluster taxonomy at >= 25, and retries failed naming later", async () => {
    const coldDb = new CollectionsDB(join(tempDir, "cold.db"));
    const coldCounters = { generate: 0, embed: 0 };
    const fetchFn = fakeGemini(coldCounters);
    const limiter = new RateLimiterRegistry(TIER_PRESETS.paid);
    const cache = new DiskAiCache({ dir: join(tempDir, "cold-cache") });
    const embedder = new GeminiEmbedder({ apiKey: "k", dim: DIM, limiter, cache, fetchFn });
    const coldIndex = new VectorIndex(embedder.id, DIM);

    let failNaming = true;
    const flakyNamer: TaxonomyNamer = {
      model: "flaky-namer",
      isAvailable: () => true,
      async nameClusters(clusters) {
        if (failNaming) throw new Error("temporary 503");
        return {
          model: "flaky-namer",
          names: clusters.map((c) => {
            const topic = c.topTopics[0]?.topic || `cluster-${c.cluster}`;
            return {
              cluster: c.cluster,
              id: `topic-${c.cluster}`,
              name: `${topic} 精选`,
              description: `${topic} 相关内容`,
              nameSource: "llm" as const,
            };
          }),
        };
      },
    };

    const coldPipeline = new ItemPipeline({
      db: coldDb,
      index: coldIndex,
      enrich: new EnrichService({ apiKey: "k", limiter, cache, fetchFn }),
      embedder,
      namer: flakyNamer,
      isAvailable: () => true,
      enrichBatchSize: 10,
      includeImages: false,
    });

    try {
      const groups = Object.keys(TOPICS);
      // Batch 1: 15 items (3 per group, < 25 total) -> no taxonomy created, items stay uncategorized
      const batch1: string[] = [];
      for (const g of groups) {
        for (let i = 0; i < 3; i++) {
          const id = `x:${g}-${i}`;
          batch1.push(id);
          coldDb.upsertItem({
            source: "x",
            source_item_id: `${g}-${i}`,
            url: `https://x.com/s/${g}-${i}`,
            excerpt: `${g} post ${i}`,
            raw: xRaw(`${g}-${i}`, `${g} post ${i}`),
          });
        }
      }
      coldPipeline.enqueue(batch1);
      const report1 = await coldPipeline.drain();
      expect(coldIndex.size).toBe(15);
      expect(coldDb.listCategories()).toEqual([]);
      expect(report1?.taxonomy).toBeNull();
      expect(report1?.classified).toBeNull();
      expect((coldDb.getItems(["x:rust-0"])[0] as any).category).toBeNull();

      // Batch 2: 15 more items (total 30 >= 25) -> auto-clusters with topics fallback (namer fails) & classifies ALL 30 items!
      const batch2: string[] = [];
      for (const g of groups) {
        for (let i = 3; i < 6; i++) {
          const id = `x:${g}-${i}`;
          batch2.push(id);
          coldDb.upsertItem({
            source: "x",
            source_item_id: `${g}-${i}`,
            url: `https://x.com/s/${g}-${i}`,
            excerpt: `${g} post ${i}`,
            raw: xRaw(`${g}-${i}`, `${g} post ${i}`),
          });
        }
      }
      coldPipeline.enqueue(batch2);
      const report2 = await coldPipeline.drain();
      expect(coldIndex.size).toBe(30);
      expect(report2?.taxonomy).toMatchObject({ action: "created", nameSource: "topics" });
      expect(coldDb.listCategories().length).toBeGreaterThanOrEqual(5);
      expect(coldDb.listCategories().every((c) => c.name_source === "topics")).toBe(true);
      // Both batch 1 and batch 2 items must now be classified
      expect((coldDb.getItems(["x:rust-0"])[0] as any).category).not.toBeNull();
      expect((coldDb.getItems(["x:travel-5"])[0] as any).category).not.toBeNull();

      // Batch 3: once backoff elapses and namer recovers, next pipeline run upgrades temporary names to LLM names
      failNaming = false;
      coldDb.setAppMeta(TAXONOMY_NAMING_META_KEY, {
        attempts: 1,
        retryAfter: new Date(Date.now() - 1000).toISOString(),
        lastError: "temporary 503",
      });
      coldDb.upsertItem({
        source: "x",
        source_item_id: "rust-99",
        url: "https://x.com/s/rust-99",
        excerpt: "rust post 99",
        raw: xRaw("rust-99", "rust post 99"),
      });
      coldPipeline.enqueue(["x:rust-99"]);
      const report3 = await coldPipeline.drain();
      expect(report3?.taxonomy).toMatchObject({ action: "renamed", nameSource: "llm" });
      expect(coldDb.listCategories().every((c) => c.name_source === "llm")).toBe(true);
      expect(coldDb.getAppMeta(TAXONOMY_NAMING_META_KEY)).toBeNull();
    } finally {
      coldDb.close();
    }
  });
});
