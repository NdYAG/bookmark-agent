import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const here = dirname(fileURLToPath(import.meta.url));

export interface ItemRow {
  id: string;
  source: string;
  source_item_id: string;
  account: string;
  url: string;
  canonical_url: string | null;
  title: string | null;
  excerpt: string | null;
  note: string | null;
  author: string | null;
  cover_url: string | null;
  cover_path: string | null;
  media_type: string | null;
  publish_date: string | null;
  collected_at: string | null;
  first_seen_at: string;
  updated_at: string;
  deleted_at: string | null;
  user_overrides: string;
  raw: string | null;
  category_id?: string | null;
}

export interface UpsertItemInput {
  id?: string;
  source: string;
  source_item_id: string;
  account?: string;
  url: string;
  canonical_url?: string | null;
  title?: string | null;
  excerpt?: string | null;
  note?: string | null;
  author?: string | null;
  cover_url?: string | null;
  cover_path?: string | null;
  media_type?: string | null;
  publish_date?: string | null;
  collected_at?: string | null;
  first_seen_at?: string;
  raw?: string | null;
}

export interface SearchOptions {
  query: string;
  category?: string;
  source?: string;
  from?: string;
  to?: string;
  limit?: number;
}

export interface SourceRow {
  id: string;
  adapter: string;
  account: string | null;
  identity: string | null;
  cursor: string | null;
  last_sync_at: string | null;
  last_status: string | null;
  settings: string | null;
}

export interface ItemContentRow {
  item_id: string;
  text: string | null;
  fetched_at: string;
  status: string;
}

export type CategoryNameSource = "topics" | "llm" | "user";

export interface AppListItemsOptions {
  page?: number;
  pageSize?: number;
  filter?: {
    source?: string;
    category?: string;
    author?: string;
    mediaType?: string;
    query?: string;
  };
  sort?: "first_seen_desc" | "first_seen_asc" | "publish_desc" | "publish_asc";
}

function resolveSchemaSql(): string {
  // Support both dist/db/index.js and src/db/index.ts
  const candidates = [
    join(here, "schema.sql"),
    join(here, "../../src/db/schema.sql"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, "utf8");
  }
  throw new Error(`Could not find schema.sql in ${candidates.join(", ")}`);
}

export interface StoredEnrichedCard {
  summary?: string;
  topics?: string[];
  imageCaptions?: string[];
  [key: string]: unknown;
}

const CARD_EXCERPT_MARKER = "\n摘要: ";

/**
 * Appends the card's summary/topics/captions to an excerpt (same layout as fixture import) so FTS
 * and the embedding representation text see them. Idempotent: an excerpt that already carries a
 * card block is rebuilt from its original part.
 */
export function excerptWithCard(excerpt: string | null, card: StoredEnrichedCard): string | null {
  const base = (excerpt ?? "").split(CARD_EXCERPT_MARKER)[0].replace(/^摘要: [\s\S]*$/, "").trim();
  const parts: string[] = base ? [base] : [];
  if (card.summary) parts.push(`摘要: ${card.summary}`);
  if (Array.isArray(card.topics) && card.topics.length) parts.push(`主题: ${card.topics.join(", ")}`);
  if (Array.isArray(card.imageCaptions) && card.imageCaptions.length) {
    parts.push(`配图: ${card.imageCaptions.join("；")}`);
  }
  return parts.join("\n").trim() || null;
}

export function canonicalizeUrl(rawUrl: string): string {
  try {
    const u = new URL(rawUrl);
    for (const k of [...u.searchParams.keys()]) {
      if (k.startsWith("utm_") || k === "s" || k === "t" || k === "ref_src") {
        u.searchParams.delete(k);
      }
    }
    return u.toString();
  } catch {
    return rawUrl;
  }
}

export class CollectionsDB {
  readonly db: Database.Database;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") {
      mkdirSync(dirname(dbPath), { recursive: true });
    }
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.migrate();
  }

  private migrate(): void {
    const sql = resolveSchemaSql();
    this.db.exec(sql);
    const cols = this.db.pragma("table_info(categories)") as Array<{ name: string }>;
    if (!cols.some((c) => c.name === "name_source")) {
      this.db.exec("ALTER TABLE categories ADD COLUMN name_source TEXT NOT NULL DEFAULT 'llm'");
    }
  }

  getAppMeta<T = unknown>(key: string): T | null {
    const row = this.db.prepare("SELECT value FROM app_meta WHERE key = ?").get(key) as
      | { value: string | null }
      | undefined;
    if (!row?.value) return null;
    try {
      return JSON.parse(row.value) as T;
    } catch {
      return null;
    }
  }

  setAppMeta(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO app_meta (key, value)
         VALUES (?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      )
      .run(key, JSON.stringify(value));
  }

  deleteAppMeta(key: string): void {
    this.db.prepare("DELETE FROM app_meta WHERE key = ?").run(key);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Shared upsert path for fixture import & live sync:
   * - Respects soft-delete tombstones (`deleted_at IS NOT NULL`): never resurrects deleted items!
   * - Respects `user_overrides` JSON: never overwrites fields edited by the user!
   */
  upsertItem(input: UpsertItemInput): { id: string; status: "inserted" | "updated" | "tombstoned" } {
    const account = input.account ?? "";
    const existing = this.db
      .prepare(
        "SELECT * FROM items WHERE source = ? AND account = ? AND source_item_id = ?",
      )
      .get(input.source, account, input.source_item_id) as ItemRow | undefined;

    const now = new Date().toISOString();

    if (existing) {
      // Do NOT resurrect soft-deleted items!
      if (existing.deleted_at) {
        return { id: existing.id, status: "tombstoned" };
      }

      let overrides: Record<string, boolean> = {};
      try {
        overrides = JSON.parse(existing.user_overrides || "{}");
      } catch {
        overrides = {};
      }

      const nextTitle = overrides.title ? existing.title : (input.title ?? existing.title);
      const nextExcerpt = overrides.excerpt ? existing.excerpt : (input.excerpt ?? existing.excerpt);
      const nextNote = overrides.note ? existing.note : (input.note ?? existing.note);
      const nextAuthor = overrides.author ? existing.author : (input.author ?? existing.author);
      const nextCoverUrl = input.cover_url ?? existing.cover_url;
      const nextMediaType = input.media_type ?? existing.media_type;
      const nextPublishDate = input.publish_date ?? existing.publish_date;
      const nextCanonicalUrl =
        input.canonical_url ?? existing.canonical_url ?? canonicalizeUrl(input.url);
      let nextRaw = input.raw ?? existing.raw;
      // A re-synced item arrives without its enrichment: carry the card (and its excerpt lines) over
      let carriedCard: StoredEnrichedCard | null = null;
      if (input.raw && existing.raw) {
        try {
          const prevCard = JSON.parse(existing.raw)?.enrichedCard;
          const incoming = JSON.parse(input.raw);
          if (prevCard && incoming && typeof incoming === "object" && !incoming.enrichedCard) {
            incoming.enrichedCard = prevCard;
            nextRaw = JSON.stringify(incoming);
            carriedCard = prevCard;
          }
        } catch {
          // Keep incoming raw as-is when either side is not JSON
        }
      }
      const finalExcerpt =
        carriedCard && !overrides.excerpt ? excerptWithCard(nextExcerpt, carriedCard) : nextExcerpt;

      this.db
        .prepare(
          `UPDATE items
           SET url = ?,
               canonical_url = ?,
               title = ?,
               excerpt = ?,
               note = ?,
               author = ?,
               cover_url = ?,
               media_type = ?,
               publish_date = ?,
               updated_at = ?,
               raw = ?
           WHERE id = ?`,
        )
        .run(
          input.url,
          nextCanonicalUrl,
          nextTitle,
          finalExcerpt,
          nextNote,
          nextAuthor,
          nextCoverUrl,
          nextMediaType,
          nextPublishDate,
          now,
          nextRaw,
          existing.id,
        );

      return { id: existing.id, status: "updated" };
    }

    const id = input.id || `${input.source}:${input.source_item_id}`;
    const firstSeenAt = input.first_seen_at || now;
    const canonicalUrl = input.canonical_url ?? canonicalizeUrl(input.url);

    this.db
      .prepare(
        `INSERT INTO items (
          id, source, source_item_id, account, url, canonical_url,
          title, excerpt, note, author, cover_url, cover_path,
          media_type, publish_date, collected_at, first_seen_at,
          updated_at, deleted_at, user_overrides, raw
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, '{}', ?)`,
      )
      .run(
        id,
        input.source,
        input.source_item_id,
        account,
        input.url,
        canonicalUrl,
        input.title ?? null,
        input.excerpt ?? null,
        input.note ?? null,
        input.author ?? null,
        input.cover_url ?? null,
        input.cover_path ?? null,
        input.media_type ?? "post",
        input.publish_date ?? null,
        input.collected_at ?? null,
        firstSeenAt,
        now,
        input.raw ?? null,
      );

    return { id, status: "inserted" };
  }

  /**
   * Import scraped bookmarks from a JSON snapshot file (supports single-source or mixed-source arrays).
   * Also imports embeddings if embeddings.json is present next to the file.
   */
  importFixturesFromFile(
    filePath: string,
    opts?: { source?: "x" | "xhs"; identityId?: string },
  ): {
    total: number;
    inserted: number;
    updated: number;
    tombstoned: number;
    embeddingsLoaded: number;
  } {
    const rawData = JSON.parse(readFileSync(filePath, "utf8")) as Array<Record<string, any>>;
    const inferredSource: "x" | "xhs" =
      opts?.source ||
      (filePath.includes("/xhs/") ||
      (rawData[0]?.url && String(rawData[0].url).includes("xiaohongshu.com"))
        ? "xhs"
        : "x");

    let inserted = 0;
    let updated = 0;
    let tombstoned = 0;

    // Preserve bookmark list order via synthetic first_seen_at offsets when importing a batch
    const baseTimeMs = Date.now();
    const latestCursorBySource = new Map<"x" | "xhs", string>();

    const tx = this.db.transaction((records: Array<Record<string, any>>) => {
      for (let i = 0; i < records.length; i++) {
        const rec = records[i];
        const recSource: "x" | "xhs" =
          opts?.source ||
          (rec.source === "xhs" || (rec.url && String(rec.url).includes("xiaohongshu.com"))
            ? "xhs"
            : rec.source === "x"
              ? "x"
              : inferredSource);
        const sourceItemId = String(rec.id);
        if (!latestCursorBySource.has(recSource) && rec.id) {
          latestCursorBySource.set(recSource, sourceItemId);
        }
        const handle = rec.author?.handle || "";
        const name = rec.author?.name || "";
        const author =
          recSource === "xhs"
            ? name || handle || null
            : handle && name
              ? `@${handle} (${name})`
              : handle
                ? `@${handle}`
                : name || null;

        // Build rich excerpt combining original title/text/articleText/quote/card + enrichedCard summary & topics
        const excerptParts: string[] = [];
        if (rec.title && recSource === "xhs") excerptParts.push(String(rec.title));
        if (rec.text && rec.text !== rec.title) excerptParts.push(String(rec.text));
        if (rec.articleText) excerptParts.push(String(rec.articleText));
        if (rec.quote?.text) {
          const qHandle = rec.quote.author?.handle ? `@${rec.quote.author.handle}: ` : "";
          excerptParts.push(`[引用 ${qHandle}${rec.quote.text}]`);
        }
        if (rec.card?.text) {
          excerptParts.push(`[链接卡片: ${rec.card.text}]`);
        }
        if (rec.likes && recSource === "xhs") {
          excerptParts.push(`[小红书点赞: ${rec.likes}]`);
        }
        if (rec.enrichedCard) {
          if (rec.enrichedCard.summary) {
            excerptParts.push(`摘要: ${rec.enrichedCard.summary}`);
          }
          if (Array.isArray(rec.enrichedCard.topics) && rec.enrichedCard.topics.length) {
            excerptParts.push(`主题: ${rec.enrichedCard.topics.join(", ")}`);
          }
          if (
            Array.isArray(rec.enrichedCard.imageCaptions) &&
            rec.enrichedCard.imageCaptions.length
          ) {
            excerptParts.push(`配图: ${rec.enrichedCard.imageCaptions.join("；")}`);
          }
        }

        const title =
          rec.title ||
          rec.card?.text ||
          (rec.enrichedCard?.topics?.length
            ? rec.enrichedCard.topics.slice(0, 3).join(" · ")
            : null);

        const coverUrl =
          rec.articleCover ||
          (Array.isArray(rec.media) && rec.media[0]?.src) ||
          (Array.isArray(rec.quote?.media) && rec.quote.media[0]?.src) ||
          null;

        const orderIndex = typeof rec.order === "number" ? rec.order : i;
        const firstSeenAt = new Date(baseTimeMs - orderIndex * 1000).toISOString();

        const defaultUrl =
          recSource === "xhs"
            ? `https://www.xiaohongshu.com/explore/${sourceItemId}`
            : `https://x.com/i/status/${sourceItemId}`;

        const canonicalUrl =
          rec.canonicalUrl ||
          (recSource === "xhs"
            ? `https://www.xiaohongshu.com/explore/${sourceItemId}`
            : undefined);

        const res = this.upsertItem({
          id: `${recSource}:${sourceItemId}`,
          source: recSource,
          source_item_id: sourceItemId,
          account: "default",
          url: rec.url || defaultUrl,
          canonical_url: canonicalUrl,
          title,
          excerpt: excerptParts.join("\n").trim() || null,
          author,
          cover_url: coverUrl,
          media_type: rec.kind || "post",
          publish_date: rec.time || null,
          first_seen_at: firstSeenAt,
          raw: JSON.stringify(rec),
        });

        if (res.status === "inserted") inserted++;
        else if (res.status === "updated") updated++;
        else if (res.status === "tombstoned") tombstoned++;
      }
    });

    tx(rawData);

    const nowIso = new Date().toISOString();
    for (const [src, cursor] of latestCursorBySource.entries()) {
      const identityId =
        opts?.identityId || (src === "xhs" ? "xhs-prod-main" : "x-prod-main");
      this.upsertSource({
        id: src,
        adapter: src,
        account: "default",
        identity: identityId,
        cursor,
        last_sync_at: nowIso,
        last_status: "OK",
      });
    }

    // Also load precomputed embeddings if embeddings.json exists in same directory
    let embeddingsLoaded = 0;
    const embPath = join(dirname(filePath), "embeddings.json");
    if (existsSync(embPath)) {
      try {
        const embJson = JSON.parse(readFileSync(embPath, "utf8")) as {
          embedder_id?: string;
          dim?: number;
          vectors?: Record<string, number[]>;
        };
        const model = embJson.embedder_id || "gemini-embedding-2@768";
        const dim = embJson.dim || 768;
        const vectors = embJson.vectors || {};
        const stmt = this.db.prepare(
          `INSERT OR REPLACE INTO embeddings (item_id, model, dim, vec, text_hash)
           VALUES (?, ?, ?, ?, ?)`,
        );
        const embTx = this.db.transaction(() => {
          for (const [rawId, vals] of Object.entries(vectors)) {
            if (!Array.isArray(vals)) continue;
            const itemId = rawId.includes(":") ? rawId : `${inferredSource}:${rawId}`;
            const f32 = new Float32Array(vals);
            const buf = Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
            stmt.run(itemId, model, dim, buf, "imported");
            embeddingsLoaded++;
          }
        });
        embTx();
      } catch {
        // Ignore embeddings import errors in M0
      }
    }

    return {
      total: rawData.length,
      inserted,
      updated,
      tombstoned,
      embeddingsLoaded,
    };
  }

  /**
   * LLM Tool: `search`
   * - Uses FTS5 trigram when query tokens >= 3 chars
   * - Automatically falls back to (or combines with) LIKE for short tokens (< 3 chars, e.g. "设计", "AI")
   * - Multi-token queries (e.g. "Rust 异步") support matching each token across title/excerpt/author/note
   */
  search(opts: SearchOptions): Array<{
    id: string;
    title: string | null;
    excerpt: string;
    author: string | null;
    url: string;
    source: string;
    media_type: string | null;
    publish_date: string | null;
    first_seen_at: string;
    category: string | null;
  }> {
    const limit = Math.min(Math.max(opts.limit ?? 20, 1), 100);
    const rawQuery = (opts.query || "").trim();

    const filterClauses: string[] = ["i.deleted_at IS NULL"];
    const filterParams: unknown[] = [];

    if (opts.source) {
      filterClauses.push("i.source = ?");
      filterParams.push(opts.source);
    }
    if (opts.category) {
      if (opts.category === "uncategorized") {
        filterClauses.push("ic.category_id IS NULL");
      } else {
        filterClauses.push("ic.category_id = ?");
        filterParams.push(opts.category);
      }
    }
    if (opts.from) {
      filterClauses.push("COALESCE(i.publish_date, i.first_seen_at) >= ?");
      filterParams.push(opts.from);
    }
    if (opts.to) {
      filterClauses.push("COALESCE(i.publish_date, i.first_seen_at) <= ?");
      filterParams.push(opts.to);
    }

    const tokens = rawQuery
      .split(/\s+/)
      .map((t) => t.trim())
      .filter(Boolean);

    let rows: ItemRow[] = [];

    if (tokens.length === 0) {
      const sql = `
        SELECT i.*, ic.category_id
        FROM items i
        LEFT JOIN item_category ic ON ic.item_id = i.id
        WHERE ${filterClauses.join(" AND ")}
        ORDER BY i.first_seen_at DESC
        LIMIT ?
      `;
      rows = this.db.prepare(sql).all(...filterParams, limit) as ItemRow[];
    } else {
      // Check if all tokens have length >= 3 (FTS5 trigram requires >= 3 characters per token)
      const allLongTokens = tokens.every((t) => [...t].length >= 3);

      if (allLongTokens) {
        // Escape double quotes for FTS5 phrase matching
        const ftsExpr = tokens.map((t) => `"${t.replace(/"/g, '""')}"`).join(" AND ");
        try {
          const ftsSql = `
            SELECT i.*, ic.category_id
            FROM items_fts f
            JOIN items i ON i.rowid = f.rowid
            LEFT JOIN item_category ic ON ic.item_id = i.id
            WHERE items_fts MATCH ?
              AND ${filterClauses.join(" AND ")}
            ORDER BY bm25(items_fts) ASC, i.first_seen_at DESC
            LIMIT ?
          `;
          rows = this.db.prepare(ftsSql).all(ftsExpr, ...filterParams, limit) as ItemRow[];
        } catch {
          rows = [];
        }
      }

      // Fallback or mixed-length query (e.g. "Rust 异步" where "异步" is 2 chars, or "设计", "AI"):
      // Require ALL tokens to appear in (title || excerpt || author || note), and if still < limit and multi-token, allow ANY token ranked by match count
      if (rows.length === 0) {
        const tokenWhere = tokens.map(
          () =>
            "(COALESCE(i.title, '') || '\n' || COALESCE(i.excerpt, '') || '\n' || COALESCE(i.author, '') || '\n' || COALESCE(i.note, '')) LIKE ? COLLATE NOCASE",
        );
        const tokenParams = tokens.map((t) => `%${t}%`);
        const likeSql = `
          SELECT i.*, ic.category_id
          FROM items i
          LEFT JOIN item_category ic ON ic.item_id = i.id
          WHERE ${filterClauses.join(" AND ")}
            AND ${tokenWhere.join(" AND ")}
          ORDER BY i.first_seen_at DESC
          LIMIT ?
        `;
        rows = this.db
          .prepare(likeSql)
          .all(...filterParams, ...tokenParams, limit) as ItemRow[];
      }

      // Soft OR fallback if strict AND returned 0 for a multi-word natural language query
      if (rows.length === 0 && tokens.length > 1) {
        const scoreExpr = tokens
          .map(
            () =>
              "CASE WHEN (COALESCE(i.title, '') || '\n' || COALESCE(i.excerpt, '') || '\n' || COALESCE(i.author, '') || '\n' || COALESCE(i.note, '')) LIKE ? COLLATE NOCASE THEN 1 ELSE 0 END",
          )
          .join(" + ");
        const orWhere = tokens
          .map(
            () =>
              "(COALESCE(i.title, '') || '\n' || COALESCE(i.excerpt, '') || '\n' || COALESCE(i.author, '') || '\n' || COALESCE(i.note, '')) LIKE ? COLLATE NOCASE",
          )
          .join(" OR ");
        const tokenParams = tokens.map((t) => `%${t}%`);
        const orSql = `
          SELECT i.*, ic.category_id, (${scoreExpr}) AS match_count
          FROM items i
          LEFT JOIN item_category ic ON ic.item_id = i.id
          WHERE ${filterClauses.join(" AND ")}
            AND (${orWhere})
          ORDER BY match_count DESC, i.first_seen_at DESC
          LIMIT ?
        `;
        rows = this.db
          .prepare(orSql)
          .all(...tokenParams, ...filterParams, ...tokenParams, limit) as ItemRow[];
      }
    }

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      excerpt: (r.excerpt || "").slice(0, 360),
      author: r.author,
      url: r.url,
      source: r.source,
      media_type: r.media_type,
      publish_date: r.publish_date,
      first_seen_at: r.first_seen_at,
      category: r.category_id ?? null,
    }));
  }

  /**
   * LLM Tool: `get_items(ids)`
   */
  getItems(ids: string[]): Array<Record<string, unknown>> {
    if (!ids.length) return [];
    // Normalize bare numeric X tweet IDs if caller passes "1000000000000000001" or "x:1000000000000000001"
    const normalizedIds = Array.from(
      new Set(
        ids.flatMap((id) =>
          id.includes(":") ? [id] : [id, `x:${id}`, `xhs:${id}`],
        ),
      ),
    );
    const placeholders = normalizedIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT i.*, ic.category_id
         FROM items i
         LEFT JOIN item_category ic ON ic.item_id = i.id
         WHERE i.id IN (${placeholders}) AND i.deleted_at IS NULL`,
      )
      .all(...normalizedIds) as ItemRow[];

    return rows.map((r) => {
      let parsedRaw: Record<string, unknown> | null = null;
      if (r.raw) {
        try {
          parsedRaw = JSON.parse(r.raw);
        } catch {
          parsedRaw = null;
        }
      }
      return {
        id: r.id,
        source: r.source,
        source_item_id: r.source_item_id,
        url: r.url,
        canonical_url: r.canonical_url,
        title: r.title,
        excerpt: r.excerpt,
        note: r.note,
        author: r.author,
        cover_url: r.cover_url,
        media_type: r.media_type,
        publish_date: r.publish_date,
        first_seen_at: r.first_seen_at,
        updated_at: r.updated_at,
        category: r.category_id ?? null,
        enriched_card: parsedRaw?.enrichedCard ?? null,
        links: parsedRaw?.links ?? [],
        media: parsedRaw?.media ?? [],
        quote: parsedRaw?.quote ?? null,
      };
    });
  }

  /**
   * LLM Tool: `stats()`
   */
  stats(): Record<string, unknown> {
    const totalActive = (
      this.db
        .prepare("SELECT COUNT(*) as c FROM items WHERE deleted_at IS NULL")
        .get() as { c: number }
    ).c;
    const totalDeleted = (
      this.db
        .prepare("SELECT COUNT(*) as c FROM items WHERE deleted_at IS NOT NULL")
        .get() as { c: number }
    ).c;
    const totalEmbeddings = (
      this.db.prepare("SELECT COUNT(*) as c FROM embeddings").get() as { c: number }
    ).c;

    const bySource = this.db
      .prepare(
        "SELECT source, COUNT(*) as count FROM items WHERE deleted_at IS NULL GROUP BY source ORDER BY count DESC",
      )
      .all();

    const byMediaType = this.db
      .prepare(
        "SELECT media_type, COUNT(*) as count FROM items WHERE deleted_at IS NULL GROUP BY media_type ORDER BY count DESC",
      )
      .all();

    const byCategory = this.db
      .prepare(
        `SELECT COALESCE(ic.category_id, 'uncategorized') as category, COUNT(*) as count
         FROM items i
         LEFT JOIN item_category ic ON ic.item_id = i.id
         WHERE i.deleted_at IS NULL
         GROUP BY category
         ORDER BY count DESC`,
      )
      .all();

    const topAuthors = this.db
      .prepare(
        `SELECT author, COUNT(*) as count
         FROM items
         WHERE deleted_at IS NULL AND author IS NOT NULL
         GROUP BY author
         ORDER BY count DESC
         LIMIT 10`,
      )
      .all();

    const dateRange = this.db
      .prepare(
        `SELECT MIN(publish_date) as earliest_publish_date,
                MAX(publish_date) as latest_publish_date,
                MAX(first_seen_at) as last_imported_at
         FROM items
         WHERE deleted_at IS NULL`,
      )
      .get();

    return {
      total_active_items: totalActive,
      total_deleted_tombstones: totalDeleted,
      total_embeddings: totalEmbeddings,
      by_source: bySource,
      by_media_type: byMediaType,
      by_category: byCategory,
      top_authors: topAuthors,
      date_range: dateRange,
    };
  }

  /**
   * LLM Tool: `update(id, fields)`
   * Records modified fields in `user_overrides` so future imports/syncs never overwrite them.
   */
  updateItem(
    rawId: string,
    patch: { title?: string; excerpt?: string; note?: string; category?: string },
  ): { ok: boolean; item?: Record<string, unknown>; error?: string } {
    const row = this.findActiveById(rawId);
    if (!row) {
      return { ok: false, error: `Item not found: ${rawId}` };
    }

    let overrides: Record<string, boolean> = {};
    try {
      overrides = JSON.parse(row.user_overrides || "{}");
    } catch {
      overrides = {};
    }

    const nextTitle = patch.title !== undefined ? patch.title : row.title;
    const nextExcerpt = patch.excerpt !== undefined ? patch.excerpt : row.excerpt;
    const nextNote = patch.note !== undefined ? patch.note : row.note;

    if (patch.title !== undefined) overrides.title = true;
    if (patch.excerpt !== undefined) overrides.excerpt = true;
    if (patch.note !== undefined) overrides.note = true;
    if (patch.category !== undefined) overrides.category = true;

    const now = new Date().toISOString();
    this.db
      .prepare(
        `UPDATE items
         SET title = ?,
             excerpt = ?,
             note = ?,
             user_overrides = ?,
             updated_at = ?
         WHERE id = ?`,
      )
      .run(nextTitle, nextExcerpt, nextNote, JSON.stringify(overrides), now, row.id);

    if (patch.category !== undefined) {
      this.db
        .prepare(
          `INSERT INTO item_category (item_id, category_id, score, source)
           VALUES (?, ?, 1.0, 'user')
           ON CONFLICT(item_id) DO UPDATE SET category_id = excluded.category_id, score = 1.0, source = 'user'`,
        )
        .run(row.id, patch.category);
    }

    return { ok: true, item: this.getItems([row.id])[0] };
  }

  /**
   * LLM Tool: `remove(id)`
   * Soft-deletes the item by setting `deleted_at` tombstone.
   */
  removeItem(rawId: string): { ok: boolean; id?: string; deleted_at?: string; error?: string } {
    const row = this.findActiveById(rawId);
    if (!row) {
      return { ok: false, error: `Item not found or already deleted: ${rawId}` };
    }
    const now = new Date().toISOString();
    this.db.prepare("UPDATE items SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, row.id);
    return { ok: true, id: row.id, deleted_at: now };
  }

  /**
   * App Tool: `app_list_items` (pagination, filtering, sorting for UI Grid)
   */
  appListItems(opts: AppListItemsOptions = {}): {
    items: Array<Record<string, unknown>>;
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  } {
    const page = Math.max(opts.page ?? 1, 1);
    const pageSize = Math.min(Math.max(opts.pageSize ?? 24, 1), 100);
    const offset = (page - 1) * pageSize;

    const where: string[] = ["i.deleted_at IS NULL"];
    const params: unknown[] = [];

    const f = opts.filter || {};
    if (f.source) {
      where.push("i.source = ?");
      params.push(f.source);
    }
    if (f.category) {
      if (f.category === "uncategorized") {
        where.push("ic.category_id IS NULL");
      } else {
        where.push("ic.category_id = ?");
        params.push(f.category);
      }
    }
    if (f.mediaType) {
      where.push("i.media_type = ?");
      params.push(f.mediaType);
    }
    if (f.author) {
      where.push("i.author LIKE ? COLLATE NOCASE");
      params.push(`%${f.author}%`);
    }
    if (f.query && f.query.trim()) {
      where.push(
        "(COALESCE(i.title, '') || '\n' || COALESCE(i.excerpt, '') || '\n' || COALESCE(i.author, '') || '\n' || COALESCE(i.note, '')) LIKE ? COLLATE NOCASE",
      );
      params.push(`%${f.query.trim()}%`);
    }

    const sortMap: Record<NonNullable<AppListItemsOptions["sort"]>, string> = {
      first_seen_desc: "i.first_seen_at DESC",
      first_seen_asc: "i.first_seen_at ASC",
      publish_desc: "COALESCE(i.publish_date, i.first_seen_at) DESC",
      publish_asc: "COALESCE(i.publish_date, i.first_seen_at) ASC",
    };
    const orderBy = sortMap[opts.sort || "first_seen_desc"] || "i.first_seen_at DESC";

    const countSql = `
      SELECT COUNT(*) as total
      FROM items i
      LEFT JOIN item_category ic ON ic.item_id = i.id
      WHERE ${where.join(" AND ")}
    `;
    const total = (this.db.prepare(countSql).get(...params) as { total: number }).total;

    const listSql = `
      SELECT i.*, ic.category_id
      FROM items i
      LEFT JOIN item_category ic ON ic.item_id = i.id
      WHERE ${where.join(" AND ")}
      ORDER BY ${orderBy}
      LIMIT ? OFFSET ?
    `;
    const rows = this.db.prepare(listSql).all(...params, pageSize, offset) as ItemRow[];

    return {
      items: rows.map((r) => ({
        id: r.id,
        source: r.source,
        source_item_id: r.source_item_id,
        url: r.url,
        title: r.title,
        excerpt: r.excerpt,
        note: r.note,
        author: r.author,
        cover_url: r.cover_url,
        media_type: r.media_type,
        publish_date: r.publish_date,
        first_seen_at: r.first_seen_at,
        category: r.category_id ?? null,
      })),
      page,
      pageSize,
      total,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  private findActiveById(rawId: string): ItemRow | undefined {
    const candidates = rawId.includes(":") ? [rawId] : [rawId, `x:${rawId}`, `xhs:${rawId}`];
    for (const id of candidates) {
      const row = this.db
        .prepare("SELECT * FROM items WHERE id = ? AND deleted_at IS NULL")
        .get(id) as ItemRow | undefined;
      if (row) return row;
    }
    return undefined;
  }

  getSource(id: string): SourceRow | undefined {
    return this.db.prepare("SELECT * FROM sources WHERE id = ?").get(id) as
      | SourceRow
      | undefined;
  }

  listSources(): SourceRow[] {
    return this.db.prepare("SELECT * FROM sources ORDER BY id ASC").all() as SourceRow[];
  }

  upsertSource(row: {
    id: string;
    adapter: string;
    account?: string | null;
    identity?: string | null;
    cursor?: string | null;
    last_sync_at?: string | null;
    last_status?: string | null;
    settings?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO sources (id, adapter, account, identity, cursor, last_sync_at, last_status, settings)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           adapter = excluded.adapter,
           account = COALESCE(excluded.account, sources.account),
           identity = COALESCE(excluded.identity, sources.identity),
           cursor = COALESCE(excluded.cursor, sources.cursor),
           last_sync_at = COALESCE(excluded.last_sync_at, sources.last_sync_at),
           last_status = COALESCE(excluded.last_status, sources.last_status),
           settings = COALESCE(excluded.settings, sources.settings)`,
      )
      .run(
        row.id,
        row.adapter,
        row.account ?? "default",
        row.identity ?? null,
        row.cursor ?? null,
        row.last_sync_at ?? null,
        row.last_status ?? null,
        row.settings ?? null,
      );
  }

  getItemContent(itemId: string): ItemContentRow | undefined {
    const candidates = itemId.includes(":")
      ? [itemId]
      : [itemId, `x:${itemId}`, `xhs:${itemId}`];
    for (const id of candidates) {
      const row = this.db
        .prepare("SELECT * FROM item_content WHERE item_id = ?")
        .get(id) as ItemContentRow | undefined;
      if (row) return row;
    }
    return undefined;
  }

  upsertItemContent(row: ItemContentRow): void {
    this.db
      .prepare(
        `INSERT INTO item_content (item_id, text, fetched_at, status)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(item_id) DO UPDATE SET
           text = excluded.text,
           fetched_at = excluded.fetched_at,
           status = excluded.status`,
      )
      .run(row.item_id, row.text, row.fetched_at, row.status);
  }

  getPairCacheMany(
    targetId: string,
    candidateIds: string[],
    model: string,
  ): Map<string, { score: number; confidence: number }> {
    const out = new Map<string, { score: number; confidence: number }>();
    if (!candidateIds.length) return out;
    const placeholders = candidateIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT candidate_id, score, confidence
         FROM pair_cache
         WHERE target_id = ? AND model = ? AND candidate_id IN (${placeholders})`,
      )
      .all(targetId, model, ...candidateIds) as Array<{
      candidate_id: string;
      score: number;
      confidence: number;
    }>;
    for (const r of rows) {
      out.set(r.candidate_id, { score: r.score, confidence: r.confidence });
    }
    return out;
  }

  upsertPairCache(row: {
    target_id: string;
    candidate_id: string;
    model: string;
    score: number;
    confidence: number;
    raw_answer?: string | null;
  }): void {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO pair_cache (target_id, candidate_id, model, score, confidence, raw_answer, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(target_id, candidate_id, model) DO UPDATE SET
           score = excluded.score,
           confidence = excluded.confidence,
           raw_answer = excluded.raw_answer,
           updated_at = excluded.updated_at`,
      )
      .run(
        row.target_id,
        row.candidate_id,
        row.model,
        row.score,
        row.confidence,
        row.raw_answer ?? null,
        now,
      );
  }

  /** Items (not deleted) with their parsed raw payload, for the enrich → embed pipeline. */
  getRawItems(ids: string[]): Array<{
    id: string;
    title: string | null;
    excerpt: string | null;
    note: string | null;
    author: string | null;
    raw: Record<string, any> | null;
  }> {
    if (!ids.length) return [];
    const rows = this.db
      .prepare(
        `SELECT id, title, excerpt, note, author, raw FROM items
         WHERE id IN (${ids.map(() => "?").join(", ")}) AND deleted_at IS NULL`,
      )
      .all(...ids) as Array<{ id: string; title: string | null; excerpt: string | null; note: string | null; author: string | null; raw: string | null }>;
    return rows.map((r) => {
      let raw: Record<string, any> | null = null;
      try {
        raw = r.raw ? JSON.parse(r.raw) : null;
      } catch {
        raw = null;
      }
      return { ...r, raw };
    });
  }

  /**
   * Stores an enrich card in `raw.enrichedCard`, appends it to the excerpt and fills an empty title
   * from the topics — mirroring fixture import. Fields in `user_overrides` are left untouched.
   */
  setEnrichedCard(id: string, card: StoredEnrichedCard): boolean {
    const row = this.db
      .prepare("SELECT title, excerpt, raw, user_overrides FROM items WHERE id = ? AND deleted_at IS NULL")
      .get(id) as { title: string | null; excerpt: string | null; raw: string | null; user_overrides: string } | undefined;
    if (!row) return false;
    let raw: Record<string, unknown> = {};
    let overrides: Record<string, boolean> = {};
    try {
      raw = row.raw ? JSON.parse(row.raw) : {};
    } catch {
      raw = { original: row.raw };
    }
    try {
      overrides = JSON.parse(row.user_overrides || "{}");
    } catch {
      overrides = {};
    }
    raw.enrichedCard = card;
    const excerpt = overrides.excerpt ? row.excerpt : excerptWithCard(row.excerpt, card);
    const title =
      row.title || overrides.title || !card.topics?.length ? row.title : card.topics.slice(0, 3).join(" · ");
    this.db
      .prepare("UPDATE items SET raw = ?, excerpt = ?, title = ?, updated_at = ? WHERE id = ?")
      .run(JSON.stringify(raw), excerpt, title, new Date().toISOString(), id);
    return true;
  }

  saveEmbedding(itemId: string, model: string, vec: Float32Array, textHash: string): void {
    const buf = Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
    this.db
      .prepare(
        `INSERT OR REPLACE INTO embeddings (item_id, model, dim, vec, text_hash) VALUES (?, ?, ?, ?, ?)`,
      )
      .run(itemId, model, vec.length, buf, textHash);
  }

  /** Active items lacking an enrich card or a vector for `model`. */
  listItemIdsNeedingProcessing(model: string, limit = 5000): string[] {
    const rows = this.db
      .prepare(
        `SELECT i.id FROM items i
         LEFT JOIN embeddings e ON e.item_id = i.id AND e.model = ?
         WHERE i.deleted_at IS NULL
           AND (e.item_id IS NULL OR (CASE WHEN json_valid(i.raw) THEN json_extract(i.raw, '$.enrichedCard') END) IS NULL)
         ORDER BY i.first_seen_at DESC
         LIMIT ?`,
      )
      .all(model, limit) as Array<{ id: string }>;
    return rows.map((r) => r.id);
  }

  listCategories(): Array<{
    id: string;
    name: string;
    description: string;
    examples: string[];
    sort: number;
    name_source: CategoryNameSource;
  }> {
    const rows = this.db
      .prepare("SELECT * FROM categories ORDER BY sort ASC, id ASC")
      .all() as Array<{
      id: string;
      name: string;
      description: string | null;
      examples: string | null;
      sort: number;
      name_source?: string | null;
    }>;

    return rows.map((r) => {
      let examples: string[] = [];
      if (r.examples) {
        try {
          examples = JSON.parse(r.examples);
        } catch {
          examples = [];
        }
      }
      const nameSource: CategoryNameSource =
        r.name_source === "topics" || r.name_source === "user" ? r.name_source : "llm";
      return {
        id: r.id,
        name: r.name,
        description: r.description || "",
        examples,
        sort: r.sort,
        name_source: nameSource,
      };
    });
  }

  saveCategories(
    categories: Array<{
      id: string;
      name: string;
      description?: string;
      examples?: string[];
      sort?: number;
      name_source?: CategoryNameSource;
    }>,
  ): void {
    const tx = this.db.transaction(() => {
      const keepIds = new Set(categories.map((c) => c.id));
      const existing = this.listCategories();
      const existingById = new Map(existing.map((e) => [e.id, e]));
      for (const old of existing) {
        if (!keepIds.has(old.id)) {
          this.db.prepare("DELETE FROM categories WHERE id = ?").run(old.id);
          this.db.prepare("DELETE FROM item_category WHERE category_id = ?").run(old.id);
        }
      }

      let hasTopicsSource = false;
      const stmt = this.db.prepare(
        `INSERT INTO categories (id, name, description, examples, sort, name_source)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           examples = excluded.examples,
           sort = excluded.sort,
           name_source = excluded.name_source`,
      );
      categories.forEach((c, idx) => {
        const old = existingById.get(c.id);
        let nameSource: CategoryNameSource;
        if (c.name_source === "topics" || c.name_source === "llm" || c.name_source === "user") {
          nameSource = c.name_source;
        } else if (!old) {
          nameSource = "user";
        } else if (old.name !== c.name || (old.description || "") !== (c.description ?? "")) {
          nameSource = "user";
        } else {
          nameSource = old.name_source;
        }
        if (nameSource === "topics") hasTopicsSource = true;
        stmt.run(
          c.id,
          c.name,
          c.description ?? "",
          JSON.stringify(c.examples ?? []),
          c.sort ?? idx + 1,
          nameSource,
        );
      });
      if (!hasTopicsSource) {
        this.db.prepare("DELETE FROM app_meta WHERE key = 'taxonomy_naming'").run();
      }
    });
    tx();
  }

  listPendingItems(limit = 20): Array<{
    id: string;
    title: string | null;
    author: string | null;
    excerpt: string;
    suggestedCategoryId: string;
    score: number;
    source: string;
  }> {
    const rows = this.db
      .prepare(
        `SELECT i.id, i.title, i.author, i.excerpt, ic.category_id, ic.score, ic.source
         FROM item_category ic
         JOIN items i ON i.id = ic.item_id
         WHERE i.deleted_at IS NULL AND ic.source = 'pending'
         ORDER BY ic.score ASC, i.first_seen_at DESC
         LIMIT ?`,
      )
      .all(limit) as Array<{
      id: string;
      title: string | null;
      author: string | null;
      excerpt: string | null;
      category_id: string;
      score: number;
      source: string;
    }>;

    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      author: r.author,
      excerpt: (r.excerpt || "").slice(0, 260),
      suggestedCategoryId: r.category_id,
      score: r.score,
      source: r.source,
    }));
  }
}

/**
 * Helper for `add(url, note?)`: fetches OpenGraph / HTML title & description metadata
 * with a short timeout, falling back gracefully if offline or blocked.
 */
export async function fetchUrlMetadata(url: string): Promise<{
  title: string | null;
  description: string | null;
  image: string | null;
}> {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { title: null, description: null, image: null };
    const html = (await res.text()).slice(0, 65536);

    const matchMeta = (prop: string): string | null => {
      const re1 = new RegExp(
        `<meta[^>]+(?:property|name)=["']${prop}["'][^>]+content=["']([^"']+)["']`,
        "i",
      );
      const re2 = new RegExp(
        `<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["']${prop}["']`,
        "i",
      );
      return re1.exec(html)?.[1]?.trim() || re2.exec(html)?.[1]?.trim() || null;
    };

    const ogTitle = matchMeta("og:title") || matchMeta("twitter:title");
    const htmlTitle = /<title[^>]*>([^<]+)<\/title>/i.exec(html)?.[1]?.trim() || null;
    const description =
      matchMeta("og:description") ||
      matchMeta("twitter:description") ||
      matchMeta("description");
    const image = matchMeta("og:image") || matchMeta("twitter:image");

    return {
      title: ogTitle || htmlTitle,
      description,
      image,
    };
  } catch {
    return { title: null, description: null, image: null };
  }
}

export function createManualItemInput(
  url: string,
  meta: { title?: string | null; description?: string | null; image?: string | null },
  note?: string,
): UpsertItemInput {
  const canon = canonicalizeUrl(url);
  const id = `manual:${randomUUID().slice(0, 12)}`;
  const excerptParts = [meta.description, note ? `备注: ${note}` : null].filter(Boolean);
  return {
    id,
    source: "manual",
    source_item_id: canon,
    account: "default",
    url,
    canonical_url: canon,
    title: meta.title ?? url,
    excerpt: excerptParts.join("\n") || meta.title || url,
    note: note ?? null,
    cover_url: meta.image ?? null,
    media_type: "link",
    publish_date: new Date().toISOString(),
  };
}
