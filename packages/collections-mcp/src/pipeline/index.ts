import { DecisionsClient } from "../ai/decisions.js";
import { computeDocInputHash, Embedder } from "../ai/embedder/index.js";
import { buildRepresentationText, EnrichedCard, EnrichItemInput, EnrichService } from "../ai/enrich.js";
import { QuotaExhaustedError } from "../ai/limiter.js";
import { TaxonomyNamer } from "../ai/taxonomy-namer.js";
import {
  classifyItems,
  minVectorsForClusterTaxonomy,
  proposeClusterTaxonomy,
  retryTaxonomyNaming,
  shouldRetryTaxonomyNaming,
} from "../classify/index.js";
import { CollectionsDB } from "../db/index.js";
import { VectorIndex } from "../index/vector.js";

export type PipelineStage = "enrich" | "embed" | "classify";

export interface PipelineRunReport {
  startedAt: string;
  finishedAt: string;
  items: number;
  enriched: number;
  enrichRequests: number;
  /** Items left without a card (model skipped them, request failed, or no key) — retried on next backfill. */
  enrichFailed: string[];
  embedded: number;
  /** Already had a vector for the same representation text. */
  embedUnchanged: number;
  embedFailed: string[];
  taxonomy: { action: "created" | "renamed"; nameSource: "llm" | "topics"; categories: number } | null;
  classified: Record<string, number> | null;
  errors: string[];
}

export interface PipelineStatus {
  state: "idle" | "running";
  queued: number;
  current: { stage: PipelineStage; done: number; total: number } | null;
  lastRun: PipelineRunReport | null;
}

export interface ItemPipelineOptions {
  db: CollectionsDB;
  index: VectorIndex;
  enrich: EnrichService;
  embedder: Embedder;
  /** False when no API key is configured: the run is skipped and reported instead of failing per item. */
  isAvailable: () => boolean;
  namer?: TaxonomyNamer;
  decisions?: DecisionsClient;
  useDecisionsFallback?: boolean;
  /** Items per enrich request (one generateContent call). */
  enrichBatchSize?: number;
  /** Attach each item's first image to the enrich request. */
  includeImages?: boolean;
  fetchFn?: typeof fetch;
  onProcessed?: (report: PipelineRunReport, itemIds: string[]) => void;
}

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const EMBED_CHUNK = 40;

/**
 * Post-sync pipeline (embedding-related-classify.md §6 "同步到新条目"):
 * enrich (batched) → embed → index.upsert → classify, for items queued by `app_sync` or a backfill.
 * Runs serially in the background so the MCP request that triggered it can return immediately.
 */
export class ItemPipeline {
  private readonly opts: ItemPipelineOptions;
  private readonly queue: string[] = [];
  /** Queued or currently being processed — both are skipped by `enqueue`. */
  private readonly pendingSet = new Set<string>();
  private running: Promise<void> | null = null;
  private current: PipelineStatus["current"] = null;
  private lastRun: PipelineRunReport | null = null;

  constructor(opts: ItemPipelineOptions) {
    this.opts = opts;
  }

  status(): PipelineStatus {
    return {
      state: this.running ? "running" : "idle",
      queued: this.queue.length,
      current: this.current,
      lastRun: this.lastRun,
    };
  }

  /** Adds ids to the queue (skipping ids already queued or in flight) and starts the worker loop if idle. */
  enqueue(ids: string[]): { queued: number } {
    let added = 0;
    for (const id of ids) {
      if (this.pendingSet.has(id)) continue;
      this.pendingSet.add(id);
      this.queue.push(id);
      added++;
    }
    if (added > 0 && !this.running) {
      this.running = this.loop().finally(() => {
        this.running = null;
        this.current = null;
      });
    }
    return { queued: added };
  }

  /** Resolves once the queue is empty (used by `wait: true` and tests). */
  async drain(): Promise<PipelineRunReport | null> {
    while (this.running) await this.running;
    return this.lastRun;
  }

  private async loop(): Promise<void> {
    while (this.queue.length > 0) {
      const ids = this.queue.splice(0, this.queue.length);
      try {
        this.lastRun = await this.processItems(ids);
        this.opts.onProcessed?.(this.lastRun, ids);
      } catch (err) {
        const now = new Date().toISOString();
        this.lastRun = emptyReport(now, ids.length, [String(err)]);
      } finally {
        for (const id of ids) this.pendingSet.delete(id);
      }
    }
  }

  async processItems(ids: string[]): Promise<PipelineRunReport> {
    const { db, index, enrich, embedder } = this.opts;
    const report = emptyReport(new Date().toISOString(), ids.length, []);
    if (!this.opts.isAvailable()) {
      report.errors.push("No API key configured: enrich/embedding skipped");
      report.enrichFailed = ids;
      report.finishedAt = new Date().toISOString();
      return report;
    }

    // ① Enrich items that have no card yet, N per request
    const needEnrich = db.getRawItems(ids).filter((r) => !r.raw?.enrichedCard);
    const batchSize = Math.max(1, this.opts.enrichBatchSize ?? 8);
    this.current = { stage: "enrich", done: 0, total: needEnrich.length };
    let quotaExhausted = false;
    for (let i = 0; i < needEnrich.length; i += batchSize) {
      const batch = needEnrich.slice(i, i + batchSize);
      if (quotaExhausted) {
        report.enrichFailed.push(...batch.map((b) => b.id));
        continue;
      }
      try {
        const inputs = await Promise.all(batch.map((r) => this.toEnrichInput(r)));
        const res = await enrich.enrichBatch(inputs, { priority: "incremental" });
        report.enrichRequests += res.requests;
        for (const [id, card] of res.cards) {
          if (db.setEnrichedCard(id, card as EnrichedCard & Record<string, unknown>)) report.enriched++;
        }
        report.enrichFailed.push(...res.failed);
      } catch (err) {
        report.errors.push(`enrich: ${err instanceof Error ? err.message : String(err)}`);
        report.enrichFailed.push(...batch.map((b) => b.id));
        if (err instanceof QuotaExhaustedError) quotaExhausted = true;
      }
      this.current.done = Math.min(needEnrich.length, i + batch.length);
    }

    // ② Embed the representation text (items without a card fall back to their excerpt)
    const rows = db.getRawItems(ids);
    const existingHash = new Map<string, string>();
    for (const r of db.db
      .prepare(
        `SELECT item_id, text_hash FROM embeddings WHERE model = ? AND item_id IN (${rows.map(() => "?").join(", ") || "''"})`,
      )
      .all(embedder.id, ...rows.map((r) => r.id)) as Array<{ item_id: string; text_hash: string }>) {
      existingHash.set(r.item_id, r.text_hash);
    }
    const toEmbed: Array<{ id: string; doc: { title: string | null; text: string }; hash: string }> = [];
    for (const r of rows) {
      const text = buildRepresentationText({
        title: r.title,
        excerpt: r.excerpt,
        note: r.note,
        card: r.raw?.enrichedCard ?? null,
      });
      if (!text) continue;
      const doc = { title: r.title, text };
      const hash = computeDocInputHash(embedder.id, doc);
      if (existingHash.get(r.id) === hash && index.has(r.id)) {
        report.embedUnchanged++;
        continue;
      }
      toEmbed.push({ id: r.id, doc, hash });
    }
    this.current = { stage: "embed", done: 0, total: toEmbed.length };
    for (let i = 0; i < toEmbed.length; i += EMBED_CHUNK) {
      const chunk = toEmbed.slice(i, i + EMBED_CHUNK);
      try {
        const vecs = await embedder.embedDocuments(
          chunk.map((c) => c.doc),
          { priority: "incremental" },
        );
        chunk.forEach((c, j) => {
          db.saveEmbedding(c.id, embedder.id, vecs[j], c.hash);
          index.upsert(c.id, vecs[j]);
          report.embedded++;
        });
      } catch (err) {
        report.errors.push(`embed: ${err instanceof Error ? err.message : String(err)}`);
        report.embedFailed.push(...chunk.map((c) => c.id));
      }
      this.current.done = Math.min(toEmbed.length, i + chunk.length);
    }

    // ③ Ensure cluster taxonomy exists (>= 25 vectors) or retry temporary topic names, then classify
    const withVec = ids.filter((id) => index.has(id));
    let taxonomyJustCreated = false;

    if (db.listCategories().length === 0 && index.size >= minVectorsForClusterTaxonomy()) {
      try {
        const proposed = await proposeClusterTaxonomy(db, index, { namer: this.opts.namer });
        taxonomyJustCreated = true;
        report.taxonomy = {
          action: "created",
          nameSource: proposed.nameSource,
          categories: proposed.categories.length,
        };
      } catch (err) {
        report.errors.push(`taxonomy: ${err instanceof Error ? err.message : String(err)}`);
      }
    } else if (this.opts.namer && shouldRetryTaxonomyNaming(db, this.opts.namer)) {
      try {
        const retried = await retryTaxonomyNaming(db, index, this.opts.namer);
        if (retried.updated > 0) {
          report.taxonomy = {
            action: "renamed",
            nameSource: retried.categories.some((c) => c.name_source === "topics") ? "topics" : "llm",
            categories: retried.categories.length,
          };
        } else if (retried.error) {
          report.errors.push(`taxonomy-retry: ${retried.error}`);
        }
      } catch (err) {
        report.errors.push(`taxonomy-retry: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const classifyTargetIds = taxonomyJustCreated ? index.allIds() : withVec;
    if (db.listCategories().length > 0 && classifyTargetIds.length > 0) {
      this.current = { stage: "classify", done: 0, total: classifyTargetIds.length };
      try {
        const useDecisions = Boolean(this.opts.useDecisionsFallback && this.opts.decisions?.isAvailable());
        const res = await classifyItems({
          db,
          index,
          itemIds: taxonomyJustCreated ? undefined : withVec,
          decisions: useDecisions ? this.opts.decisions : undefined,
          useDecisionsFallback: useDecisions,
        });
        report.classified = res.bySource;
      } catch (err) {
        report.errors.push(`classify: ${err instanceof Error ? err.message : String(err)}`);
      }
      this.current.done = classifyTargetIds.length;
    }

    report.finishedAt = new Date().toISOString();
    return report;
  }

  private async toEnrichInput(r: {
    id: string;
    author: string | null;
    excerpt: string | null;
    raw: Record<string, any> | null;
  }): Promise<EnrichItemInput> {
    const raw = r.raw ?? {};
    const input: EnrichItemInput = {
      id: r.id,
      author: r.author,
      text: [raw.title, raw.text].filter(Boolean).join("\n") || r.excerpt,
      articleText: raw.articleText ?? null,
      quoteText: raw.quote?.text ?? null,
      cardText: raw.card?.text ?? null,
      links: Array.isArray(raw.links) ? raw.links.map((l: any) => (typeof l === "string" ? l : l?.href ?? l?.url)).filter(Boolean) : [],
    };
    const src = raw.media?.[0]?.src ?? raw.quote?.media?.[0]?.src ?? raw.articleCover;
    if (this.opts.includeImages !== false && typeof src === "string" && src.startsWith("http")) {
      const img = await this.fetchImage(src);
      if (img) input.images = [img];
    }
    return input;
  }

  private async fetchImage(url: string): Promise<{ mimeType: string; base64Data: string } | null> {
    try {
      const res = await (this.opts.fetchFn ?? fetch)(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      const mimeType = (res.headers.get("content-type") || "").split(";")[0].trim();
      if (!mimeType.startsWith("image/")) return null;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.byteLength === 0 || buf.byteLength > MAX_IMAGE_BYTES) return null;
      return { mimeType, base64Data: buf.toString("base64") };
    } catch {
      return null;
    }
  }
}

function emptyReport(startedAt: string, items: number, errors: string[]): PipelineRunReport {
  return {
    startedAt,
    finishedAt: startedAt,
    items,
    enriched: 0,
    enrichRequests: 0,
    enrichFailed: [],
    embedded: 0,
    embedUnchanged: 0,
    embedFailed: [],
    taxonomy: null,
    classified: null,
    errors,
  };
}
