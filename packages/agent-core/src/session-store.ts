import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { type A2uiSurfaceSpec, stripSurfaceMarkers } from "@bookmark-agent/catalog";
import type { AgentMessage } from "./messages.js";

export interface SessionRecord {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  message_count?: number;
}

export interface StoredMessageRow {
  id: string;
  session_id: string;
  seq: number;
  role: "user" | "assistant";
  type: string;
  text: string;
  payload_json: string;
  a2ui_surfaces_json: string | null;
  referenced_ids_json: string | null;
  created_at: string;
}

/**
 * AppSessionStore (`app.db` - separate from `collections.db` per design.md §8):
 * Stores conversation sessions, `AgentMessage[]` (including `attached_items`, `ui_action`, and A2UI surfaces),
 * supports deterministic replay of messages + A2UI surfaces, and provides FTS5 trigram full-text search.
 */
export class AppSessionStore {
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
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS sessions (
        id         TEXT PRIMARY KEY,
        title      TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_messages (
        id                  TEXT PRIMARY KEY,
        session_id          TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        seq                 INTEGER NOT NULL,
        role                TEXT NOT NULL,
        type                TEXT NOT NULL,
        text                TEXT NOT NULL,
        payload_json        TEXT NOT NULL,
        a2ui_surfaces_json  TEXT,
        referenced_ids_json TEXT,
        created_at          TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_session_messages_session_seq
        ON session_messages(session_id, seq ASC);

      CREATE VIRTUAL TABLE IF NOT EXISTS session_messages_fts USING fts5(
        text,
        referenced_ids_json,
        content='session_messages',
        tokenize='trigram'
      );

      CREATE TRIGGER IF NOT EXISTS session_messages_ai AFTER INSERT ON session_messages BEGIN
        INSERT INTO session_messages_fts(rowid, text, referenced_ids_json)
        VALUES (new.rowid, new.text, COALESCE(new.referenced_ids_json, ''));
      END;

      CREATE TRIGGER IF NOT EXISTS session_messages_ad AFTER DELETE ON session_messages BEGIN
        INSERT INTO session_messages_fts(session_messages_fts, rowid, text, referenced_ids_json)
        VALUES ('delete', old.rowid, old.text, COALESCE(old.referenced_ids_json, ''));
      END;
    `);
  }

  createSession(title = "新对话", id: string = randomUUID()): SessionRecord {
    const now = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO sessions (id, title, created_at, updated_at)
         VALUES (?, ?, ?, ?)`,
      )
      .run(id, title, now, now);
    return { id, title, created_at: now, updated_at: now, message_count: 0 };
  }

  getOrCreateSession(sessionId?: string, defaultTitle = "新对话"): SessionRecord {
    if (sessionId) {
      const existing = this.db
        .prepare("SELECT * FROM sessions WHERE id = ?")
        .get(sessionId) as SessionRecord | undefined;
      if (existing) return existing;
      return this.createSession(defaultTitle, sessionId);
    }
    return this.createSession(defaultTitle);
  }

  updateSessionTitle(sessionId: string, title: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare("UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?")
      .run(title, now, sessionId);
  }

  listSessions(): SessionRecord[] {
    return this.db
      .prepare(
        `SELECT s.*,
                (SELECT COUNT(*) FROM session_messages m WHERE m.session_id = s.id) as message_count
         FROM sessions s
         ORDER BY s.updated_at DESC`,
      )
      .all() as SessionRecord[];
  }

  appendMessage(sessionId: string, msg: AgentMessage): string {
    this.getOrCreateSession(sessionId);
    const id = msg.id || randomUUID();
    const now = msg.createdAt || new Date().toISOString();

    const maxRow = this.db
      .prepare("SELECT COALESCE(MAX(seq), 0) as maxSeq FROM session_messages WHERE session_id = ?")
      .get(sessionId) as { maxSeq: number };
    const seq = (maxRow?.maxSeq || 0) + 1;

    let text = "";
    let surfaces: A2uiSurfaceSpec[] | null = null;
    let referencedIds: string[] | null = null;

    if (msg.role === "user") {
      if (msg.type === "text") {
        text = msg.text;
        if (msg.attachedItems?.length) {
          referencedIds = msg.attachedItems.map((i) => i.id);
        }
      } else if (msg.type === "attached_items") {
        text = msg.prompt || `附加了 ${msg.items.length} 条收藏`;
        referencedIds = msg.items.map((i) => i.id);
      } else if (msg.type === "ui_action") {
        text = `[UI Action] ${msg.action} (${msg.surfaceId})`;
        if (msg.itemId) referencedIds = [msg.itemId];
      }
    } else {
      // Searchable text: prose only, without the surface position markers
      text = stripSurfaceMarkers(msg.text);
      if (msg.surfaces && msg.surfaces.length > 0) {
        surfaces = msg.surfaces;
      }
      if (msg.referencedIds && msg.referencedIds.length > 0) {
        referencedIds = msg.referencedIds;
      }
    }

    const storedMsg = { ...msg, id, createdAt: now };

    this.db
      .prepare(
        `INSERT INTO session_messages (
          id, session_id, seq, role, type, text,
          payload_json, a2ui_surfaces_json, referenced_ids_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        sessionId,
        seq,
        msg.role,
        msg.type,
        text,
        JSON.stringify(storedMsg),
        surfaces ? JSON.stringify(surfaces) : null,
        referencedIds ? JSON.stringify(referencedIds) : null,
        now,
      );

    // Auto-title session on first user message if title is still "新对话"
    if (seq === 1 && msg.role === "user" && text.trim()) {
      const cleanTitle = text.replace(/\s+/g, " ").trim().slice(0, 36);
      this.db
        .prepare(
          "UPDATE sessions SET title = CASE WHEN title = '新对话' THEN ? ELSE title END, updated_at = ? WHERE id = ?",
        )
        .run(cleanTitle, now, sessionId);
    } else {
      this.db.prepare("UPDATE sessions SET updated_at = ? WHERE id = ?").run(now, sessionId);
    }

    return id;
  }

  /**
   * Replays all messages (including A2UI surfaces and attachments) for a session in exact sequence order.
   */
  getSessionMessages(sessionId: string): AgentMessage[] {
    const rows = this.db
      .prepare(
        "SELECT * FROM session_messages WHERE session_id = ? ORDER BY seq ASC",
      )
      .all(sessionId) as StoredMessageRow[];

    return rows.map((r) => {
      try {
        return JSON.parse(r.payload_json) as AgentMessage;
      } catch {
        return {
          id: r.id,
          role: r.role,
          type: "text",
          text: r.text,
          createdAt: r.created_at,
        } as AgentMessage;
      }
    });
  }

  /**
   * Full-text search across conversation messages (FTS5 trigram with LIKE fallback for < 3 chars).
   */
  searchMessages(query: string, limit = 20): Array<{
    messageId: string;
    sessionId: string;
    sessionTitle: string;
    role: string;
    text: string;
    createdAt: string;
  }> {
    const q = query.trim();
    if (!q) return [];

    if ([...q].length >= 3) {
      try {
        const ftsExpr = `"${q.replace(/"/g, '""')}"`;
        const rows = this.db
          .prepare(
            `SELECT m.id as messageId, m.session_id as sessionId, s.title as sessionTitle,
                    m.role, m.text, m.created_at as createdAt
             FROM session_messages_fts f
             JOIN session_messages m ON m.rowid = f.rowid
             JOIN sessions s ON s.id = m.session_id
             WHERE session_messages_fts MATCH ?
             ORDER BY bm25(session_messages_fts) ASC, m.created_at DESC
             LIMIT ?`,
          )
          .all(ftsExpr, limit) as any[];
        if (rows.length > 0) return rows;
      } catch {
        // Fallback to LIKE below
      }
    }

    return this.db
      .prepare(
        `SELECT m.id as messageId, m.session_id as sessionId, s.title as sessionTitle,
                m.role, m.text, m.created_at as createdAt
         FROM session_messages m
         JOIN sessions s ON s.id = m.session_id
         WHERE m.text LIKE ? COLLATE NOCASE
            OR COALESCE(m.referenced_ids_json, '') LIKE ? COLLATE NOCASE
         ORDER BY m.created_at DESC
         LIMIT ?`,
      )
      .all(`%${q}%`, `%${q}%`, limit) as any[];
  }

  close(): void {
    this.db.close();
  }
}
