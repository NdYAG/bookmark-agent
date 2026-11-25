import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DiskAiCache } from "../src/ai/cache.js";
import { QuotaExhaustedError, RateLimiterRegistry } from "../src/ai/limiter.js";
import {
  ClusterDigest,
  GeminiTaxonomyNamer,
  normalizeNames,
  TaxonomyNamer,
} from "../src/ai/taxonomy-namer.js";
import {
  classifyItems,
  MAX_TAXONOMY_NAMING_ATTEMPTS,
  proposeClusterTaxonomy,
  proposeClusterTaxonomySync,
  retryTaxonomyNaming,
  shouldRetryTaxonomyNaming,
  TAXONOMY_NAMING_META_KEY,
  TaxonomyNamingMeta,
} from "../src/classify/index.js";
import { TIER_PRESETS } from "../src/config/index.js";
import { CollectionsDB } from "../src/db/index.js";
import { VectorIndex } from "../src/index/vector.js";

const DIM = 16;
const GROUPS = ["rust", "design", "cooking"] as const;
const PER_GROUP = 12;

/** Three well-separated synthetic topics: one-hot axis per group plus small deterministic noise. */
function seedCorpus(db: CollectionsDB, index: VectorIndex): Map<string, string> {
  const groupOf = new Map<string, string>();
  GROUPS.forEach((g, gi) => {
    for (let i = 0; i < PER_GROUP; i++) {
      const id = `x:${g}-${i}`;
      db.upsertItem({
        id,
        source: "x",
        source_item_id: `${g}-${i}`,
        url: `https://x.com/u/status/${g}-${i}`,
        title: `${g} note ${i}`,
        excerpt: `about ${g}`,
        raw: JSON.stringify({
          enrichedCard: {
            summary: `${g} summary ${i}`,
            topics: [`${g}-topic`, `${g}-core`],
            kind: "tutorial",
            lang: "zh",
            imageCaptions: [],
          },
        }),
      });
      const v = new Array(DIM).fill(0).map((_, d) => Math.sin((gi + 1) * (i + 1) * (d + 1)) * 0.05);
      v[gi] += 1;
      index.upsert(id, v);
      groupOf.set(id, g);
    }
  });
  return groupOf;
}

/** Names each cluster after the group its samples come from, so assertions can check alignment. */
function fakeNamer(calls: ClusterDigest[][]): TaxonomyNamer {
  return {
    model: "fake-namer",
    isAvailable: () => true,
    async nameClusters(clusters) {
      calls.push(clusters);
      const names = clusters.map((c) => {
        const group = c.samples[0].id.split(":")[1].split("-")[0];
        return { cluster: c.cluster, id: `${group}-topic`, name: `${group} 分类`, description: `${group} 相关内容` };
      });
      return { names, model: "fake-namer" };
    },
  };
}

describe("Cluster taxonomy (k-means + LLM naming + topics fallback & retry)", () => {
  let tempDir: string;
  let db: CollectionsDB;
  let index: VectorIndex;
  let groupOf: Map<string, string>;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "collections-mcp-taxonomy-"));
    db = new CollectionsDB(join(tempDir, "collections.db"));
    index = new VectorIndex("test@16", DIM);
    groupOf = seedCorpus(db, index);
  });

  afterEach(() => {
    db.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("leaves items uncategorized when no categories exist (e.g. < 25 vectors)", async () => {
    const res = await classifyItems({ db, index, useDecisionsFallback: false });
    expect(res).toEqual({
      total: 0,
      bySource: { user: 0, knn: 0, centroid: 0, decision: 0, pending: 0 },
      assignments: [],
    });
    expect(db.listCategories()).toEqual([]);

    const st = db.stats();
    expect(st.by_category).toEqual([{ category: "uncategorized", count: GROUPS.length * PER_GROUP }]);
    expect(db.search({ query: "", category: "uncategorized", limit: 100 })).toHaveLength(
      GROUPS.length * PER_GROUP,
    );
    expect(db.appListItems({ pageSize: 100, filter: { category: "uncategorized" } }).total).toBe(
      GROUPS.length * PER_GROUP,
    );
  });

  it("names k-means clusters in one namer call and seeds categories from centroid neighbours", async () => {
    const calls: ClusterDigest[][] = [];
    const res = await proposeClusterTaxonomy(db, index, {
      namer: fakeNamer(calls),
      kRange: [2, 3, 4],
      minItemsPerCluster: 3,
    });

    expect(calls).toHaveLength(1);
    expect(res.nameSource).toBe("llm");
    expect(res.namerModel).toBe("fake-namer");
    expect(res.clusteringStats.bestK).toBe(3);
    expect(res.clusteringStats.clusterSizes).toEqual([PER_GROUP, PER_GROUP, PER_GROUP]);
    expect(res.categories.map((c) => c.id).sort()).toEqual(["cooking-topic", "design-topic", "rust-topic"]);
    for (const cat of res.categories) {
      expect(cat.examples).toHaveLength(8);
      const group = cat.id.replace("-topic", "");
      expect(cat.examples.every((id) => groupOf.get(id) === group)).toBe(true);
    }
    const saved = db.listCategories();
    expect(saved.map((c) => c.name).sort()).toEqual(["cooking 分类", "design 分类", "rust 分类"]);
    expect(saved.every((c) => c.name_source === "llm")).toBe(true);
    expect(db.getAppMeta(TAXONOMY_NAMING_META_KEY)).toBeNull();

    const classified = await classifyItems({ db, index, useDecisionsFallback: false });
    expect(classified.total).toBe(GROUPS.length * PER_GROUP);
    for (const a of classified.assignments) {
      expect(a.categoryId).toBe(`${groupOf.get(a.itemId)}-topic`);
    }
  });

  it("falls back to topTopics temporary names and tracks retry state in app_meta", async () => {
    // 1. No API key configured -> attempts stays 0 so retry activates as soon as a key appears
    const offline = await proposeClusterTaxonomy(db, index, {
      kRange: [3],
      minItemsPerCluster: 3,
    });
    expect(offline.nameSource).toBe("topics");
    expect(offline.namerModel).toBeNull();
    expect(offline.fallbackReason).toContain("no API key");
    expect(db.listCategories().every((c) => c.name_source === "topics")).toBe(true);
    expect(db.listCategories().map((c) => c.name).join(" ")).toContain("rust-topic");

    const meta0 = db.getAppMeta<TaxonomyNamingMeta>(TAXONOMY_NAMING_META_KEY);
    expect(meta0?.attempts).toBe(0);
    expect(shouldRetryTaxonomyNaming(db, undefined)).toBe(false);
    expect(shouldRetryTaxonomyNaming(db, fakeNamer([]))).toBe(true);

    // 2. Failing namer -> exponential backoff and QuotaExhaustedError resetAt handling
    const brokenNamer: TaxonomyNamer = {
      model: "broken-namer",
      isAvailable: () => true,
      async nameClusters() {
        throw new Error("503 service unavailable");
      },
    };
    const now0 = Date.parse("2026-11-25T10:00:00.000Z");
    const retried1 = await retryTaxonomyNaming(db, index, brokenNamer, { nowMs: now0 });
    expect(retried1.attempted).toBe(true);
    expect(retried1.updated).toBe(0);
    const meta1 = db.getAppMeta<TaxonomyNamingMeta>(TAXONOMY_NAMING_META_KEY)!;
    expect(meta1.attempts).toBe(1);
    expect(meta1.retryAfter).toBe("2026-11-25T10:01:00.000Z");
    expect(shouldRetryTaxonomyNaming(db, brokenNamer, now0 + 30_000)).toBe(false);
    expect(shouldRetryTaxonomyNaming(db, brokenNamer, now0 + 60_000)).toBe(true);

    const quotaNamer: TaxonomyNamer = {
      model: "quota-namer",
      isAvailable: () => true,
      async nameClusters() {
        throw new QuotaExhaustedError("quota-namer", "2026-11-26T08:00:00.000Z");
      },
    };
    await retryTaxonomyNaming(db, index, quotaNamer, { nowMs: now0 + 60_000 });
    const meta2 = db.getAppMeta<TaxonomyNamingMeta>(TAXONOMY_NAMING_META_KEY)!;
    expect(meta2.attempts).toBe(2);
    expect(meta2.retryAfter).toBe("2026-11-26T08:00:00.000Z");

    // 3. Respects MAX_TAXONOMY_NAMING_ATTEMPTS cap
    db.setAppMeta(TAXONOMY_NAMING_META_KEY, {
      attempts: MAX_TAXONOMY_NAMING_ATTEMPTS,
      retryAfter: new Date(0).toISOString(),
      lastError: "exhausted",
    });
    expect(shouldRetryTaxonomyNaming(db, fakeNamer([]))).toBe(false);

    // 4. strictNaming propagates errors instead of falling back
    await expect(
      proposeClusterTaxonomy(db, index, {
        namer: brokenNamer,
        strictNaming: true,
        kRange: [3],
        minItemsPerCluster: 3,
      }),
    ).rejects.toThrow(/503 service unavailable/);
  });

  it("preserves user-edited categories while upgrading remaining topics categories on retry", async () => {
    const init = proposeClusterTaxonomySync(db, index, {
      kRange: [3],
      minItemsPerCluster: 3,
    });
    expect(init.nameSource).toBe("topics");
    await classifyItems({ db, index, useDecisionsFallback: false });

    // Confirm one item in the first cluster as user-confirmed
    const catsBefore = db.listCategories();
    const rustCat = catsBefore.find((c) => c.examples.some((id) => id.startsWith("x:rust-")))!;
    db.updateItem("x:rust-0", { category: rustCat.id });

    // User renames ONLY rustCat in settings; the other two remain untouched
    db.saveCategories(
      catsBefore.map((c) => ({
        id: c.id,
        name: c.id === rustCat.id ? "我的 Rust 专栏" : c.name,
        description: c.description,
        examples: c.examples,
        sort: c.sort,
      })),
    );
    const afterUserEdit = db.listCategories();
    expect(afterUserEdit.find((c) => c.id === rustCat.id)?.name_source).toBe("user");
    expect(afterUserEdit.filter((c) => c.id !== rustCat.id).every((c) => c.name_source === "topics")).toBe(true);

    const retryCalls: ClusterDigest[][] = [];
    const retryRes = await retryTaxonomyNaming(db, index, fakeNamer(retryCalls), { force: true });
    expect(retryRes.attempted).toBe(true);
    expect(retryRes.updated).toBe(2);
    expect(retryCalls).toHaveLength(1);

    const finalCats = db.listCategories();
    const keptUserCat = finalCats.find((c) => c.id === rustCat.id);
    expect(keptUserCat?.name).toBe("我的 Rust 专栏");
    expect(keptUserCat?.name_source).toBe("user");
    expect(finalCats.filter((c) => c.id !== rustCat.id).every((c) => c.name_source === "llm")).toBe(true);
    expect(finalCats.map((c) => c.id)).toEqual(
      expect.arrayContaining([rustCat.id, "cooking-topic", "design-topic"]),
    );

    // User-confirmed item and automatic assignments remain valid with zero dangling references
    expect((db.getItems(["x:rust-0"])[0] as any).category).toBe(rustCat.id);
    expect((db.getItems(["x:design-0"])[0] as any).category).toBe("design-topic");
    expect((db.getItems(["x:cooking-0"])[0] as any).category).toBe("cooking-topic");
    const dangling = db.db
      .prepare("SELECT COUNT(*) AS n FROM item_category WHERE category_id NOT IN (SELECT id FROM categories)")
      .get() as { n: number };
    expect(dangling.n).toBe(0);
    expect(db.getAppMeta(TAXONOMY_NAMING_META_KEY)).toBeNull();
  });

  it("carries user-confirmed labels over when the taxonomy is replaced", async () => {
    // Seed an initial taxonomy and confirm three rust items under one category
    db.saveCategories([
      { id: "old-rust", name: "Old Rust", description: "Rust", sort: 1, name_source: "llm" },
      { id: "old-mixed", name: "Old Mixed", description: "Mixed", sort: 2, name_source: "llm" },
    ]);
    const rustIds = [...groupOf.entries()].filter(([, g]) => g === "rust").map(([id]) => id);
    for (const id of rustIds.slice(0, 3)) db.updateItem(id, { category: "old-rust" });
    // old-mixed gets one design + one cooking item: a 50/50 split has no strict majority
    db.updateItem("x:design-0", { category: "old-mixed" });
    db.updateItem("x:cooking-0", { category: "old-mixed" });

    const proposal = await proposeClusterTaxonomy(db, index, {
      namer: fakeNamer([]),
      kRange: [3],
      minItemsPerCluster: 3,
    });

    expect(proposal.nameSource).toBe("llm");
    expect(proposal.userLabels).toEqual({ kept: 0, remapped: 3, toPending: 2 });
    const rows = db.db
      .prepare("SELECT item_id, category_id, source FROM item_category WHERE source = 'user' ORDER BY item_id")
      .all() as Array<{ item_id: string; category_id: string; source: string }>;
    expect(rows.filter((r) => r.item_id.startsWith("x:rust")).every((r) => r.category_id === "rust-topic")).toBe(true);
    expect(rows.map((r) => r.item_id)).not.toContain("x:design-0");
    const cooking = db.db
      .prepare("SELECT category_id, source FROM item_category WHERE item_id = 'x:cooking-0'")
      .get();
    expect(cooking).toEqual({ category_id: "cooking-topic", source: "pending" });

    // No assignment may point at a category that no longer exists
    const dangling = db.db
      .prepare("SELECT COUNT(*) AS n FROM item_category WHERE category_id NOT IN (SELECT id FROM categories)")
      .get() as { n: number };
    expect(dangling.n).toBe(0);
  });

  it("demotes user labels to automatic when their old category splits without a majority", async () => {
    db.saveCategories([
      { id: "old-mixed", name: "Old Mixed", description: "Mixed", sort: 1, name_source: "llm" },
    ]);
    db.updateItem("x:rust-0", { category: "old-mixed" });
    db.updateItem("x:design-0", { category: "old-mixed" });
    db.updateItem("x:cooking-0", { category: "old-mixed" });

    const proposal = await proposeClusterTaxonomy(db, index, {
      namer: fakeNamer([]),
      kRange: [3],
      minItemsPerCluster: 3,
    });
    expect(proposal.userLabels).toEqual({ kept: 0, remapped: 0, toPending: 3 });
    const row = db.db
      .prepare("SELECT category_id, source FROM item_category WHERE item_id = 'x:design-0'")
      .get() as { category_id: string; source: string };
    expect(row).toEqual({ category_id: "design-topic", source: "pending" });
  });
});

describe("Taxonomy namer", () => {
  const digests: ClusterDigest[] = [
    { cluster: 1, size: 10, topTopics: [{ topic: "Rust", count: 7 }], samples: [{ id: "a", title: "Rust async" }] },
    { cluster: 2, size: 8, topTopics: [{ topic: "UI动效", count: 5 }], samples: [{ id: "b", title: "动效" }] },
    { cluster: 3, size: 6, topTopics: [{ topic: "食谱", count: 4 }], samples: [{ id: "c", title: "菜谱" }] },
  ];

  it("normalizes ids, de-duplicates names and fills clusters the model skipped", () => {
    const names = normalizeNames(
      [
        { cluster: 1, id: "Rust Async!!", name: "Rust 编程", description: "Rust 语言与异步运行时" },
        { cluster: 2, id: "rust-async", name: "Rust 编程", description: "" },
      ],
      digests,
    );
    expect(names.map((n) => n.id)).toEqual(["rust-async", "rust-async-2", "cluster-3"]);
    expect(names[1].name).toBe("Rust 编程 2");
    expect(names[1].description).toBe("主要涉及：UI动效");
    expect(names[2].name).toBe("食谱");
    expect(names.map((n) => n.nameSource)).toEqual(["llm", "llm", "topics"]);
  });

  it("sends one request with all clusters and caches the answer", async () => {
    const tempDir = mkdtempSync(join(tmpdir(), "collections-mcp-namer-"));
    let calls = 0;
    let lastPrompt = "";
    const fetchFn = (async (_url: RequestInfo | URL, init?: RequestInit) => {
      calls++;
      lastPrompt = JSON.parse(String(init?.body)).contents[0].parts[0].text;
      const answer = digests.map((d) => ({ cluster: d.cluster, id: `c${d.cluster}`, name: `名称${d.cluster}`, description: "d" }));
      return new Response(
        JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(answer) }] } }] }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as typeof fetch;
    try {
      const namer = new GeminiTaxonomyNamer({
        apiKey: "test-key",
        limiter: new RateLimiterRegistry(TIER_PRESETS.free),
        cache: new DiskAiCache({ dir: tempDir }),
        fetchFn,
      });
      const first = await namer.nameClusters(digests);
      const second = await namer.nameClusters(digests);
      expect(calls).toBe(1);
      expect(first.names.map((n) => n.name)).toEqual(["名称1", "名称2", "名称3"]);
      expect(second.names).toEqual(first.names);
      expect(lastPrompt).toContain("## 簇 3（共 6 条）");
      expect(lastPrompt).toContain("Rust(7)");
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
