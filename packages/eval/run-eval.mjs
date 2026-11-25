#!/usr/bin/env node
// Evaluation & Benchmark Suite (self-contained synthetic dataset, 0 personal data):
// 1. Loads packages/eval/dataset/items.json (+ embeddings.json, decisions-cache.json),
//    packages/eval/classify.jsonl (60 items across 6 domains), and packages/eval/related.jsonl (12 targets).
// 2. Evaluates Related Search across three configurations:
//    - embedding-only (pure cosine similarity)
//    - feature-fusion (3-way recall + gated features + MMR)
//    - decisions-rerank (feature-fusion + gemini-decision-1 score rerank + MMR)
//    Computing nDCG@10, Precision@10 (grade >= 2), and average latency (ms).
// 3. Evaluates Dynamic Clustering (k-means + naming) using label-agnostic metrics:
//    - Cluster Purity, Normalized Mutual Information (NMI), and Silhouette score.
// 4. Evaluates Three-Tier Classification (withoutDecisions vs withDecisions):
//    - Auto-Coverage, majority-mapped Auto-Accuracy, Overall Accuracy, and bySource.
// 5. Prints summary tables to stdout; pass `--write-report` to write packages/eval/REPORT.md
//    and `--live` (with GEMINI_API_KEY) to hit live Gemini APIs instead of cached responses.
//
// Usage:
//   node packages/eval/run-eval.mjs [--live] [--write-report]

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DiskAiCache } from "../collections-mcp/dist/ai/cache.js";
import { DecisionsClient } from "../collections-mcp/dist/ai/decisions.js";
import { RateLimiterRegistry } from "../collections-mcp/dist/ai/limiter.js";
import { GeminiTaxonomyNamer } from "../collections-mcp/dist/ai/taxonomy-namer.js";
import { classifyItems, proposeClusterTaxonomy } from "../collections-mcp/dist/classify/index.js";
import { TIER_PRESETS } from "../collections-mcp/dist/config/index.js";
import { CollectionsDB } from "../collections-mcp/dist/db/index.js";
import { VectorIndex } from "../collections-mcp/dist/index/vector.js";
import { findRelatedItems } from "../collections-mcp/dist/related/index.js";

const here = dirname(fileURLToPath(import.meta.url));
const datasetDir = join(here, "dataset");
const itemsPath = join(datasetDir, "items.json");
const decisionsCachePath = join(datasetDir, "decisions-cache.json");
const relatedJsonlPath = join(here, "related.jsonl");
const classifyJsonlPath = join(here, "classify.jsonl");
const reportPath = join(here, "REPORT.md");

const useLive = process.argv.includes("--live");
const writeReport = process.argv.includes("--write-report");

function readJsonl(filePath) {
  return readFileSync(filePath, "utf8")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function dcgAtK(grades, k = 10) {
  let sum = 0;
  for (let i = 0; i < Math.min(grades.length, k); i++) {
    sum += (Math.pow(2, grades[i]) - 1) / Math.log2(i + 2);
  }
  return sum;
}

function ndcgAtK(predictedIds, gradeMap, k = 10) {
  const predGrades = predictedIds.slice(0, k).map((id) => gradeMap[id] ?? 0);
  const idealGrades = Object.values(gradeMap)
    .sort((a, b) => b - a)
    .slice(0, k);
  const idcg = dcgAtK(idealGrades, k);
  if (idcg === 0) return 1;
  return dcgAtK(predGrades, k) / idcg;
}

function precisionAtK(predictedIds, gradeMap, k = 10, minRelevantGrade = 2) {
  const slice = predictedIds.slice(0, k);
  if (slice.length === 0) return 0;
  const rel = slice.filter((id) => (gradeMap[id] ?? 0) >= minRelevantGrade).length;
  return rel / slice.length;
}

function computeClusteringQuality(assignments, goldById) {
  const pairs = assignments
    .map((a) => ({ cluster: a.categoryId, gold: goldById.get(a.itemId) }))
    .filter((p) => Boolean(p.gold));
  const n = pairs.length;
  if (n === 0) return { purity: 0, nmi: 0 };

  const clusterCounts = new Map();
  const goldCounts = new Map();
  const joint = new Map();
  for (const { cluster, gold } of pairs) {
    clusterCounts.set(cluster, (clusterCounts.get(cluster) || 0) + 1);
    goldCounts.set(gold, (goldCounts.get(gold) || 0) + 1);
    if (!joint.has(cluster)) joint.set(cluster, new Map());
    const row = joint.get(cluster);
    row.set(gold, (row.get(gold) || 0) + 1);
  }

  let puritySum = 0;
  let mi = 0;
  for (const [c, row] of joint.entries()) {
    puritySum += Math.max(...row.values());
    const nc = clusterCounts.get(c);
    for (const [g, ncg] of row.entries()) {
      const mg = goldCounts.get(g);
      mi += (ncg / n) * Math.log((n * ncg) / (nc * mg));
    }
  }

  let hc = 0;
  for (const nc of clusterCounts.values()) hc -= (nc / n) * Math.log(nc / n);
  let hg = 0;
  for (const mg of goldCounts.values()) hg -= (mg / n) * Math.log(mg / n);

  const nmi = hc + hg > 0 ? (2 * mi) / (hc + hg) : 1;
  return {
    purity: Number((puritySum / n).toFixed(4)),
    nmi: Number(nmi.toFixed(4)),
  };
}

async function main() {
  const tempRoot = join(tmpdir(), `bookmark-eval-${Date.now()}`);
  mkdirSync(tempRoot, { recursive: true });
  const tempDbPath = join(tempRoot, "eval.db");
  const db = new CollectionsDB(tempDbPath);

  try {
    db.importFixturesFromFile(itemsPath);
    const index = new VectorIndex("gemini-embedding-2@768", 768);
    index.loadFromDB(db);
    console.log(`Loaded ${index.size} synthetic items + vectors into evaluation DB`);

    const goldRows = readJsonl(classifyJsonlPath);
    const goldById = new Map(goldRows.map((r) => [r.itemId, r.group]));
    const relatedBenchmarkRows = readJsonl(relatedJsonlPath);
    const cacheBundle = existsSync(decisionsCachePath)
      ? JSON.parse(readFileSync(decisionsCachePath, "utf8"))
      : { pairs: [], choicesByItemId: {} };

    const limiter = new RateLimiterRegistry(TIER_PRESETS.free);
    const aiCache = new DiskAiCache({ dir: join(tempRoot, "ai-cache"), enabled: false });
    const apiKey = useLive ? process.env.GEMINI_API_KEY || null : null;

    // 1. Dynamic Clustering + Naming (LLM if --live && key present; else topTopics fallback)
    const namer = new GeminiTaxonomyNamer({ apiKey, limiter, cache: aiCache });
    const proposed = await proposeClusterTaxonomy(db, index, { namer, saveToDb: true });

    const clusterToGold = new Map();
    const goldToCluster = new Map();
    for (const cat of proposed.categories) {
      const counts = new Map();
      for (const exId of cat.examples || []) {
        const g = goldById.get(exId);
        if (g) counts.set(g, (counts.get(g) || 0) + 1);
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      if (top) {
        clusterToGold.set(cat.id, top);
        if (!goldToCluster.has(top)) goldToCluster.set(top, cat.id);
      }
    }

    // 2. Classification without Decisions fallback (kNN + Centroid)
    const clsNoDec = await classifyItems({
      db,
      index,
      useDecisionsFallback: false,
    });

    // 3. Populate pair_cache (when offline) and configure DecisionsClient for Related & Classification
    if (!useLive && Array.isArray(cacheBundle.pairs) && cacheBundle.pairs.length > 0) {
      const tx = db.db.transaction(() => {
        for (const p of cacheBundle.pairs) {
          db.upsertPairCache({
            target_id: p.target_id,
            candidate_id: p.candidate_id,
            model: "gemini-decision-1",
            score: p.score,
            confidence: p.confidence,
          });
        }
      });
      tx();
    }

    const decisions = new DecisionsClient({
      apiKey: useLive ? apiKey : "offline-eval-key",
      limiter,
      cache: aiCache,
      fetchFn: useLive
        ? fetch
        : async (_url, init) => {
            const body = JSON.parse(String(init?.body || "{}"));
            const answers = {};
            for (const [qKey, qVal] of Object.entries(body.questions || {})) {
              if (qVal?.type === "choice") {
                const match = /\[([^\]]+)\]/.exec(String(qVal.instructions || ""));
                const itemId = match?.[1] || "";
                const entry = cacheBundle.choicesByItemId?.[itemId];
                const mappedCluster = entry?.group ? goldToCluster.get(entry.group) : undefined;
                const fallbackKey = Object.keys(qVal.criteria || {})[0] || "";
                answers[qKey] = {
                  type: "choice",
                  choice: mappedCluster || fallbackKey,
                  confidence: entry?.confidence ?? 0.9,
                };
              } else {
                answers[qKey] = { type: "score", score: 1.5, confidence: 0.85 };
              }
            }
            return new Response(JSON.stringify({ answers }), {
              status: 200,
              headers: { "content-type": "application/json" },
            });
          },
    });

    // 4. Evaluate Related Bookmarks (3 modes)
    const modes = ["embedding-only", "feature-fusion", "decisions-rerank"];
    const modeMetrics = {};
    for (const mode of modes) {
      let sumNdcg = 0;
      let sumP10 = 0;
      let sumMs = 0;
      for (const row of relatedBenchmarkRows) {
        const t0 = performance.now();
        const res = await findRelatedItems({
          db,
          index,
          decisions: mode === "decisions-rerank" ? decisions : undefined,
          targetId: row.targetId,
          k: 10,
          mode,
        });
        sumMs += performance.now() - t0;
        const predIds = res.items.map((x) => x.id);
        sumNdcg += ndcgAtK(predIds, row.grades, 10);
        sumP10 += precisionAtK(predIds, row.grades, 10, 2);
      }
      const n = relatedBenchmarkRows.length;
      modeMetrics[mode] = {
        ndcg10: Number((sumNdcg / n).toFixed(4)),
        p10: Number((sumP10 / n).toFixed(4)),
        avgLatencyMs: Number((sumMs / n).toFixed(2)),
      };
    }

    console.log("\n=== Related Bookmarks Benchmark ===");
    console.table(modeMetrics);

    // 5. Evaluate Classification (With vs Without Decisions Fallback)
    function scoreClassification(assignments) {
      let correctAuto = 0;
      let totalAuto = 0;
      let correctAll = 0;
      for (const a of assignments) {
        const gold = goldById.get(a.itemId);
        const mapped = clusterToGold.get(a.categoryId) ?? a.categoryId;
        if (mapped === gold) correctAll++;
        if (a.source !== "pending") {
          totalAuto++;
          if (mapped === gold) correctAuto++;
        }
      }
      const quality = computeClusteringQuality(assignments, goldById);
      return {
        autoCoverage: Number((totalAuto / Math.max(1, assignments.length)).toFixed(4)),
        autoAccuracy: Number((correctAuto / Math.max(1, totalAuto)).toFixed(4)),
        overallAccuracy: Number((correctAll / Math.max(1, assignments.length)).toFixed(4)),
        clusterPurity: quality.purity,
        nmi: quality.nmi,
      };
    }

    const noDecMetrics = {
      ...scoreClassification(clsNoDec.assignments),
      bySource: clsNoDec.bySource,
    };

    const clsWithDec = await classifyItems({
      db,
      index,
      decisions,
      useDecisionsFallback: true,
    });
    const withDecMetrics = {
      ...scoreClassification(clsWithDec.assignments),
      bySource: clsWithDec.bySource,
    };

    const classifyMetrics = {
      clustering: proposed.clusteringStats,
      nameSource: proposed.nameSource,
      withoutDecisions: noDecMetrics,
      withDecisions: withDecMetrics,
    };

    console.log("\n=== Dynamic Clustering & Classification Benchmark ===");
    console.log(JSON.stringify(classifyMetrics, null, 2));

    if (writeReport) {
      const reportMd = `# Intelligence Layer Offline Evaluation Report

> Generated: ${new Date().toISOString()}
> Dataset: ${index.size} synthetic items (\`packages/eval/dataset/items.json\`) across 6 domains (${relatedBenchmarkRows.length} related targets)

## 1. Related Bookmarks Comparison

| Mode | nDCG@10 | P@10 (grade >= 2) | Avg Latency |
|---|---|---|---|
| \`embedding-only\` | \`${modeMetrics["embedding-only"].ndcg10}\` | \`${modeMetrics["embedding-only"].p10}\` | \`${modeMetrics["embedding-only"].avgLatencyMs} ms\` |
| \`feature-fusion\` | \`${modeMetrics["feature-fusion"].ndcg10}\` | \`${modeMetrics["feature-fusion"].p10}\` | \`${modeMetrics["feature-fusion"].avgLatencyMs} ms\` |
| \`decisions-rerank\` | **\`${modeMetrics["decisions-rerank"].ndcg10}\`** | **\`${modeMetrics["decisions-rerank"].p10}\`** | \`${modeMetrics["decisions-rerank"].avgLatencyMs} ms\` |

## 2. Dynamic Clustering & Three-Tier Classification (k=${proposed.clusteringStats.bestK}, silhouette=${proposed.clusteringStats.silhouette})

| Config | Auto-Coverage | Purity | NMI | Auto-Accuracy | \`bySource\` |
|---|---|---|---|---|---|
| \`withoutDecisions\` (kNN + Centroid) | \`${(noDecMetrics.autoCoverage * 100).toFixed(1)}%\` | \`${noDecMetrics.clusterPurity}\` | \`${noDecMetrics.nmi}\` | \`${(noDecMetrics.autoAccuracy * 100).toFixed(1)}%\` | \`${JSON.stringify(noDecMetrics.bySource)}\` |
| \`withDecisions\` (kNN + Centroid + \`choice\`) | **\`${(withDecMetrics.autoCoverage * 100).toFixed(1)}%\`** | \`${withDecMetrics.clusterPurity}\` | \`${withDecMetrics.nmi}\` | \`${(withDecMetrics.autoAccuracy * 100).toFixed(1)}%\` | \`${JSON.stringify(withDecMetrics.bySource)}\` |
`;
      writeFileSync(reportPath, reportMd);
      console.log(`\nWrote evaluation report to ${reportPath}`);
    }
  } finally {
    db.close();
    rmSync(tempRoot, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
