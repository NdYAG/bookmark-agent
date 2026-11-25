import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiskAiCache } from "../src/ai/cache.js";
import { DecisionsClient } from "../src/ai/decisions.js";
import { EnrichService } from "../src/ai/enrich.js";
import { QuotaExhaustedError, RateLimiterRegistry } from "../src/ai/limiter.js";
import { classifyItems, proposeClusterTaxonomySync } from "../src/classify/index.js";
import { TIER_PRESETS } from "../src/config/index.js";
import { CollectionsDB } from "../src/db/index.js";
import { reciprocalRankFusion, VectorIndex } from "../src/index/vector.js";
import { findRelatedItems } from "../src/related/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const datasetPath = join(repoRoot, "packages/eval/dataset/items.json");

describe("M2 · Intelligence Layer (Limiter, Cache, Enrich, VectorIndex, Related, Classify)", () => {
  let tempDir: string;
  let dbPath: string;
  let cacheDir: string;
  let db: CollectionsDB;
  let aiCache: DiskAiCache;
  let limiter: RateLimiterRegistry;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "collections-mcp-m2-"));
    dbPath = join(tempDir, "collections.db");
    cacheDir = join(tempDir, "llm-cache");
    db = new CollectionsDB(dbPath);
    aiCache = new DiskAiCache({ dir: cacheDir, enabled: true });
    limiter = new RateLimiterRegistry(TIER_PRESETS.free);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("enforces priority ordering, RPD quota pause/resume, and Gemma 4 overflow in Limiter + EnrichService", async () => {
    // 1. Configure tiny RPD bucket (rpd: 1) for primary model, sufficient RPD for gemma-4-31b-it
    const customLimiter = new RateLimiterRegistry({
      "gemini-3.1-flash-lite": { rpm: 100, tpm: 100_000, rpd: 1 },
      "gemma-4-31b-it": { rpm: 100, tpm: 100_000, rpd: 100 },
    });

    const calledModels: string[] = [];
    const mockFetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      const modelMatch = /\/models\/([^:]+):generateContent/.exec(url);
      const model = modelMatch?.[1] || "unknown";
      calledModels.push(model);

      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [
                  {
                    text: JSON.stringify({
                      summary: `Summary from ${model}`,
                      topics: ["Rust", "Async"],
                      kind: "tutorial",
                      lang: "zh",
                      imageCaptions: [],
                    }),
                  },
                ],
              },
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    const enrich = new EnrichService({
      apiKey: "test-key",
      primaryModel: "gemini-3.1-flash-lite",
      overflowModels: ["gemma-4-31b-it"],
      limiter: customLimiter,
      cache: aiCache,
      fetchFn: mockFetch,
    });

    // Item 1 consumes the 1 RPD of gemini-3.1-flash-lite
    const card1 = await enrich.enrichOne({ id: "item-1", text: "First item about Rust" });
    expect(card1.enrich_model).toBe("gemini-3.1-flash-lite");
    expect(card1.prompt_version).toBe("v1");

    // Re-running Item 1 hits disk cache without consuming any RPD or calling fetch!
    const card1Cached = await enrich.enrichOne({ id: "item-1", text: "First item about Rust" });
    expect(card1Cached.summary).toBe("Summary from gemini-3.1-flash-lite");
    expect(calledModels.length).toBe(1);
    expect(aiCache.hits).toBe(1);

    // Item 2 exceeds gemini-3.1-flash-lite's RPD=1 -> automatically overflows to gemma-4-31b-it!
    const card2 = await enrich.enrichOne({ id: "item-2", text: "Second item about WebGPU" });
    expect(card2.enrich_model).toBe("gemma-4-31b-it");
    expect(card2.summary).toBe("Summary from gemma-4-31b-it");

    // Verify daily quota reset resumes primary model
    customLimiter.bucket("gemini-3.1-flash-lite").resetDailyQuota();
    const card3 = await enrich.enrichOne({ id: "item-3", text: "Third item after midnight reset" });
    expect(card3.enrich_model).toBe("gemini-3.1-flash-lite");
  });

  it("loads 60 vectors into VectorIndex and fuses FTS + Vector results with RRF", () => {
    db.importFixturesFromFile(datasetPath);
    const index = new VectorIndex("gemini-embedding-2@768", 768);
    const loaded = index.loadFromDB(db);
    expect(loaded).toBe(60);

    const webgpuVec = index.vec("x:1000000000000000008");
    expect(webgpuVec).toBeTruthy();

    // Top-5 vector neighbors of WebGPU 5,000 frames item
    const top5 = index.topK(webgpuVec!, 5, {
      exclude: new Set(["x:1000000000000000008"]),
    });
    expect(top5.length).toBe(5);
    expect(top5.some((m) => m.id === "x:1000000000000000009")).toBe(true); // CanvasBox HTML-in-Canvas
    expect(top5[0].score).toBeGreaterThan(0.75);

    // Test RRF fusion between FTS and Vector rankings
    const ftsHits = db.search({ query: "Canvas", limit: 10 });
    const vecHits = top5.map((m) => ({ id: m.id }));
    const fused = reciprocalRankFusion([{ items: ftsHits }, { items: vecHits }]);
    expect(fused.length).toBeGreaterThan(0);
    // Item appearing in BOTH FTS and Vector top results gets boosted to the top
    expect(fused[0].sources.length).toBe(2);
  });

  it("runs Related pipeline in < 300ms without rerank and supports Decisions rerank with pair_cache", async () => {
    db.importFixturesFromFile(datasetPath);
    const index = new VectorIndex("gemini-embedding-2@768", 768);
    index.loadFromDB(db);

    // 1. Feature fusion + MMR mode (no network call) -> must be < 300ms
    const resNoRerank = await findRelatedItems({
      db,
      index,
      targetId: "x:1000000000000000008",
      k: 8,
      mode: "feature-fusion",
    });

    expect(resNoRerank.elapsedMs).toBeLessThan(300);
    expect(resNoRerank.items.length).toBe(8);
    expect(resNoRerank.items[0].signals.length).toBeGreaterThan(0);

    // 2. Decisions rerank mode with mocked gemini-decision-1 response -> verifies pair_cache persistence
    let decisionApiCalls = 0;
    const mockDecisionFetch = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      decisionApiCalls++;
      const body = JSON.parse(String(init?.body || "{}"));
      const answers: Record<string, any> = {};
      for (const qKey of Object.keys(body.questions || {})) {
        // Give high score (2.6) to CanvasBox (1000000000000000009), moderate (1.4) to others
        const isTop = qKey.includes("1000000000000000009");
        answers[qKey] = {
          type: "score",
          score: isTop ? 2.6 : 1.4,
          confidence: 0.91,
          probabilities: { "0": 0.02, "1": 0.1, "2": 0.5, "3": 0.38 },
        };
      }
      return new Response(JSON.stringify({ answers }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;

    const decisions = new DecisionsClient({
      apiKey: "test-key",
      limiter,
      cache: aiCache,
      fetchFn: mockDecisionFetch,
    });

    const resRerank1 = await findRelatedItems({
      db,
      index,
      decisions,
      targetId: "x:1000000000000000008",
      k: 8,
      mode: "decisions-rerank",
    });

    expect(decisionApiCalls).toBe(1);
    expect(resRerank1.items[0].id).toBe("x:1000000000000000009");
    expect(resRerank1.items[0].decisionScore).toBe(2.6);
    expect(resRerank1.items[0].signals[0]).toContain("精判高相关");

    // Second call for the same target hits SQLite `pair_cache` -> 0 additional API calls!
    const resRerank2 = await findRelatedItems({
      db,
      index,
      decisions,
      targetId: "x:1000000000000000008",
      k: 8,
      mode: "decisions-rerank",
    });
    expect(decisionApiCalls).toBe(1);
    expect(resRerank2.items[0].id).toBe("x:1000000000000000009");
  });

  it("proposes taxonomy via k-means, runs three-tier classifier, and supports active learning confirmation", async () => {
    db.importFixturesFromFile(datasetPath);
    const index = new VectorIndex("gemini-embedding-2@768", 768);
    index.loadFromDB(db);

    const proposed = proposeClusterTaxonomySync(db, index, { saveToDb: true });
    expect(proposed.categories.length).toBeGreaterThanOrEqual(5);
    expect(proposed.categories.length).toBeLessThanOrEqual(10);
    expect(proposed.nameSource).toBe("topics");
    expect(proposed.clusteringStats.totalVectors).toBe(60);

    // Run classifier without Decisions first (kNN + Centroid + Pending)
    const classified1 = await classifyItems({
      db,
      index,
      useDecisionsFallback: false,
    });
    expect(classified1.total).toBe(60);
    const autoAssigned = classified1.bySource.knn + classified1.bySource.centroid;
    expect(autoAssigned).toBeGreaterThan(40);

    // Check pending items queue
    const pendingBefore = db.listPendingItems(10);
    if (pendingBefore.length > 0) {
      const targetPending = pendingBefore[0];
      const altCategory =
        proposed.categories.find((c) => c.id !== targetPending.suggestedCategoryId)?.id ||
        proposed.categories[0].id;
      // User confirms category for the most uncertain item
      db.updateItem(targetPending.id, { category: altCategory });

      const classified2 = await classifyItems({
        db,
        index,
        useDecisionsFallback: false,
      });
      expect(classified2.bySource.user).toBe(1);
      const [updatedItem] = db.getItems([targetPending.id]);
      expect(updatedItem.category).toBe(altCategory);
    }
  });
});
