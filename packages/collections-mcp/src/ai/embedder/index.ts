import { createHash } from "node:crypto";
import { DiskAiCache } from "../cache.js";
import { PriorityLevel, RateLimiterRegistry } from "../limiter.js";

export interface DocInput {
  title?: string | null;
  text: string;
  images?: Array<{ mime: string; data: Uint8Array }>;
}

/**
 * Pluggable Embedder interface (embedding-local-vs-cloud.md §4).
 * Prefixes (`task: search result | query: ...`, `title: ... | text: ...`) are handled internally.
 */
export interface Embedder {
  readonly id: string; // e.g. "gemini-embedding-2@768"
  readonly model: string; // e.g. "gemini-embedding-2"
  readonly dim: number; // e.g. 768
  readonly modalities: ("text" | "image")[];
  embedDocuments(
    docs: DocInput[],
    opts?: { priority?: PriorityLevel },
  ): Promise<Float32Array[]>;
  embedQuery(
    query: string,
    opts?: { priority?: PriorityLevel },
  ): Promise<Float32Array>;
}

export function l2Normalize(vec: ArrayLike<number>): Float32Array {
  const out = new Float32Array(vec.length);
  let sum = 0;
  for (let i = 0; i < vec.length; i++) {
    const v = vec[i];
    sum += v * v;
  }
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (let i = 0; i < vec.length; i++) out[i] = vec[i] / norm;
  }
  return out;
}

export function computeDocInputHash(embedderId: string, doc: DocInput): string {
  const h = createHash("sha1");
  h.update(`${embedderId}\0${doc.title || ""}\0${doc.text}`);
  if (doc.images?.length) {
    for (const img of doc.images.slice(0, 4)) {
      h.update(`\0${img.mime}:`);
      h.update(img.data);
    }
  }
  return h.digest("hex");
}

/**
 * Cloud Gemini Embedder (`gemini-embedding-2`@768).
 * - Uses `title: <title> | text: <text>` for documents and `task: search result | query: <q>` for queries
 * - Supports up to 4 multimodal images per document
 * - Uses `:batchEmbedContents` and deducts `batch.length` requests from the 100 RPM bucket (verified in S4)
 */
export class GeminiEmbedder implements Embedder {
  readonly id: string;
  readonly model: string;
  readonly dim: number;
  readonly modalities: ("text" | "image")[] = ["text", "image"];

  private readonly apiKey: string | null;
  private readonly limiter: RateLimiterRegistry;
  private readonly cache: DiskAiCache;
  private readonly fetchFn: typeof fetch;

  constructor(opts: {
    apiKey: string | null;
    model?: string;
    dim?: number;
    limiter: RateLimiterRegistry;
    cache: DiskAiCache;
    fetchFn?: typeof fetch;
  }) {
    this.model = opts.model || "gemini-embedding-2";
    this.dim = opts.dim || 768;
    this.id = `${this.model}@${this.dim}`;
    this.apiKey = opts.apiKey;
    this.limiter = opts.limiter;
    this.cache = opts.cache;
    this.fetchFn = opts.fetchFn || fetch;
  }

  private formatDocParts(doc: DocInput): Array<Record<string, unknown>> {
    const formattedText = `title: ${doc.title || "none"} | text: ${doc.text}`;
    const parts: Array<Record<string, unknown>> = [{ text: formattedText }];
    if (doc.images?.length) {
      for (const img of doc.images.slice(0, 4)) {
        parts.push({
          inline_data: {
            mime_type: img.mime,
            data: Buffer.from(img.data).toString("base64"),
          },
        });
      }
    }
    return parts;
  }

  async embedDocuments(
    docs: DocInput[],
    opts?: { priority?: PriorityLevel },
  ): Promise<Float32Array[]> {
    if (docs.length === 0) return [];
    const results: Array<Float32Array | null> = new Array(docs.length).fill(null);
    const uncachedIndices: number[] = [];

    for (let i = 0; i < docs.length; i++) {
      const hash = computeDocInputHash(this.id, docs[i]);
      const cached = this.cache.get<number[]>({
        model: this.id,
        promptVersion: "doc-v1",
        input: hash,
      });
      if (cached && cached.length === this.dim) {
        results[i] = l2Normalize(cached);
      } else {
        uncachedIndices.push(i);
      }
    }

    const BATCH_SIZE = 20;
    const bucket = this.limiter.bucket(this.model);

    for (let b = 0; b < uncachedIndices.length; b += BATCH_SIZE) {
      if (!this.apiKey) {
        throw new Error("GEMINI_API_KEY not configured for GeminiEmbedder");
      }
      const slice = uncachedIndices.slice(b, b + BATCH_SIZE);
      const requests = slice.map((idx) => ({
        model: `models/${this.model}`,
        content: { parts: this.formatDocParts(docs[idx]) },
        outputDimensionality: this.dim,
      }));
      const estTokens = slice.reduce(
        (acc, idx) =>
          acc +
          Math.ceil(docs[idx].text.length / 3) +
          (docs[idx].images?.length || 0) * 258,
        0,
      );

      const embeddings = await bucket.schedule(
        async () => {
          const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:batchEmbedContents?key=${this.apiKey}`;
          const res = await this.fetchFn(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ requests }),
          });
          const data = (await res.json()) as any;
          if (!res.ok) {
            if (res.status === 429) {
              const isDaily = JSON.stringify(data).includes("PerDay");
              bucket.record429({ isDaily });
            }
            throw new Error(
              `Embedding API error (${res.status}): ${JSON.stringify(data?.error || data)}`,
            );
          }
          return (data.embeddings || []) as Array<{ values: number[] }>;
        },
        {
          priority: opts?.priority ?? "background",
          // Verified in S4: batchEmbedContents with N requests deducts N from the 100 RPM limit
          requestCount: slice.length,
          estimatedTokens: estTokens,
        },
      );

      for (let j = 0; j < slice.length; j++) {
        const docIdx = slice[j];
        const vals = embeddings[j]?.values;
        if (!vals || vals.length !== this.dim) {
          throw new Error(`Invalid embedding returned for doc index ${docIdx}`);
        }
        const normVec = l2Normalize(vals);
        results[docIdx] = normVec;
        const hash = computeDocInputHash(this.id, docs[docIdx]);
        this.cache.set(
          { model: this.id, promptVersion: "doc-v1", input: hash },
          Array.from(normVec),
        );
      }
    }

    return results as Float32Array[];
  }

  async embedQuery(
    query: string,
    opts?: { priority?: PriorityLevel },
  ): Promise<Float32Array> {
    const formatted = `task: search result | query: ${query.trim()}`;
    const { value } = await this.cache.getOrCompute<number[]>(
      {
        model: this.id,
        promptVersion: "query-v1",
        input: formatted,
      },
      async () => {
        if (!this.apiKey) {
          throw new Error("GEMINI_API_KEY not configured for GeminiEmbedder");
        }
        const bucket = this.limiter.bucket(this.model);
        return bucket.schedule(
          async () => {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent?key=${this.apiKey}`;
            const res = await this.fetchFn(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                model: `models/${this.model}`,
                content: { parts: [{ text: formatted }] },
                outputDimensionality: this.dim,
              }),
            });
            const data = (await res.json()) as any;
            if (!res.ok) {
              if (res.status === 429) {
                const isDaily = JSON.stringify(data).includes("PerDay");
                bucket.record429({ isDaily });
              }
              throw new Error(
                `embedQuery API error (${res.status}): ${JSON.stringify(data?.error || data)}`,
              );
            }
            const vals = data?.embedding?.values as number[];
            return Array.from(l2Normalize(vals));
          },
          {
            priority: opts?.priority ?? "interactive",
            requestCount: 1,
            estimatedTokens: Math.max(10, Math.ceil(formatted.length / 3)),
          },
        );
      },
    );

    return l2Normalize(value);
  }
}
