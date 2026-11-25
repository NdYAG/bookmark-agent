import { DiskAiCache } from "./cache.js";
import { PriorityLevel, QuotaExhaustedError, RateLimiterRegistry } from "./limiter.js";

export interface EnrichedCard {
  summary: string;
  topics: string[];
  kind: "tutorial" | "opinion" | "tool" | "news" | "inspiration" | "reference" | "other";
  lang: string;
  imageCaptions: string[];
  enrich_model: string;
  prompt_version: string;
}

export interface EnrichItemInput {
  id: string;
  author?: string | null;
  text?: string | null;
  articleText?: string | null;
  quoteText?: string | null;
  cardText?: string | null;
  links?: string[];
  images?: Array<{ mimeType: string; base64Data: string }>;
}

/**
 * Enrich service:
 * - Primary model: `gemini-3.1-flash-lite`
 * - Overflow models: `["gemma-4-31b-it", "gemma-4-26b-a4b-it", "gemini-3.5-flash-lite"]`
 * - Automatically switches to overflow model if primary hits daily quota (QuotaExhaustedError)
 * - Records `enrich_model` and `prompt_version` on every returned card
 */
export class EnrichService {
  private readonly apiKey: string | null;
  private readonly primaryModel: string;
  private readonly overflowModels: string[];
  private readonly promptVersion: string;
  private readonly limiter: RateLimiterRegistry;
  private readonly cache: DiskAiCache;
  private readonly fetchFn: typeof fetch;

  constructor(opts: {
    apiKey: string | null;
    primaryModel?: string;
    overflowModels?: string[];
    promptVersion?: string;
    limiter: RateLimiterRegistry;
    cache: DiskAiCache;
    fetchFn?: typeof fetch;
  }) {
    this.apiKey = opts.apiKey;
    this.primaryModel = opts.primaryModel || "gemini-3.1-flash-lite";
    this.overflowModels = opts.overflowModels || [
      "gemma-4-31b-it",
      "gemma-4-26b-a4b-it",
      "gemini-3.5-flash-lite",
    ];
    this.promptVersion = opts.promptVersion || "v1";
    this.limiter = opts.limiter;
    this.cache = opts.cache;
    this.fetchFn = opts.fetchFn || fetch;
  }

  async enrichOne(
    item: EnrichItemInput,
    opts?: { priority?: PriorityLevel },
  ): Promise<EnrichedCard> {
    const modelsToTry = [this.primaryModel, ...this.overflowModels];
    let lastError: unknown = null;

    for (const model of modelsToTry) {
      try {
        return await this.callModel(item, model, opts?.priority ?? "background");
      } catch (err) {
        lastError = err;
        if (err instanceof QuotaExhaustedError) {
          // Overflow to next model when primary daily quota is exhausted
          continue;
        }
        throw err;
      }
    }
    throw lastError || new Error("All enrich models exhausted");
  }

  /**
   * Enriches several items in ONE generateContent request (cached per item, same key as `enrichOne`).
   * Cache hits are returned without a request; only misses are sent. Items the model omits are
   * reported in `failed` so the caller can retry them later.
   */
  async enrichBatch(
    items: EnrichItemInput[],
    opts?: { priority?: PriorityLevel },
  ): Promise<{ cards: Map<string, EnrichedCard>; failed: string[]; requests: number }> {
    const priority = opts?.priority ?? "background";
    const cards = new Map<string, EnrichedCard>();
    let pending = items;
    let requests = 0;
    let lastError: unknown = null;

    for (const model of [this.primaryModel, ...this.overflowModels]) {
      const misses: EnrichItemInput[] = [];
      for (const item of pending) {
        const hit = this.cache.get<CardBody>(this.cacheKeyFor(item, model));
        if (hit) cards.set(item.id, this.finalize(hit, model));
        else misses.push(item);
      }
      if (misses.length === 0) return { cards, failed: [], requests };
      if (!this.apiKey) throw new Error("GEMINI_API_KEY not configured for EnrichService");

      try {
        requests++;
        const answers = await this.requestBatch(misses, model, priority);
        for (const item of misses) {
          const body = answers.get(item.id);
          if (!body) continue;
          this.cache.set(this.cacheKeyFor(item, model), body);
          cards.set(item.id, this.finalize(body, model));
        }
        return { cards, failed: misses.filter((m) => !cards.has(m.id)).map((m) => m.id), requests };
      } catch (err) {
        lastError = err;
        if (err instanceof QuotaExhaustedError) {
          pending = misses;
          continue;
        }
        throw err;
      }
    }
    throw lastError || new Error("All enrich models exhausted");
  }

  private promptTextFor(item: EnrichItemInput): string {
    const inputTextLines = [
      `ID: ${item.id}`,
      item.author ? `作者: ${item.author}` : "",
      item.text ? `正文:\n${item.text}` : "",
      item.articleText ? `长文:\n${item.articleText}` : "",
      item.quoteText ? `引用:\n${item.quoteText}` : "",
      item.cardText ? `链接卡片: ${item.cardText}` : "",
      item.links?.length ? `链接: ${item.links.join(", ")}` : "",
    ].filter(Boolean);
    return `请分析以下收藏内容（及配图），输出结构化卡片 JSON：\n` + inputTextLines.join("\n");
  }

  private cacheKeyFor(item: EnrichItemInput, model: string) {
    return {
      model,
      promptVersion: this.promptVersion,
      input: {
        promptText: this.promptTextFor(item),
        imageHashes: (item.images || []).map((img) => img.base64Data.slice(0, 64)),
      },
    };
  }

  private finalize(value: CardBody, model: string): EnrichedCard {
    return {
      summary: value.summary,
      topics: Array.isArray(value.topics) ? value.topics : [],
      kind: value.kind || "other",
      lang: value.lang || "zh",
      imageCaptions: Array.isArray(value.imageCaptions) ? value.imageCaptions : [],
      enrich_model: model,
      prompt_version: this.promptVersion,
    };
  }

  private async callModel(
    item: EnrichItemInput,
    model: string,
    priority: PriorityLevel,
  ): Promise<EnrichedCard> {
    const promptText = this.promptTextFor(item);
    const { value } = await this.cache.getOrCompute<CardBody>(this.cacheKeyFor(item, model), async () => {
      if (!this.apiKey) {
        throw new Error("GEMINI_API_KEY not configured for EnrichService");
      }
      const parts: Array<Record<string, unknown>> = [{ text: promptText }];
      for (const img of (item.images || []).slice(0, 4)) {
        parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64Data } });
      }
      const estTokens = Math.ceil(promptText.length / 3) + (item.images?.length || 0) * 1100;
      const outText = await this.generate(model, parts, CARD_SCHEMA, estTokens, priority);
      return JSON.parse(outText) as CardBody;
    });
    return this.finalize(value, model);
  }

  private async requestBatch(
    items: EnrichItemInput[],
    model: string,
    priority: PriorityLevel,
  ): Promise<Map<string, CardBody>> {
    const isGemma = model.startsWith("gemma-");
    const parts: Array<Record<string, unknown>> = [
      {
        text:
          `下面给出 ${items.length} 条收藏内容（部分附配图）。请为每一条生成结构化卡片，输出 JSON 数组，` +
          `每个元素包含 id（与输入一致）、summary（1–2 句客观总结核心内容，不要写"这条收藏介绍了"之类的套话）、` +
          `topics（3–5 个具体主题词）、kind、lang、imageCaptions（每张配图一句话描述，无图则为空数组）。` +
          (isGemma ? `请严格只输出合法的 JSON 数组，不要包含 markdown 代码块标记。` : ""),
      },
    ];
    let estTokens = 200;
    for (const item of items) {
      const text = this.promptTextFor(item);
      const images = (item.images || []).slice(0, 2);
      parts.push({ text: `\n--- 收藏 [${item.id}] 开始（${images.length ? `附图 ${images.length} 张` : "无图"}）---\n${text}\n` });
      for (const img of images) {
        parts.push({ inline_data: { mime_type: img.mimeType, data: img.base64Data } });
      }
      parts.push({ text: `--- 收藏 [${item.id}] 结束 ---\n` });
      estTokens += Math.ceil(text.length / 3) + images.length * 1100 + 150;
    }

    const schema = isGemma
      ? null
      : {
          type: "ARRAY",
          items: {
            ...CARD_SCHEMA,
            properties: { id: { type: "STRING" }, ...CARD_SCHEMA.properties },
            required: ["id", ...CARD_SCHEMA.required],
          },
        };
    const outText = await this.generate(model, parts, schema, estTokens, priority);
    const fenced = outText.match(/```(?:json)?\s*([\s\S]*?)```/);
    const body = fenced ? fenced[1] : outText;
    const arr = JSON.parse(body.slice(body.indexOf("["), body.lastIndexOf("]") + 1)) as Array<
      CardBody & { id?: string }
    >;
    const byId = new Map<string, CardBody>();
    const wanted = new Set(items.map((i) => i.id));
    for (const rec of arr) {
      const id = String(rec?.id ?? "");
      if (wanted.has(id) && typeof rec.summary === "string") {
        const { id: _drop, ...card } = rec;
        byId.set(id, card);
      }
    }
    return byId;
  }

  private async generate(
    model: string,
    parts: Array<Record<string, unknown>>,
    responseSchema: Record<string, unknown> | null,
    estimatedTokens: number,
    priority: PriorityLevel,
  ): Promise<string> {
    const generationConfig = responseSchema
      ? { responseMimeType: "application/json", responseSchema }
      : { temperature: 0.2 };
    const body = { contents: [{ role: "user", parts }], generationConfig };
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
            if (isDaily) {
              throw new QuotaExhaustedError(model, bucket.getStats().dayResetIso);
            }
          }
          throw new Error(
            `Enrich API error (${res.status} on ${model}): ${JSON.stringify(data?.error || data)}`,
          );
        }
        const outText = data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (!outText) {
          throw new Error(`Empty response from ${model}`);
        }
        return outText as string;
      },
      { priority, requestCount: 1, estimatedTokens },
    );
  }
}

type CardBody = Omit<EnrichedCard, "enrich_model" | "prompt_version">;

const CARD_SCHEMA = {
  type: "OBJECT",
  properties: {
    summary: { type: "STRING" },
    topics: { type: "ARRAY", items: { type: "STRING" } },
    kind: {
      type: "STRING",
      enum: ["tutorial", "opinion", "tool", "news", "inspiration", "reference", "other"],
    },
    lang: { type: "STRING" },
    imageCaptions: { type: "ARRAY", items: { type: "STRING" } },
  },
  required: ["summary", "topics", "kind", "lang", "imageCaptions"],
};

/**
 * Constructs canonical representation text for embedding (embedding-related-classify.md §1.2).
 * Excludes author and timestamp so same-author doesn't dominate semantic cosine similarity.
 */
export function buildRepresentationText(item: {
  title?: string | null;
  excerpt?: string | null;
  note?: string | null;
  card?: Partial<EnrichedCard> | null;
}): string {
  const card = item.card;
  const lines: string[] = [];
  if (item.title) lines.push(`标题: ${item.title}`);
  if (card?.summary) lines.push(`摘要: ${card.summary}`);
  if (card?.topics?.length) lines.push(`主题: ${card.topics.join(", ")}`);
  if (card?.imageCaptions?.length) {
    lines.push(`画面与图示: ${card.imageCaptions.join("；")}`);
  }
  if (item.note) lines.push(`备注: ${item.note}`);
  if (item.excerpt && !card?.summary) {
    lines.push(`正文: ${item.excerpt}`);
  } else if (item.excerpt) {
    // Strip duplicated summary lines if excerpt already contains them
    const rawPart = item.excerpt.split("\n摘要:")[0]?.trim();
    if (rawPart) lines.push(`原文: ${rawPart.slice(0, 600)}`);
  }
  return lines.filter(Boolean).join("\n").slice(0, 2000);
}
