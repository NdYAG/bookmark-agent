-- M0 DB Schema for collections-mcp (SQLite WAL + FTS5 trigram)
-- Based on design.md §4.1 & execution-plan.md M0

CREATE TABLE IF NOT EXISTS items (
  id             TEXT PRIMARY KEY,          -- Local deterministic or UUID id (e.g., "x:1000000000000000001")
  source         TEXT NOT NULL,             -- 'x' | 'manual' | 'import' ...
  source_item_id TEXT NOT NULL,             -- Source item ID for deduplication & incremental cursor
  account        TEXT NOT NULL DEFAULT '',  -- Multi-account support ('' when single/default)
  url            TEXT NOT NULL,
  canonical_url  TEXT,                      -- Normalized URL (stripped tracking params / expanded shortlinks)
  title          TEXT,                      -- Nullable (tweets usually have no title; user or card may provide one)
  excerpt        TEXT,                      -- Full tweet text, article excerpt, + enriched summary/topics/imageCaptions
  note           TEXT,                      -- User's personal note
  author         TEXT,                      -- Author handle/name (e.g., "@alice (Alice)")
  cover_url      TEXT,
  cover_path     TEXT,                      -- Local cached cover path
  media_type     TEXT,                      -- 'post' | 'article' | 'image' | 'video' | 'link' ...
  publish_date   TEXT,                      -- ISO-8601 timestamp from source
  collected_at   TEXT,                      -- Nullable if source doesn't expose bookmark timestamp
  first_seen_at  TEXT NOT NULL,             -- Local first import/sync timestamp
  updated_at     TEXT NOT NULL,
  deleted_at     TEXT,                      -- Soft-delete tombstone: prevents re-sync/re-import from resurrecting deleted items
  user_overrides TEXT NOT NULL DEFAULT '{}',-- JSON map of user-edited fields (e.g. {"title":true,"note":true,"excerpt":true})
  raw            TEXT,                      -- Original source JSON + enrichedCard metadata
  UNIQUE (source, account, source_item_id)
);

CREATE INDEX IF NOT EXISTS idx_items_source_seen ON items(source, first_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_deleted ON items(deleted_at);
CREATE INDEX IF NOT EXISTS idx_items_author ON items(author);
CREATE INDEX IF NOT EXISTS idx_items_publish_date ON items(publish_date DESC);

-- Cache for read_item full text / thread / readability extraction
CREATE TABLE IF NOT EXISTS item_content (
  item_id    TEXT PRIMARY KEY,
  text       TEXT,
  fetched_at TEXT,
  status     TEXT
);

-- Vector embeddings bound to (item_id, model)
CREATE TABLE IF NOT EXISTS embeddings (
  item_id   TEXT NOT NULL,
  model     TEXT NOT NULL,
  dim       INTEGER NOT NULL,
  vec       BLOB NOT NULL,
  text_hash TEXT NOT NULL,
  PRIMARY KEY (item_id, model)
);

-- Categories taxonomy
CREATE TABLE IF NOT EXISTS categories (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT,
  examples    TEXT, -- JSON array of seed item IDs
  sort        INTEGER NOT NULL DEFAULT 0,
  name_source TEXT NOT NULL DEFAULT 'llm' -- 'topics' | 'llm' | 'user'
);

-- Persistent key-value metadata (e.g., taxonomy naming retry state)
CREATE TABLE IF NOT EXISTS app_meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- Item-to-category assignment ('auto' | 'knn' | 'centroid' | 'decision' | 'pending' | 'user')
CREATE TABLE IF NOT EXISTS item_category (
  item_id     TEXT PRIMARY KEY,
  category_id TEXT NOT NULL,
  score       REAL,
  source      TEXT NOT NULL DEFAULT 'auto'
);

CREATE INDEX IF NOT EXISTS idx_item_category_cat ON item_category(category_id);

-- Pairwise Decisions API rerank cache: (target_id, candidate_id, model)
CREATE TABLE IF NOT EXISTS pair_cache (
  target_id    TEXT NOT NULL,
  candidate_id TEXT NOT NULL,
  model        TEXT NOT NULL,
  score        REAL NOT NULL,
  confidence   REAL NOT NULL,
  raw_answer   TEXT,
  updated_at   TEXT NOT NULL,
  PRIMARY KEY (target_id, candidate_id, model)
);

-- Sync sources state & incremental cursor
CREATE TABLE IF NOT EXISTS sources (
  id           TEXT PRIMARY KEY,
  adapter      TEXT NOT NULL,
  account      TEXT,
  identity     TEXT,
  cursor       TEXT,
  last_sync_at TEXT,
  last_status  TEXT,
  settings     TEXT
);

-- FTS5 full-text index using trigram tokenizer for CJK + English substring search
CREATE VIRTUAL TABLE IF NOT EXISTS items_fts USING fts5(
  title,
  excerpt,
  author,
  note,
  content='items',
  tokenize='trigram'
);

-- Triggers to keep items_fts in sync with items
CREATE TRIGGER IF NOT EXISTS items_ai AFTER INSERT ON items BEGIN
  INSERT INTO items_fts(rowid, title, excerpt, author, note)
  VALUES (new.rowid, COALESCE(new.title, ''), COALESCE(new.excerpt, ''), COALESCE(new.author, ''), COALESCE(new.note, ''));
END;

CREATE TRIGGER IF NOT EXISTS items_ad AFTER DELETE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, excerpt, author, note)
  VALUES ('delete', old.rowid, COALESCE(old.title, ''), COALESCE(old.excerpt, ''), COALESCE(old.author, ''), COALESCE(old.note, ''));
END;

CREATE TRIGGER IF NOT EXISTS items_au AFTER UPDATE ON items BEGIN
  INSERT INTO items_fts(items_fts, rowid, title, excerpt, author, note)
  VALUES ('delete', old.rowid, COALESCE(old.title, ''), COALESCE(old.excerpt, ''), COALESCE(old.author, ''), COALESCE(old.note, ''));
  INSERT INTO items_fts(rowid, title, excerpt, author, note)
  VALUES (new.rowid, COALESCE(new.title, ''), COALESCE(new.excerpt, ''), COALESCE(new.author, ''), COALESCE(new.note, ''));
END;
