import { l2Normalize } from "../ai/embedder/index.js";
import { CollectionsDB } from "../db/index.js";

export interface VectorMatch {
  id: string;
  score: number; // cosine similarity in [-1, 1]
}

/**
 * In-memory contiguous Float32Array vector index (embedding-related-classify.md §2.2).
 * - Pre-normalizes rows to L2=1 so dot product === cosine similarity.
 * - Brute-force 10k x 768 takes ~2ms in V8.
 */
export class VectorIndex {
  readonly model: string;
  readonly dim: number;
  private ids: string[] = [];
  private idToIndex = new Map<string, number>();
  private mat = new Float32Array(0);
  private capacity = 0;

  constructor(model = "gemini-embedding-2@768", dim = 768) {
    this.model = model;
    this.dim = dim;
  }

  get size(): number {
    return this.ids.length;
  }

  has(id: string): boolean {
    return this.idToIndex.has(id);
  }

  allIds(): string[] {
    return [...this.ids];
  }

  vec(id: string): Float32Array | null {
    const idx = this.idToIndex.get(id);
    if (idx === undefined) return null;
    const start = idx * this.dim;
    return this.mat.subarray(start, start + this.dim);
  }

  /**
   * Bulk load vectors from SQLite `embeddings` table (excluding soft-deleted items).
   */
  loadFromDB(db: CollectionsDB): number {
    const rows = db.db
      .prepare(
        `SELECT e.item_id, e.vec
         FROM embeddings e
         JOIN items i ON i.id = e.item_id
         WHERE e.model = ? AND e.dim = ? AND i.deleted_at IS NULL`,
      )
      .all(this.model, this.dim) as Array<{ item_id: string; vec: Buffer }>;

    this.ids = [];
    this.idToIndex.clear();
    this.capacity = Math.max(rows.length + 64, 256);
    this.mat = new Float32Array(this.capacity * this.dim);

    for (const r of rows) {
      if (!r.vec || r.vec.byteLength !== this.dim * 4) continue;
      const f32 = new Float32Array(
        r.vec.buffer,
        r.vec.byteOffset,
        this.dim,
      );
      this.upsert(r.item_id, f32);
    }

    return this.ids.length;
  }

  /**
   * Incremental insert or in-place update of a vector.
   */
  upsert(id: string, rawVec: ArrayLike<number>): void {
    if (rawVec.length !== this.dim) {
      throw new Error(`Expected vector dim ${this.dim}, got ${rawVec.length}`);
    }
    const norm = l2Normalize(rawVec);
    const existingIdx = this.idToIndex.get(id);
    if (existingIdx !== undefined) {
      this.mat.set(norm, existingIdx * this.dim);
      return;
    }

    const nextIdx = this.ids.length;
    if (nextIdx >= this.capacity) {
      this.capacity = Math.max(this.capacity * 2, 256);
      const nextMat = new Float32Array(this.capacity * this.dim);
      nextMat.set(this.mat);
      this.mat = nextMat;
    }

    this.ids.push(id);
    this.idToIndex.set(id, nextIdx);
    this.mat.set(norm, nextIdx * this.dim);
  }

  remove(id: string): void {
    const idx = this.idToIndex.get(id);
    if (idx === undefined) return;
    const lastIdx = this.ids.length - 1;
    if (idx !== lastIdx) {
      const lastId = this.ids[lastIdx];
      this.ids[idx] = lastId;
      this.idToIndex.set(lastId, idx);
      const lastSlice = this.mat.subarray(lastIdx * this.dim, (lastIdx + 1) * this.dim);
      this.mat.set(lastSlice, idx * this.dim);
    }
    this.ids.pop();
    this.idToIndex.delete(id);
  }

  /**
   * Exact cosine similarity top-K retrieval.
   */
  topK(
    queryVec: ArrayLike<number>,
    k: number,
    opts?: { exclude?: Set<string>; filter?: (id: string) => boolean },
  ): VectorMatch[] {
    if (this.ids.length === 0 || k <= 0) return [];
    const q = l2Normalize(queryVec);
    const matches: VectorMatch[] = [];
    const exclude = opts?.exclude;
    const filter = opts?.filter;

    for (let i = 0; i < this.ids.length; i++) {
      const id = this.ids[i];
      if (exclude?.has(id)) continue;
      if (filter && !filter(id)) continue;

      let dot = 0;
      const offset = i * this.dim;
      for (let d = 0; d < this.dim; d++) {
        dot += this.mat[offset + d] * q[d];
      }
      matches.push({ id, score: dot });
    }

    matches.sort((a, b) => b.score - a.score);
    return matches.slice(0, k);
  }
}

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom > 0 ? dot / denom : 0;
}

/**
 * Reciprocal Rank Fusion (RRF) for combining FTS lexical search and Vector semantic search:
 * score(d) = sum_{list} 1 / (rrfK + rank_{list}(d))
 */
export function reciprocalRankFusion<T extends { id: string }>(
  rankedLists: Array<{ items: T[]; weight?: number }>,
  rrfK = 60,
): Array<{ id: string; rrfScore: number; item: T; sources: number[] }> {
  const map = new Map<
    string,
    { id: string; rrfScore: number; item: T; sources: number[] }
  >();

  for (let listIdx = 0; listIdx < rankedLists.length; listIdx++) {
    const { items, weight = 1.0 } = rankedLists[listIdx];
    for (let rank = 0; rank < items.length; rank++) {
      const it = items[rank];
      const contrib = weight / (rrfK + rank + 1);
      const existing = map.get(it.id);
      if (existing) {
        existing.rrfScore += contrib;
        existing.sources.push(listIdx);
      } else {
        map.set(it.id, {
          id: it.id,
          rrfScore: contrib,
          item: it,
          sources: [listIdx],
        });
      }
    }
  }

  return [...map.values()].sort((a, b) => b.rrfScore - a.rrfScore);
}
