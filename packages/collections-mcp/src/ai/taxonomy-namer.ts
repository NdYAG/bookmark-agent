import { DiskAiCache } from "./cache.js";
import { PriorityLevel, QuotaExhaustedError, RateLimiterRegistry } from "./limiter.js";

/** One k-means cluster as presented to the namer. */
export interface ClusterDigest {
  /** 1-based cluster number used in the prompt and the answer. */
  cluster: number;
  size: number;
  /** Most frequent `card.topics` across all members, with counts. */
  topTopics: Array<{ topic: string; count: number }>;
  /** Items closest to the cluster centroid. */
  samples: Array<{ id: string; title?: string | null; summary?: string | null; topics?: string[] }>;
}

export interface ClusterName {
  cluster: number;
  id: string;
  name: string;
  description: string;
  nameSource?: "llm" | "topics";
}

export interface TaxonomyNamer {
  readonly model: string;
  isAvailable(): boolean;
  /** Names all clusters in a single call so names stay mutually distinct. */
  nameClusters(clusters: ClusterDigest[]): Promise<{ names: ClusterName[]; model: string }>;
}

const SUMMARY_MAX = 160;

export function buildNamingPrompt(clusters: ClusterDigest[]): string {
  const lines: string[] = [
    `你在为一个个人收藏库设计分类体系。下面是对全部收藏的 embedding 做聚类得到的 ${clusters.length} 个簇，` +
      `每个簇给出规模、高频主题词，以及离簇中心最近的若干条收藏。`,
    `请为每个簇定义一个分类：`,
    `- name：简洁的中文分类名（4–12 个字），概括簇内收藏的共同主题。各簇名称互不重复；` +
      `除非簇内容确实很杂，不要用"其他""综合"这类空泛的名字。`,
    `- description：一句话说明这个分类收录什么内容。它会作为之后自动归类的判定标准，要写清和其他簇的边界。`,
    `- id：英文 kebab-case 短标识（如 "ai-coding-tools"），只含小写字母、数字和连字符。`,
    `输出 JSON 数组，每个元素为 {cluster, id, name, description}，cluster 为簇编号，必须覆盖全部 ${clusters.length} 个簇。`,
    ``,
  ];
  for (const c of clusters) {
    lines.push(`## 簇 ${c.cluster}（共 ${c.size} 条）`);
    if (c.topTopics.length) {
      lines.push(`高频主题：${c.topTopics.map((t) => `${t.topic}(${t.count})`).join("、")}`);
    }
    lines.push(`代表收藏：`);
    for (const s of c.samples) {
      const parts = [
        s.title?.trim(),
        s.summary ? s.summary.trim().slice(0, SUMMARY_MAX) : null,
        s.topics?.length ? `主题: ${s.topics.join(", ")}` : null,
      ].filter(Boolean);
      lines.push(`- ${parts.join(" | ")}`);
    }
    lines.push(``);
  }
  return lines.join("\n");
}

/** Accepts a bare JSON array or one wrapped in a ```json fence (Gemma has no responseSchema). */
export function parseNamesJson(text: string): unknown[] {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1] : trimmed;
  const start = body.indexOf("[");
  const end = body.lastIndexOf("]");
  if (start < 0 || end <= start) throw new Error("Namer response is not a JSON array");
  const parsed = JSON.parse(body.slice(start, end + 1));
  if (!Array.isArray(parsed)) throw new Error("Namer response is not a JSON array");
  return parsed;
}

/**
 * Gemini/Gemma-backed cluster namer (embedding-related-classify.md §4.1 step ②).
 * One generateContent request per proposal, cached on disk by the cluster digests.
 */
export class GeminiTaxonomyNamer implements TaxonomyNamer {
  readonly model: string;
  private readonly apiKey: string | null;
  private readonly overflowModels: string[];
  private readonly promptVersion: string;
  private readonly limiter: RateLimiterRegistry;
  private readonly cache: DiskAiCache;
  private readonly fetchFn: typeof fetch;

  constructor(opts: {
    apiKey: string | null;
    model?: string;
    overflowModels?: string[];
    promptVersion?: string;
    limiter: RateLimiterRegistry;
    cache: DiskAiCache;
    fetchFn?: typeof fetch;
  }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model || "gemini-3.1-flash-lite";
    this.overflowModels = opts.overflowModels ?? [];
    this.promptVersion = opts.promptVersion || "taxonomy-v1";
    this.limiter = opts.limiter;
    this.cache = opts.cache;
    this.fetchFn = opts.fetchFn || fetch;
  }

  isAvailable(): boolean {
    return Boolean(this.apiKey);
  }

  async nameClusters(
    clusters: ClusterDigest[],
    opts?: { priority?: PriorityLevel },
  ): Promise<{ names: ClusterName[]; model: string }> {
    if (!this.apiKey) throw new Error("GEMINI_API_KEY not configured for TaxonomyNamer");
    const prompt = buildNamingPrompt(clusters);
    let lastError: unknown = null;
    for (const model of [this.model, ...this.overflowModels]) {
      try {
        const raw = await this.callModel(model, prompt, opts?.priority ?? "interactive");
        return { names: normalizeNames(raw, clusters), model };
      } catch (err) {
        lastError = err;
        if (err instanceof QuotaExhaustedError) continue;
        throw err;
      }
    }
    throw lastError || new Error("All taxonomy namer models exhausted");
  }

  private async callModel(model: string, prompt: string, priority: PriorityLevel): Promise<unknown[]> {
    const isGemma = model.startsWith("gemma-");
    const { value } = await this.cache.getOrCompute<unknown[]>(
      { model, promptVersion: this.promptVersion, input: { prompt } },
      async () => {
        const generationConfig = isGemma
          ? { temperature: 0.2 }
          : {
              temperature: 0.2,
              responseMimeType: "application/json",
              responseSchema: {
                type: "ARRAY",
                items: {
                  type: "OBJECT",
                  properties: {
                    cluster: { type: "INTEGER" },
                    id: { type: "STRING" },
                    name: { type: "STRING" },
                    description: { type: "STRING" },
                  },
                  required: ["cluster", "id", "name", "description"],
                },
              },
            };
        const text = isGemma ? `${prompt}\n请严格只输出合法的 JSON 数组，不要包含 markdown 代码块标记。` : prompt;
        const body = { contents: [{ role: "user", parts: [{ text }] }], generationConfig };
        const bucket = this.limiter.bucket(model);
        return bucket.schedule(
          async () => {
            const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${this.apiKey}`;
            const res = await this.fetchFn(url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify(body),
            });
            const data = (await res.json()) as any;
            if (!res.ok) {
              if (res.status === 429) {
                const isDaily = JSON.stringify(data).includes("PerDay");
                bucket.record429({ isDaily });
                if (isDaily) throw new QuotaExhaustedError(model, bucket.getStats().dayResetIso);
              }
              throw new Error(
                `Taxonomy namer API error (${res.status} on ${model}): ${JSON.stringify(data?.error || data)}`,
              );
            }
            const outText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (!outText) throw new Error(`Empty response from ${model}`);
            return parseNamesJson(outText);
          },
          { priority, requestCount: 1, estimatedTokens: Math.ceil(prompt.length / 2) + 1500 },
        );
      },
    );
    return value;
  }
}

export function slugifyCategoryId(raw: unknown): string {
  return String(raw ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Aligns model output to the input clusters: one entry per cluster, sanitized unique ids,
 * and a topic-based fallback name for any cluster the model skipped.
 */
export function normalizeNames(
  raw: unknown[],
  clusters: ClusterDigest[],
  opts?: { reservedIds?: Iterable<string>; reservedNames?: Iterable<string> },
): ClusterName[] {
  const byCluster = new Map<number, Record<string, unknown>>();
  raw.forEach((r, idx) => {
    if (!r || typeof r !== "object") return;
    const rec = r as Record<string, unknown>;
    const n = Number(rec.cluster ?? idx + 1);
    if (Number.isInteger(n) && !byCluster.has(n)) byCluster.set(n, rec);
  });

  const usedIds = new Set<string>(opts?.reservedIds);
  const usedNames = new Set<string>(opts?.reservedNames);
  return clusters.map((c) => {
    const rec = byCluster.get(c.cluster);
    const topicsLabel = c.topTopics.slice(0, 3).map((t) => t.topic).join(" · ");
    const rawName = String(rec?.name ?? "").trim();
    const fromLlm = rawName.length > 0;
    let name = rawName || topicsLabel || `分类 ${c.cluster}`;
    if (usedNames.has(name)) name = `${name} ${c.cluster}`;
    usedNames.add(name);

    let id = slugifyCategoryId(rec?.id) || `cluster-${c.cluster}`;
    if (usedIds.has(id)) id = `${id}-${c.cluster}`;
    usedIds.add(id);

    const description = String(rec?.description ?? "").trim() || (topicsLabel ? `主要涉及：${topicsLabel}` : name);
    return { cluster: c.cluster, id, name, description, nameSource: fromLlm ? "llm" : "topics" };
  });
}
