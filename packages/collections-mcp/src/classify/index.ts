import { DecisionsClient, DecisionChoiceAnswer } from "../ai/decisions.js";
import { buildRepresentationText } from "../ai/enrich.js";
import { l2Normalize } from "../ai/embedder/index.js";
import { QuotaExhaustedError } from "../ai/limiter.js";
import {
  ClusterDigest,
  ClusterName,
  normalizeNames,
  slugifyCategoryId,
  TaxonomyNamer,
} from "../ai/taxonomy-namer.js";
import { CategoryNameSource, CollectionsDB } from "../db/index.js";
import { cosineSimilarity, VectorIndex } from "../index/vector.js";

export interface CategoryDef {
  id: string;
  name: string;
  description: string;
  examples: string[]; // seed item IDs
  sort: number;
  name_source?: CategoryNameSource;
}

export interface ClassificationAssignment {
  itemId: string;
  categoryId: string;
  score: number;
  source: "user" | "knn" | "centroid" | "decision" | "pending";
  runnerUpCategoryId?: string;
  runnerUpScore?: number;
}

export interface ClassifierThresholds {
  knnMinLabeled: number;
  knnProb: number;
  centroidHighProb: number;
  centroidMargin: number;
  decisionConfidence: number;
  knnTemp: number;
  centroidTemp: number;
}

export const DEFAULT_CLASSIFIER_THRESHOLDS: ClassifierThresholds = {
  knnMinLabeled: 6,
  knnProb: 0.58,
  centroidHighProb: 0.34,
  centroidMargin: 0.08,
  decisionConfidence: 0.52,
  knnTemp: 0.05,
  centroidTemp: 0.035,
};

/**
 * Spherical k-means++ clustering with deterministic seed & silhouette score calculation.
 */
export function sphericalKMeans(
  vectors: Float32Array[],
  k: number,
  maxIter = 25,
): { assignments: number[]; centroids: Float32Array[]; silhouette: number } {
  const n = vectors.length;
  const dim = vectors[0]?.length || 768;
  if (n === 0 || k <= 1) {
    return {
      assignments: new Array(n).fill(0),
      centroids: vectors.length ? [l2Normalize(vectors[0])] : [],
      silhouette: 0,
    };
  }

  // Deterministic k-means++ initialization (farthest-first from index 0)
  const centroids: Float32Array[] = [l2Normalize(vectors[0])];
  const minSimToCentroid = new Float32Array(n).fill(-1);

  for (let c = 1; c < k; c++) {
    const lastC = centroids[c - 1];
    let farthestIdx = 0;
    let smallestSim = Infinity;
    for (let i = 0; i < n; i++) {
      const sim = cosineSimilarity(vectors[i], lastC);
      if (c === 1 || sim > minSimToCentroid[i]) {
        minSimToCentroid[i] = sim;
      }
      if (minSimToCentroid[i] < smallestSim) {
        smallestSim = minSimToCentroid[i];
        farthestIdx = i;
      }
    }
    centroids.push(l2Normalize(vectors[farthestIdx]));
  }

  const assignments = new Array<number>(n).fill(0);

  for (let iter = 0; iter < maxIter; iter++) {
    let changed = 0;
    for (let i = 0; i < n; i++) {
      let bestC = 0;
      let bestSim = -Infinity;
      for (let c = 0; c < k; c++) {
        const sim = cosineSimilarity(vectors[i], centroids[c]);
        if (sim > bestSim) {
          bestSim = sim;
          bestC = c;
        }
      }
      if (assignments[i] !== bestC) {
        assignments[i] = bestC;
        changed++;
      }
    }

    // Recompute centroids
    const sums = Array.from({ length: k }, () => new Float32Array(dim));
    const counts = new Array<number>(k).fill(0);
    for (let i = 0; i < n; i++) {
      const c = assignments[i];
      counts[c]++;
      const v = vectors[i];
      const sum = sums[c];
      for (let d = 0; d < dim; d++) sum[d] += v[d];
    }
    for (let c = 0; c < k; c++) {
      if (counts[c] > 0) {
        centroids[c] = l2Normalize(sums[c]);
      }
    }
    if (changed === 0) break;
  }

  // Approximate cosine silhouette score
  let totalSil = 0;
  for (let i = 0; i < n; i++) {
    const ownC = assignments[i];
    const aDist = 1 - cosineSimilarity(vectors[i], centroids[ownC]);
    let minOtherDist = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === ownC) continue;
      const d = 1 - cosineSimilarity(vectors[i], centroids[c]);
      if (d < minOtherDist) minOtherDist = d;
    }
    const denom = Math.max(aDist, minOtherDist);
    totalSil += denom > 0 ? (minOtherDist - aDist) / denom : 0;
  }

  return {
    assignments,
    centroids,
    silhouette: totalSil / n,
  };
}

function softmaxProbs(
  scores: Array<{ id: string; rawScore: number }>,
  temperature: number,
): Array<{ id: string; prob: number; rawScore: number }> {
  if (scores.length === 0) return [];
  const scaled = scores.map((s) => s.rawScore / temperature);
  const maxVal = Math.max(...scaled);
  const exps = scaled.map((v) => Math.exp(v - maxVal));
  const sumExp = exps.reduce((a, b) => a + b, 0) || 1;
  return scores
    .map((s, i) => ({
      id: s.id,
      prob: exps[i] / sumExp,
      rawScore: s.rawScore,
    }))
    .sort((a, b) => b.prob - a.prob);
}

export interface ClusterTaxonomyOptions {
  namer?: TaxonomyNamer;
  /** When true, missing/failing namer throws instead of falling back to topTopics temporary names. */
  strictNaming?: boolean;
  /** When true (manual re-propose), resets the persisted naming retry attempt counter. */
  resetNamingMeta?: boolean;
  /** Candidate k values; each needs at least `minItemsPerCluster * k` vectors. */
  kRange?: number[];
  minItemsPerCluster?: number;
  seedsPerCluster?: number;
  samplesForNaming?: number;
  saveToDb?: boolean;
}

export interface UserLabelRemapStats {
  /** User labels whose category id still exists — untouched. */
  kept: number;
  /** Moved to the new category holding the majority of their old category's items; still `source='user'`. */
  remapped: number;
  /** Old category split across new ones without a majority — demoted to automatic classification. */
  toPending: number;
}

export interface ClusterTaxonomyResult {
  categories: CategoryDef[];
  clusteringStats: {
    bestK: number;
    silhouette: number;
    totalVectors: number;
    clusterSizes: number[];
  };
  nameSource: "llm" | "topics";
  namerModel: string | null;
  fallbackReason?: string;
  userLabels: UserLabelRemapStats;
}

export const DEFAULT_CLUSTER_K_RANGE = [5, 6, 7, 8, 9, 10];
const DEFAULT_MIN_ITEMS_PER_CLUSTER = 5;

export const TAXONOMY_NAMING_META_KEY = "taxonomy_naming";
export const MAX_TAXONOMY_NAMING_ATTEMPTS = 5;

export interface TaxonomyNamingMeta {
  attempts: number;
  retryAfter: string;
  lastError: string;
}

function computeNamingRetryAfter(attempts: number, err: unknown, nowMs = Date.now()): string {
  if (err instanceof QuotaExhaustedError && err.resetAt) {
    return err.resetAt;
  }
  const delayMs = Math.min(60 * 60_000, 60_000 * Math.pow(2, Math.max(0, attempts - 1)));
  return new Date(nowMs + delayMs).toISOString();
}

function recordNamingFailure(
  db: CollectionsDB,
  err: unknown,
  opts?: { hadApiKey?: boolean; resetAttempts?: boolean; nowMs?: number },
): TaxonomyNamingMeta {
  if (opts?.hadApiKey === false) {
    const meta: TaxonomyNamingMeta = {
      attempts: 0,
      retryAfter: new Date(0).toISOString(),
      lastError: "no API key configured for taxonomy namer",
    };
    db.setAppMeta(TAXONOMY_NAMING_META_KEY, meta);
    return meta;
  }
  const nowMs = opts?.nowMs ?? Date.now();
  const prev = opts?.resetAttempts
    ? 0
    : (db.getAppMeta<TaxonomyNamingMeta>(TAXONOMY_NAMING_META_KEY)?.attempts ?? 0);
  const attempts = prev + 1;
  const meta: TaxonomyNamingMeta = {
    attempts,
    retryAfter: computeNamingRetryAfter(attempts, err, nowMs),
    lastError: err instanceof Error ? err.message : String(err || "unknown taxonomy naming error"),
  };
  db.setAppMeta(TAXONOMY_NAMING_META_KEY, meta);
  return meta;
}

/**
 * Returns true when temporary `topTopics` category names are present in DB and can be retried with LLM naming.
 */
export function shouldRetryTaxonomyNaming(
  db: CollectionsDB,
  namer?: TaxonomyNamer,
  nowMs = Date.now(),
): boolean {
  if (!namer?.isAvailable()) return false;
  if (!db.listCategories().some((c) => c.name_source === "topics")) return false;
  const meta = db.getAppMeta<TaxonomyNamingMeta>(TAXONOMY_NAMING_META_KEY);
  const attempts = typeof meta?.attempts === "number" ? meta.attempts : 0;
  if (attempts >= MAX_TAXONOMY_NAMING_ATTEMPTS) return false;
  if (!meta?.retryAfter) return true;
  const retryAtMs = Date.parse(meta.retryAfter);
  return Number.isNaN(retryAtMs) || nowMs >= retryAtMs;
}

/** Smallest vector count that lets `proposeClusterTaxonomy` run with the given options. */
export function minVectorsForClusterTaxonomy(
  opts?: Pick<ClusterTaxonomyOptions, "kRange" | "minItemsPerCluster">,
): number {
  const kRange = opts?.kRange ?? DEFAULT_CLUSTER_K_RANGE;
  return Math.min(...kRange) * (opts?.minItemsPerCluster ?? DEFAULT_MIN_ITEMS_PER_CLUSTER);
}

function buildClusterDigests(
  db: CollectionsDB,
  clusters: Array<{ m: Array<{ id: string; sim: number }> }>,
  allIds: string[],
  samplesPer: number,
): ClusterDigest[] {
  const itemsById = new Map<string, Record<string, any>>();
  for (let i = 0; i < allIds.length; i += 400) {
    for (const it of db.getItems(allIds.slice(i, i + 400)) as Array<Record<string, any>>) {
      itemsById.set(String(it.id), it);
    }
  }
  const topicsOf = (id: string): string[] => {
    const t = itemsById.get(id)?.enriched_card?.topics;
    return Array.isArray(t) ? t.map(String) : [];
  };

  return clusters.map(({ m }, idx) => {
    const freq = new Map<string, number>();
    for (const { id } of m) {
      for (const t of topicsOf(id)) {
        const key = t.trim();
        if (key) freq.set(key, (freq.get(key) || 0) + 1);
      }
    }
    const topTopics = [...freq.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 12)
      .map(([topic, count]) => ({ topic, count }));
    const samples = m.slice(0, samplesPer).map(({ id }) => {
      const it = itemsById.get(id);
      return {
        id,
        title: it?.title ?? null,
        summary: it?.enriched_card?.summary ?? it?.excerpt ?? null,
        topics: topicsOf(id).slice(0, 5),
      };
    });
    return { cluster: idx + 1, size: m.length, topTopics, samples };
  });
}

function clusterAndBuildDigests(
  db: CollectionsDB,
  index: VectorIndex,
  opts: Pick<ClusterTaxonomyOptions, "kRange" | "minItemsPerCluster" | "samplesForNaming">,
) {
  const minPer = opts.minItemsPerCluster ?? DEFAULT_MIN_ITEMS_PER_CLUSTER;
  const samplesPer = opts.samplesForNaming ?? 10;

  const ids = index.allIds().filter((id) => index.vec(id));
  const vectors = ids.map((id) => index.vec(id)!);
  const kCandidates = (opts.kRange ?? DEFAULT_CLUSTER_K_RANGE).filter(
    (k) => k >= 2 && vectors.length >= k * minPer,
  );
  if (kCandidates.length === 0) {
    throw new Error(
      `Not enough vectors for cluster taxonomy: ${vectors.length} < ${minVectorsForClusterTaxonomy(opts)}`,
    );
  }

  let best: { k: number; res: ReturnType<typeof sphericalKMeans> } | null = null;
  for (const k of kCandidates) {
    const res = sphericalKMeans(vectors, k);
    if (!best || res.silhouette > best.res.silhouette) best = { k, res };
  }
  const { assignments, centroids, silhouette } = best!.res;

  // Group members per cluster, drop empty clusters, order by size (largest first)
  const members = centroids.map(() => [] as Array<{ id: string; sim: number }>);
  assignments.forEach((c, i) => {
    members[c].push({ id: ids[i], sim: cosineSimilarity(vectors[i], centroids[c]) });
  });
  const clusters = members
    .map((m, c) => ({ c, m: m.sort((a, b) => b.sim - a.sim) }))
    .filter((x) => x.m.length > 0)
    .sort((a, b) => b.m.length - a.m.length);

  const digests = buildClusterDigests(db, clusters, ids, samplesPer);
  return {
    clusters,
    digests,
    clusteringStats: {
      bestK: best!.k,
      silhouette: Number(silhouette.toFixed(4)),
      totalVectors: vectors.length,
      clusterSizes: clusters.map((x) => x.m.length),
    },
  };
}

function finalizeClusterTaxonomy(
  db: CollectionsDB,
  clusters: Array<{ m: Array<{ id: string; sim: number }> }>,
  names: ClusterName[],
  opts: { seedsPerCluster?: number; saveToDb?: boolean },
): { categories: CategoryDef[]; userLabels: UserLabelRemapStats } {
  const seedsPer = opts.seedsPerCluster ?? 8;
  const categories: CategoryDef[] = clusters.map(({ m }, idx) => ({
    id: names[idx].id,
    name: names[idx].name,
    description: names[idx].description,
    examples: m.slice(0, seedsPer).map((x) => x.id),
    sort: idx + 1,
    name_source: names[idx].nameSource ?? "llm",
  }));

  const memberCategory = new Map<string, string>();
  clusters.forEach(({ m }, idx) => {
    for (const { id } of m) memberCategory.set(id, categories[idx].id);
  });

  const userLabels =
    opts.saveToDb === false
      ? { kept: 0, remapped: 0, toPending: 0 }
      : replaceTaxonomy(db, categories, memberCategory);

  return { categories, userLabels };
}

/**
 * Synchronous cluster taxonomy initialization using `topTopics` temporary names (`name_source = 'topics'`).
 * Used on MCP startup so clusters exist immediately while LLM naming runs asynchronously via `retryTaxonomyNaming`.
 */
export function proposeClusterTaxonomySync(
  db: CollectionsDB,
  index: VectorIndex,
  opts: Omit<ClusterTaxonomyOptions, "namer" | "strictNaming" | "resetNamingMeta"> = {},
): ClusterTaxonomyResult {
  const { clusters, digests, clusteringStats } = clusterAndBuildDigests(db, index, opts);
  const names = normalizeNames([], digests);
  const { categories, userLabels } = finalizeClusterTaxonomy(db, clusters, names, opts);

  if (opts.saveToDb !== false) {
    db.setAppMeta(TAXONOMY_NAMING_META_KEY, {
      attempts: 0,
      retryAfter: new Date(0).toISOString(),
      lastError: "pending initial LLM naming",
    } satisfies TaxonomyNamingMeta);
  }

  return {
    categories,
    clusteringStats,
    nameSource: "topics",
    namerModel: null,
    fallbackReason: "deferred initial LLM naming",
    userLabels,
  };
}

/**
 * Data-driven taxonomy (embedding-related-classify.md §4.1):
 * ① spherical k-means over all vectors, k chosen by silhouette
 * ② the items closest to each cluster centroid + the cluster's top topics go to an LLM in ONE request,
 *    which returns {id, name, description} per cluster (falling back to top-3 `topTopics` if unavailable/failing)
 * ③ categories = named clusters, seed examples = the items nearest each centroid
 * When saved, user-confirmed labels pointing at removed categories are carried over (see `replaceTaxonomy`).
 */
export async function proposeClusterTaxonomy(
  db: CollectionsDB,
  index: VectorIndex,
  opts: ClusterTaxonomyOptions = {},
): Promise<ClusterTaxonomyResult> {
  const { clusters, digests, clusteringStats } = clusterAndBuildDigests(db, index, opts);

  const namerAvailable = Boolean(opts.namer?.isAvailable());
  if (!namerAvailable) {
    const err = new Error("no API key configured for taxonomy namer");
    if (opts.strictNaming) throw err;
    const names = normalizeNames([], digests);
    const { categories, userLabels } = finalizeClusterTaxonomy(db, clusters, names, opts);
    if (opts.saveToDb !== false) {
      recordNamingFailure(db, err, { hadApiKey: false, resetAttempts: opts.resetNamingMeta });
    }
    return {
      categories,
      clusteringStats,
      nameSource: "topics",
      namerModel: null,
      fallbackReason: err.message,
      userLabels,
    };
  }

  try {
    const { names, model } = await opts.namer!.nameClusters(digests);
    const { categories, userLabels } = finalizeClusterTaxonomy(db, clusters, names, opts);
    const hasTopics = categories.some((c) => c.name_source === "topics");
    if (opts.saveToDb !== false) {
      if (!hasTopics) {
        db.deleteAppMeta(TAXONOMY_NAMING_META_KEY);
      } else {
        recordNamingFailure(db, new Error("LLM omitted one or more clusters"), {
          hadApiKey: true,
          resetAttempts: opts.resetNamingMeta,
        });
      }
    }
    const allTopics = categories.every((c) => c.name_source === "topics");
    return {
      categories,
      clusteringStats,
      nameSource: allTopics ? "topics" : "llm",
      namerModel: model,
      ...(hasTopics ? { fallbackReason: "LLM omitted one or more clusters" } : {}),
      userLabels,
    };
  } catch (err) {
    if (opts.strictNaming) throw err;
    const message = err instanceof Error ? err.message : String(err);
    const names = normalizeNames([], digests);
    const { categories, userLabels } = finalizeClusterTaxonomy(db, clusters, names, opts);
    if (opts.saveToDb !== false) {
      recordNamingFailure(db, err, { hadApiKey: true, resetAttempts: opts.resetNamingMeta });
    }
    return {
      categories,
      clusteringStats,
      nameSource: "topics",
      namerModel: null,
      fallbackReason: message,
      userLabels,
    };
  }
}

/**
 * Retries LLM naming for existing categories whose `name_source = 'topics'`, without re-running k-means.
 * Preserves any `'user'`-edited or already `'llm'`-named categories untouched and remaps `item_category` IDs atomically.
 */
export async function retryTaxonomyNaming(
  db: CollectionsDB,
  index: VectorIndex,
  namer: TaxonomyNamer,
  opts?: { samplesForNaming?: number; force?: boolean; nowMs?: number },
): Promise<{
  attempted: boolean;
  updated: number;
  categories: CategoryDef[];
  namerModel?: string;
  error?: string;
}> {
  const cats = db.listCategories();
  if (!namer.isAvailable() || !cats.some((c) => c.name_source === "topics")) {
    return { attempted: false, updated: 0, categories: cats };
  }
  if (!opts?.force && !shouldRetryTaxonomyNaming(db, namer, opts?.nowMs)) {
    return { attempted: false, updated: 0, categories: cats };
  }

  const samplesPer = opts?.samplesForNaming ?? 10;
  const centroids = computeCategoryCentroids(db, index);
  const membersByCat = new Map<string, Set<string>>();
  const assignedIds = new Set<string>();
  for (const cat of cats) {
    const set = new Set<string>();
    for (const ex of cat.examples || []) {
      if (index.has(ex)) {
        set.add(ex);
        assignedIds.add(ex);
      }
    }
    membersByCat.set(cat.id, set);
  }

  const itemCatRows = db.db
    .prepare("SELECT item_id, category_id FROM item_category")
    .all() as Array<{ item_id: string; category_id: string }>;
  for (const r of itemCatRows) {
    const set = membersByCat.get(r.category_id);
    if (set && index.has(r.item_id)) {
      set.add(r.item_id);
      assignedIds.add(r.item_id);
    }
  }

  for (const id of index.allIds()) {
    if (assignedIds.has(id)) continue;
    const v = index.vec(id);
    if (!v) continue;
    let bestCatId: string | null = null;
    let bestSim = -Infinity;
    for (const [catId, cVec] of centroids.entries()) {
      const sim = cosineSimilarity(v, cVec);
      if (sim > bestSim) {
        bestSim = sim;
        bestCatId = catId;
      }
    }
    if (bestCatId) membersByCat.get(bestCatId)?.add(id);
  }

  const clusterGroups: Array<{ m: Array<{ id: string; sim: number }> }> = [];
  const digestItemIds = new Set<string>();
  for (const cat of cats) {
    const cVec = centroids.get(cat.id);
    const memberIds = [...(membersByCat.get(cat.id) ?? [])];
    const m = memberIds
      .map((id) => {
        const v = index.vec(id);
        const sim = v && cVec ? cosineSimilarity(v, cVec) : 0;
        return { id, sim };
      })
      .sort((a, b) => b.sim - a.sim);
    for (const entry of m) digestItemIds.add(entry.id);
    clusterGroups.push({ m });
  }

  const digests = buildClusterDigests(db, clusterGroups, [...digestItemIds], samplesPer);

  let rawNames: ClusterName[];
  let model: string;
  try {
    const res = await namer.nameClusters(digests);
    rawNames = res.names;
    model = res.model;
  } catch (err) {
    recordNamingFailure(db, err, { hadApiKey: true, nowMs: opts?.nowMs });
    return {
      attempted: true,
      updated: 0,
      categories: cats,
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const byCluster = new Map<number, ClusterName>();
  rawNames.forEach((n, idx) => {
    const num = Number(n.cluster ?? idx + 1);
    if (Number.isInteger(num) && !byCluster.has(num)) {
      byCluster.set(num, n);
    }
  });

  const usedIds = new Set<string>();
  const usedNames = new Set<string>();
  for (const c of cats) {
    if (c.name_source !== "topics") {
      usedIds.add(c.id);
      usedNames.add(c.name);
    }
  }

  const nextCategories: CategoryDef[] = [];
  const idRemap: Array<{ oldId: string; newId: string }> = [];
  let updated = 0;

  cats.forEach((c, idx) => {
    if (c.name_source !== "topics") {
      nextCategories.push({ ...c });
      return;
    }

    const proposed = byCluster.get(idx + 1);
    const rawProposedName = String(proposed?.name ?? "").trim();
    const resolvedSource: CategoryNameSource =
      proposed && (proposed.nameSource ?? (rawProposedName ? "llm" : "topics")) === "llm"
        ? "llm"
        : "topics";

    let newName = rawProposedName || c.name;
    if (usedNames.has(newName)) {
      let suffix = idx + 1;
      while (usedNames.has(`${newName} ${suffix}`)) suffix++;
      newName = `${newName} ${suffix}`;
    }
    usedNames.add(newName);

    let newId = slugifyCategoryId(proposed?.id) || c.id;
    if (usedIds.has(newId)) {
      let suffix = idx + 1;
      while (usedIds.has(`${newId}-${suffix}`)) suffix++;
      newId = `${newId}-${suffix}`;
    }
    usedIds.add(newId);

    const newDescription = String(proposed?.description ?? "").trim() || c.description;
    if (resolvedSource === "llm") updated++;
    if (newId !== c.id) idRemap.push({ oldId: c.id, newId });

    nextCategories.push({
      id: newId,
      name: newName,
      description: newDescription,
      examples: c.examples,
      sort: c.sort,
      name_source: resolvedSource,
    });
  });

  const tx = db.db.transaction(() => {
    if (idRemap.length > 0) {
      const updateStmt = db.db.prepare("UPDATE item_category SET category_id = ? WHERE category_id = ?");
      idRemap.forEach(({ oldId }, k) => {
        updateStmt.run(`__remap_${k}`, oldId);
      });
      idRemap.forEach(({ newId }, k) => {
        updateStmt.run(newId, `__remap_${k}`);
      });
    }
    db.saveCategories(nextCategories);
  });
  tx();

  const stillPendingTopics = nextCategories.some((c) => c.name_source === "topics");
  if (stillPendingTopics) {
    recordNamingFailure(db, new Error("LLM omitted one or more clusters"), {
      hadApiKey: true,
      nowMs: opts?.nowMs,
    });
  } else {
    db.deleteAppMeta(TAXONOMY_NAMING_META_KEY);
  }

  return {
    attempted: true,
    updated,
    categories: db.listCategories(),
    namerModel: model,
  };
}

/**
 * Atomically swaps in a new taxonomy without silently dropping user decisions:
 * - user labels whose category id survives are kept
 * - user labels of a removed category move to the new category that holds a strict majority (> 50%)
 *   of that old category's user-labelled items, keeping `source='user'`
 * - otherwise they lose `source='user'` and restart as `pending` on their own new cluster;
 *   the next classifyItems run treats them like any other automatic assignment
 * - non-user assignments to removed categories are cleared (the next classifyItems run refills them)
 */
export function replaceTaxonomy(
  db: CollectionsDB,
  categories: CategoryDef[],
  memberCategory: Map<string, string>,
): UserLabelRemapStats {
  const newIds = new Set(categories.map((c) => c.id));
  const stats: UserLabelRemapStats = { kept: 0, remapped: 0, toPending: 0 };

  const tx = db.db.transaction(() => {
    const userRows = db.db
      .prepare("SELECT item_id, category_id FROM item_category WHERE source = 'user'")
      .all() as Array<{ item_id: string; category_id: string }>;

    const orphanedByOldCat = new Map<string, string[]>();
    for (const r of userRows) {
      if (newIds.has(r.category_id)) {
        stats.kept++;
        continue;
      }
      if (!orphanedByOldCat.has(r.category_id)) orphanedByOldCat.set(r.category_id, []);
      orphanedByOldCat.get(r.category_id)!.push(r.item_id);
    }

    const setRow = db.db.prepare(
      "UPDATE item_category SET category_id = ?, source = ?, score = ? WHERE item_id = ?",
    );
    const deleteRow = db.db.prepare("DELETE FROM item_category WHERE item_id = ?");

    for (const itemIds of orphanedByOldCat.values()) {
      const votes = new Map<string, number>();
      for (const id of itemIds) {
        const c = memberCategory.get(id);
        if (c) votes.set(c, (votes.get(c) || 0) + 1);
      }
      const [majorityCat, majorityCount] = [...votes.entries()].sort((a, b) => b[1] - a[1])[0] ?? [null, 0];
      const hasMajority = majorityCat !== null && majorityCount / itemIds.length > 0.5;

      for (const id of itemIds) {
        if (hasMajority) {
          setRow.run(majorityCat, "user", 1.0, id);
          stats.remapped++;
          continue;
        }
        const target = memberCategory.get(id) ?? majorityCat;
        if (target) {
          setRow.run(target, "pending", 0, id);
          stats.toPending++;
        } else {
          // No vector and no sibling to follow — leave it unclassified rather than pointing at a dead id
          deleteRow.run(id);
          stats.toPending++;
        }
      }
    }

    const placeholders = categories.map(() => "?").join(", ");
    db.db
      .prepare(
        `DELETE FROM item_category WHERE source != 'user' AND category_id NOT IN (${placeholders || "''"})`,
      )
      .run(...categories.map((c) => c.id));

    db.saveCategories(categories);
  });
  tx();
  return stats;
}

/**
 * Computes weighted category centroids (embedding-related-classify.md §4.2):
 * centroid(c) = normalize( 3 * mean(user-confirmed items) + 1 * mean(seed example items) )
 */
export function computeCategoryCentroids(
  db: CollectionsDB,
  index: VectorIndex,
): Map<string, Float32Array> {
  const categories = db.listCategories();
  const userConfirmedRows = db.db
    .prepare(
      "SELECT item_id, category_id FROM item_category WHERE source = 'user'",
    )
    .all() as Array<{ item_id: string; category_id: string }>;

  const userByCat = new Map<string, string[]>();
  for (const r of userConfirmedRows) {
    if (!userByCat.has(r.category_id)) userByCat.set(r.category_id, []);
    userByCat.get(r.category_id)!.push(r.item_id);
  }

  const centroids = new Map<string, Float32Array>();
  const dim = index.dim;

  for (const cat of categories) {
    const sum = new Float32Array(dim);
    let totalWeight = 0;

    // 3x weight for user-confirmed items
    const userIds = userByCat.get(cat.id) || [];
    for (const id of userIds) {
      const v = index.vec(id);
      if (v) {
        for (let d = 0; d < dim; d++) sum[d] += 3 * v[d];
        totalWeight += 3;
      }
    }

    // 1x weight for seed examples
    for (const id of cat.examples || []) {
      const v = index.vec(id);
      if (v) {
        for (let d = 0; d < dim; d++) sum[d] += 1 * v[d];
        totalWeight += 1;
      }
    }

    if (totalWeight > 0) {
      centroids.set(cat.id, l2Normalize(sum));
    }
  }

  return centroids;
}

/**
 * Three-Tier Classifier (embedding-related-classify.md §4.2):
 * - Preserves `source = 'user'` overrides unconditionally
 * - ① kNN softmax voting over labeled (user + seed) neighbors
 * - ② Category Centroid softmax + margin check
 * - ③ Optional Decisions API (`gemini-decision-1`) `choice` fallback
 * - ④ Pending tray (`source = 'pending'`) for active learning confirmation
 */
export async function classifyItems(opts: {
  db: CollectionsDB;
  index: VectorIndex;
  decisions?: DecisionsClient;
  itemIds?: string[];
  useDecisionsFallback?: boolean;
  thresholds?: Partial<ClassifierThresholds>;
}): Promise<{
  total: number;
  bySource: Record<string, number>;
  assignments: ClassificationAssignment[];
}> {
  const { db, index, decisions } = opts;
  const TAU: ClassifierThresholds = {
    ...DEFAULT_CLASSIFIER_THRESHOLDS,
    ...(opts.thresholds || {}),
  };
  const useDecisions =
    opts.useDecisionsFallback ?? Boolean(decisions?.isAvailable());

  const categories = db.listCategories();
  if (categories.length === 0) {
    return {
      total: 0,
      bySource: { user: 0, knn: 0, centroid: 0, decision: 0, pending: 0 },
      assignments: [],
    };
  }

  const centroids = computeCategoryCentroids(db, index);

  // Build labeled reference map: user-confirmed + category seed examples
  const labeledMap = new Map<string, string>();
  for (const cat of categories) {
    for (const seedId of cat.examples || []) {
      labeledMap.set(seedId, cat.id);
    }
  }
  const existingRows = db.db
    .prepare("SELECT item_id, category_id, score, source FROM item_category")
    .all() as Array<{
    item_id: string;
    category_id: string;
    score: number;
    source: string;
  }>;
  const userConfirmedMap = new Map<string, string>();
  for (const r of existingRows) {
    if (r.source === "user") {
      userConfirmedMap.set(r.item_id, r.category_id);
      labeledMap.set(r.item_id, r.category_id);
    }
  }

  const targetIds = opts.itemIds ?? index.allIds();
  const assignments: ClassificationAssignment[] = [];
  const bySource: Record<string, number> = {
    user: 0,
    knn: 0,
    centroid: 0,
    decision: 0,
    pending: 0,
  };

  const criteriaObj: Record<string, string> = {};
  for (const cat of categories) {
    criteriaObj[cat.id] = `${cat.name}：${cat.description}`;
  }

  // Batch items needing Decisions fallback (up to 15 items per single Decisions API request!)
  const needDecisions: Array<{
    itemId: string;
    fallbackCat: string;
    fallbackProb: number;
    runnerUpCat?: string;
    runnerUpProb?: number;
  }> = [];

  for (const itemId of targetIds) {
    if (userConfirmedMap.has(itemId)) {
      const catId = userConfirmedMap.get(itemId)!;
      bySource.user++;
      assignments.push({
        itemId,
        categoryId: catId,
        score: 1.0,
        source: "user",
      });
      continue;
    }

    const vec = index.vec(itemId);
    if (!vec) continue;

    // ① kNN Voting among labeled neighbors in top-15
    const neighbors = index.topK(vec, 15, {
      exclude: new Set([itemId]),
      filter: (id) => labeledMap.has(id),
    });

    if (neighbors.length >= TAU.knnMinLabeled) {
      const voteWeights = new Map<string, number>();
      let totalW = 0;
      for (const nb of neighbors) {
        const catId = labeledMap.get(nb.id)!;
        const w = Math.exp(nb.score / TAU.knnTemp);
        voteWeights.set(catId, (voteWeights.get(catId) || 0) + w);
        totalW += w;
      }
      const sortedVotes = [...voteWeights.entries()]
        .map(([catId, w]) => ({ id: catId, prob: w / (totalW || 1) }))
        .sort((a, b) => b.prob - a.prob);

      if (sortedVotes[0] && sortedVotes[0].prob >= TAU.knnProb) {
        bySource.knn++;
        assignments.push({
          itemId,
          categoryId: sortedVotes[0].id,
          score: Number(sortedVotes[0].prob.toFixed(4)),
          source: "knn",
          runnerUpCategoryId: sortedVotes[1]?.id,
          runnerUpScore: sortedVotes[1] ? Number(sortedVotes[1].prob.toFixed(4)) : undefined,
        });
        continue;
      }
    }

    // ② Centroid Method
    const centroidScores: Array<{ id: string; rawScore: number }> = [];
    for (const [catId, cVec] of centroids.entries()) {
      centroidScores.push({ id: catId, rawScore: cosineSimilarity(vec, cVec) });
    }
    const probs = softmaxProbs(centroidScores, TAU.centroidTemp);
    const top1 = probs[0] ?? { id: categories[0].id, prob: 0 };
    const top2 = probs[1] ?? { id: categories[1]?.id || top1.id, prob: 0 };

    if (
      top1.prob >= TAU.centroidHighProb &&
      top1.prob - top2.prob >= TAU.centroidMargin
    ) {
      bySource.centroid++;
      assignments.push({
        itemId,
        categoryId: top1.id,
        score: Number(top1.prob.toFixed(4)),
        source: "centroid",
        runnerUpCategoryId: top2.id,
        runnerUpScore: Number(top2.prob.toFixed(4)),
      });
      continue;
    }

    if (useDecisions && decisions?.isAvailable()) {
      needDecisions.push({
        itemId,
        fallbackCat: top1.id,
        fallbackProb: top1.prob,
        runnerUpCat: top2.id,
        runnerUpProb: top2.prob,
      });
    } else {
      bySource.pending++;
      assignments.push({
        itemId,
        categoryId: top1.id,
        score: Number(top1.prob.toFixed(4)),
        source: "pending",
        runnerUpCategoryId: top2.id,
        runnerUpScore: Number(top2.prob.toFixed(4)),
      });
    }
  }

  // ③ Decisions API choice fallback (batched 15 items per request for speed & quota efficiency)
  if (needDecisions.length > 0 && decisions?.isAvailable()) {
    const itemsMeta = new Map<string, Record<string, any>>();
    const needIds = needDecisions.map((n) => n.itemId);
    for (let i = 0; i < needIds.length; i += 400) {
      for (const it of db.getItems(needIds.slice(i, i + 400)) as Array<Record<string, any>>) {
        itemsMeta.set(String(it.id), it);
      }
    }

    const BATCH = 15;
    for (let i = 0; i < needDecisions.length; i += BATCH) {
      const slice = needDecisions.slice(i, i + BATCH);
      const inputBlocks: string[] = [];
      const questions: Record<
        string,
        { type: "choice"; instructions: string; criteria: Record<string, string> }
      > = {};

      slice.forEach((entry, idx) => {
        const it = itemsMeta.get(entry.itemId);
        const repr = it
          ? buildRepresentationText({
              title: it.title,
              excerpt: it.excerpt,
              note: it.note,
              card: it.enriched_card,
            })
          : entry.itemId;
        inputBlocks.push(`=== 条目 #${idx + 1} [${entry.itemId}] ===\n${repr}`);
        questions[`q_${idx}`] = {
          type: "choice",
          instructions: `请判断【条目 #${idx + 1} [${entry.itemId}]】最适合归入哪一类？`,
          criteria: criteriaObj,
        };
      });

      try {
        const res = await decisions.create({
          input: inputBlocks.join("\n\n"),
          questions,
          priority: "background",
        });

        slice.forEach((entry, idx) => {
          const ans = res.answers?.[`q_${idx}`] as DecisionChoiceAnswer | undefined;
          if (
            ans &&
            ans.choice &&
            criteriaObj[ans.choice] &&
            ans.confidence >= TAU.decisionConfidence
          ) {
            bySource.decision++;
            assignments.push({
              itemId: entry.itemId,
              categoryId: ans.choice,
              score: Number(ans.confidence.toFixed(4)),
              source: "decision",
              runnerUpCategoryId: entry.fallbackCat,
              runnerUpScore: Number(entry.fallbackProb.toFixed(4)),
            });
          } else {
            bySource.pending++;
            assignments.push({
              itemId: entry.itemId,
              categoryId: ans?.choice && criteriaObj[ans.choice] ? ans.choice : entry.fallbackCat,
              score: Number((ans?.confidence ?? entry.fallbackProb).toFixed(4)),
              source: "pending",
              runnerUpCategoryId: entry.runnerUpCat,
              runnerUpScore: entry.runnerUpProb ? Number(entry.runnerUpProb.toFixed(4)) : undefined,
            });
          }
        });
      } catch {
        // Fallback to pending if Decisions fails
        for (const entry of slice) {
          bySource.pending++;
          assignments.push({
            itemId: entry.itemId,
            categoryId: entry.fallbackCat,
            score: Number(entry.fallbackProb.toFixed(4)),
            source: "pending",
            runnerUpCategoryId: entry.runnerUpCat,
            runnerUpScore: entry.runnerUpProb ? Number(entry.runnerUpProb.toFixed(4)) : undefined,
          });
        }
      }
    }
  }

  // Persist assignments in a single SQLite transaction
  const stmt = db.db.prepare(
    `INSERT INTO item_category (item_id, category_id, score, source)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET
       category_id = CASE WHEN item_category.source = 'user' THEN item_category.category_id ELSE excluded.category_id END,
       score = CASE WHEN item_category.source = 'user' THEN item_category.score ELSE excluded.score END,
       source = CASE WHEN item_category.source = 'user' THEN item_category.source ELSE excluded.source END`,
  );
  const tx = db.db.transaction(() => {
    for (const a of assignments) {
      stmt.run(a.itemId, a.categoryId, a.score, a.source);
    }
  });
  tx();

  return {
    total: assignments.length,
    bySource,
    assignments,
  };
}
