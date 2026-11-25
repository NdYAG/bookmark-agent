import { DecisionsClient, DecisionScoreAnswer } from "../ai/decisions.js";
import { buildRepresentationText } from "../ai/enrich.js";
import { CollectionsDB } from "../db/index.js";
import { cosineSimilarity, VectorIndex } from "../index/vector.js";

export type RelatedMode = "embedding-only" | "feature-fusion" | "decisions-rerank";

export interface RelatedItemOutput {
  id: string;
  title: string | null;
  author: string | null;
  excerpt: string;
  url: string;
  category: string | null;
  score: number;
  cos: number;
  decisionScore?: number;
  decisionConfidence?: number;
  signals: string[];
}

export interface RelatedResult {
  targetId: string;
  mode: RelatedMode;
  elapsedMs: number;
  items: RelatedItemOutput[];
  duplicates: Array<{ id: string; url: string; cos: number }>;
}

const RELATED_SCORE_CRITERIA = [
  "无关：主题、领域和解决的问题完全不同",
  "弱相关：同属宽泛大类（如都和AI或编程有关），但具体议题无直接联系",
  "相关：讨论相似的具体主题、技术方向、工具类别或思维方法，放在一起看有启发或互补价值",
  "强相关：直接讨论同一个具体问题、同一类核心工具/技术或同一套方法论",
];

function jaccard(arrA: string[] = [], arrB: string[] = []): { score: number; shared: string[] } {
  const norm = (s: string) => s.toLowerCase().trim();
  const mapA = new Map<string, string>();
  for (const x of arrA) {
    const n = norm(x);
    if (n) mapA.set(n, x);
  }
  const setB = new Set(arrB.map(norm).filter(Boolean));
  if (!mapA.size || !setB.size) return { score: 0, shared: [] };

  const shared: string[] = [];
  for (const [normKey, orig] of mapA.entries()) {
    if (setB.has(normKey)) shared.push(orig);
  }
  const score = shared.length / (mapA.size + setB.size - shared.length);
  return { score, shared };
}

function daysBetween(isoA?: string | null, isoB?: string | null): number {
  if (!isoA || !isoB) return 999;
  const d = Math.abs(Date.parse(isoA) - Date.parse(isoB)) / (1000 * 3600 * 24);
  return Number.isNaN(d) ? 999 : d;
}

function mmrDiversify<T extends { id: string; score: number }>(
  candidates: T[],
  index: VectorIndex,
  lambda = 0.78,
  k = 12,
): T[] {
  const selected: T[] = [];
  const pool = [...candidates];

  while (selected.length < k && pool.length > 0) {
    let bestIdx = 0;
    let bestMmr = -Infinity;

    for (let i = 0; i < pool.length; i++) {
      const c = pool[i];
      const cv = index.vec(c.id);
      let maxSim = 0;
      if (cv) {
        for (const s of selected) {
          const sv = index.vec(s.id);
          if (sv) {
            const sim = cosineSimilarity(cv, sv);
            if (sim > maxSim) maxSim = sim;
          }
        }
      }
      const excessSim = Math.max(0, maxSim - 0.80);
      const mmr = c.score - (1 - lambda) * excessSim;
      if (mmr > bestMmr) {
        bestMmr = mmr;
        bestIdx = i;
      }
    }

    selected.push(pool.splice(bestIdx, 1)[0]);
  }

  return selected;
}

/**
 * Full Related Bookmarks pipeline (embedding-related-classify.md §3):
 * ① 3-way recall (Vector top-50 + FTS top-20 + Same-Author recent 10)
 * ② Duplicate grouping (same canonical_url or cos > 0.95)
 * ③ Feature fusion (with semantic relevance gate on nearInTime/sameAuthor/sameCat from S4 findings)
 * ④ Optional Decisions API (`gemini-decision-1`) rerank with SQLite `pair_cache`
 * ⑤ MMR diversification
 * ⑥ Signals generation
 */
export async function findRelatedItems(opts: {
  db: CollectionsDB;
  index: VectorIndex;
  decisions?: DecisionsClient;
  targetId: string;
  k?: number;
  mode?: RelatedMode;
}): Promise<RelatedResult> {
  const t0 = Date.now();
  const { db, index, decisions, k = 10 } = opts;
  const mode: RelatedMode =
    opts.mode ?? (decisions?.isAvailable() ? "decisions-rerank" : "feature-fusion");

  const targetList = db.getItems([opts.targetId]);
  if (!targetList.length) {
    throw new Error(`Target item not found: ${opts.targetId}`);
  }
  const target = targetList[0] as Record<string, any>;
  const targetId = String(target.id);
  const tv = index.vec(targetId);
  if (!tv) {
    throw new Error(`Target item '${targetId}' has no vector in VectorIndex`);
  }

  const targetTopics: string[] = Array.isArray(target.enriched_card?.topics)
    ? target.enriched_card.topics
    : [];

  // ① 3-way recall: Vector top-50 + FTS top-20 + Same-Author recent 10
  const vecHits = index.topK(tv, 50, { exclude: new Set([targetId]) });
  const ftsRankMap = new Map<string, number>();

  if (mode !== "embedding-only" && targetTopics.length > 0) {
    const ftsQuery = targetTopics.slice(0, 4).join(" ");
    const ftsHits = db.search({ query: ftsQuery, limit: 20 });
    ftsHits.forEach((h, idx) => {
      if (h.id !== targetId) ftsRankMap.set(h.id, idx);
    });
  }

  const authorIds: string[] = [];
  if (mode !== "embedding-only" && target.author) {
    const authorRows = db.db
      .prepare(
        `SELECT id FROM items
         WHERE deleted_at IS NULL AND author = ? AND id != ?
         ORDER BY first_seen_at DESC LIMIT 10`,
      )
      .all(target.author, targetId) as Array<{ id: string }>;
    for (const r of authorRows) authorIds.push(r.id);
  }

  const candidateIdSet = new Set<string>([
    ...vecHits.map((v) => v.id),
    ...ftsRankMap.keys(),
    ...authorIds,
  ]);
  candidateIdSet.delete(targetId);

  const candidateItems = db.getItems([...candidateIdSet]) as Array<Record<string, any>>;

  // ② Duplicate detection & ③ Feature scoring
  const duplicates: Array<{ id: string; url: string; cos: number }> = [];
  interface ScoredCand {
    item: Record<string, any>;
    id: string;
    cos: number;
    bm25Norm: number;
    topicJaccard: number;
    sharedTopics: string[];
    sameAuthor: number;
    sameCat: number;
    days: number;
    nearInTime: number;
    featureScore: number;
    score: number;
    decisionScore?: number;
    decisionConfidence?: number;
    signals: string[];
  }
  const rest: ScoredCand[] = [];

  for (const c of candidateItems) {
    const cid = String(c.id);
    const cv = index.vec(cid);
    const cos = cv ? cosineSimilarity(tv, cv) : 0;

    if (
      (target.canonical_url &&
        c.canonical_url &&
        target.canonical_url === c.canonical_url &&
        target.source !== "x") ||
      cos > 0.95
    ) {
      duplicates.push({ id: cid, url: String(c.url), cos: Number(cos.toFixed(4)) });
      continue;
    }

    const cTopics: string[] = Array.isArray(c.enriched_card?.topics)
      ? c.enriched_card.topics
      : [];
    const { score: topicJaccard, shared: sharedTopics } = jaccard(targetTopics, cTopics);
    // Compute lexical topic match ratio across candidate's title + excerpt (avoids recency bias from FTS fallback ordering)
    const candHay = `${c.title || ""} ${c.excerpt || ""}`.toLowerCase();
    const matchedTopicCount =
      targetTopics.length > 0
        ? targetTopics.filter((t) => candHay.includes(t.toLowerCase().trim())).length
        : 0;
    const bm25Norm =
      targetTopics.length > 0 ? matchedTopicCount / targetTopics.length : 0;
    const sameAuthor = target.author && c.author === target.author ? 1 : 0;
    const sameCat = target.category && c.category === target.category ? 1 : 0;
    const days = daysBetween(
      target.publish_date || target.first_seen_at,
      c.publish_date || c.first_seen_at,
    );
    const nearInTime = Math.exp(-days / 30);

    // Relevance gate from S4 findings: only allow metadata bonuses (nearInTime, sameAuthor, sameCat)
    // when semantic cosine >= 0.68 or specific topics overlap!
    const hasTopicOrSemanticLink = cos >= 0.68 || topicJaccard > 0;
    const metaBonus = hasTopicOrSemanticLink
      ? 0.04 * sameAuthor + 0.04 * sameCat + 0.02 * nearInTime
      : 0;

    const featureScore =
      0.76 * cos + 0.06 * bm25Norm + 0.08 * topicJaccard + metaBonus;

    const signals: string[] = [];
    if (cos >= 0.70) signals.push(`语义相近(${cos.toFixed(2)})`);
    if (sharedTopics.length > 0) {
      signals.push(`共同主题: ${sharedTopics.slice(0, 3).join(", ")}`);
    }
    if (sameAuthor) signals.push(`同作者(${c.author})`);
    if (sameCat && c.category) signals.push(`同分类(${c.category})`);
    if (hasTopicOrSemanticLink && days <= 3) {
      signals.push(`同一时期收藏`);
    }

    rest.push({
      item: c,
      id: cid,
      cos,
      bm25Norm,
      topicJaccard,
      sharedTopics,
      sameAuthor,
      sameCat,
      days,
      nearInTime,
      featureScore,
      score: mode === "embedding-only" ? cos : featureScore,
      signals,
    });
  }

  if (mode === "embedding-only") {
    const topByCos = rest.sort((a, b) => b.cos - a.cos).slice(0, k);
    return {
      targetId,
      mode,
      elapsedMs: Date.now() - t0,
      items: topByCos.map((c) => formatRelatedItem(c)),
      duplicates,
    };
  }

  let ranked = rest.sort((a, b) => b.featureScore - a.featureScore).slice(0, 25);

  // ④ Optional Decisions API rerank (1 request for up to 25 candidates, cached in pair_cache)
  if (mode === "decisions-rerank" && ranked.length > 0) {
    const decisionModel = "gemini-decision-1";
    const cachedPairs = db.getPairCacheMany(
      targetId,
      ranked.map((c) => c.id),
      decisionModel,
    );

    const uncached = ranked.filter((c) => !cachedPairs.has(c.id));
    if (uncached.length > 0 && decisions?.isAvailable()) {
      const targetRepr = buildRepresentationText({
        title: target.title,
        excerpt: target.excerpt,
        note: target.note,
        card: target.enriched_card,
      });

      const questions: Record<
        string,
        { type: "score"; instructions: string; criteria: string[] }
      > = {};
      for (const c of uncached) {
        const candRepr = buildRepresentationText({
          title: c.item.title,
          excerpt: c.item.excerpt,
          note: c.item.note,
          card: c.item.enriched_card,
        });
        questions[`c_${c.id.replace(/[^a-zA-Z0-9_]/g, "_")}`] = {
          type: "score",
          instructions:
            `候选收藏:\n${candRepr}\n\n` +
            `请判断这条候选收藏与输入中的目标收藏有多相关？"相关"指讨论同一具体主题、技术、问题或能提供互补视角/工具/背景；仅表面用词重合不算。`,
          criteria: RELATED_SCORE_CRITERIA,
        };
      }

      try {
        const res = await decisions.create({
          input: `目标收藏:\n${targetRepr}`,
          questions,
          priority: "interactive",
        });

        for (const c of uncached) {
          const qKey = `c_${c.id.replace(/[^a-zA-Z0-9_]/g, "_")}`;
          const ans = res.answers?.[qKey] as DecisionScoreAnswer | undefined;
          if (ans && typeof ans.score === "number") {
            db.upsertPairCache({
              target_id: targetId,
              candidate_id: c.id,
              model: decisionModel,
              score: ans.score,
              confidence: ans.confidence ?? 0,
              raw_answer: JSON.stringify(ans),
            });
            cachedPairs.set(c.id, {
              score: ans.score,
              confidence: ans.confidence ?? 0,
            });
          }
        }
      } catch {
        // Graceful fallback to featureScore if Decisions API fails or rate-limits
      }
    }

    if (cachedPairs.size > 0) {
      ranked = ranked
        .map((c) => {
          const ans = cachedPairs.get(c.id);
          if (!ans) return c;
          const rel = ans.score / 3;
          const blended = 0.45 * c.featureScore + 0.55 * rel;
          const signals = [...c.signals];
          if (ans.score >= 1.8) {
            signals.unshift(`精判高相关(${ans.score.toFixed(1)}/3)`);
          }
          return {
            ...c,
            decisionScore: Number(ans.score.toFixed(3)),
            decisionConfidence: Number(ans.confidence.toFixed(3)),
            score: blended,
            signals,
          };
        })
        // Hide items judged clearly unrelated (< 0.85 out of 3)
        .filter((c) => c.decisionScore === undefined || c.decisionScore >= 0.85)
        .sort((a, b) => b.score - a.score);
    }
  }

  // ⑤ MMR diversification
  const picked = mmrDiversify(ranked, index, 0.82, k);

  return {
    targetId,
    mode,
    elapsedMs: Date.now() - t0,
    items: picked.map((c) => formatRelatedItem(c)),
    duplicates,
  };
}

function formatRelatedItem(c: {
  item: Record<string, any>;
  id: string;
  score: number;
  cos: number;
  decisionScore?: number;
  decisionConfidence?: number;
  signals: string[];
}): RelatedItemOutput {
  return {
    id: c.id,
    title: c.item.title ?? null,
    author: c.item.author ?? null,
    excerpt: String(c.item.excerpt || "").slice(0, 320),
    url: String(c.item.url),
    category: c.item.category ?? null,
    score: Number(c.score.toFixed(4)),
    cos: Number(c.cos.toFixed(4)),
    decisionScore: c.decisionScore,
    decisionConfidence: c.decisionConfidence,
    signals: c.signals.length > 0 ? c.signals : [`语义相近(${c.cos.toFixed(2)})`],
  };
}
