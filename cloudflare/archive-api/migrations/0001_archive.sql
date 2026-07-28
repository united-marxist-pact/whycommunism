-- Why Communism private archive read model.
--
-- GitHub remains the canonical, reviewable record. D1 is a private runtime
-- index that can be rebuilt from that canonical archive. Set
-- archive_meta.runtime_ready to "1" only after a complete import.

PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS archive_meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;

INSERT OR IGNORE INTO archive_meta (key, value, updated_at)
VALUES ('schema_version', '1', CURRENT_TIMESTAMP);

CREATE TABLE IF NOT EXISTS archive_records (
  record_id TEXT PRIMARY KEY,
  immutable_hash TEXT NOT NULL,
  record_json TEXT NOT NULL,
  message_id TEXT,
  source_kind TEXT NOT NULL DEFAULT 'discord-export',
  guild_id TEXT,
  channel_id TEXT,
  channel_name TEXT,
  channel_parent TEXT,
  author_id TEXT,
  author_name TEXT,
  content_text TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  edited_at TEXT,
  is_manual INTEGER NOT NULL DEFAULT 0 CHECK (is_manual IN (0, 1)),
  imported_at TEXT NOT NULL
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS archive_records_created
ON archive_records (created_at, record_id);

CREATE INDEX IF NOT EXISTS archive_records_channel_created
ON archive_records (channel_id, created_at, record_id);

CREATE INDEX IF NOT EXISTS archive_records_channel_name_created
ON archive_records (channel_name, created_at, record_id);

CREATE INDEX IF NOT EXISTS archive_records_author
ON archive_records (author_id, created_at, record_id);

CREATE TRIGGER IF NOT EXISTS archive_records_are_immutable
BEFORE UPDATE ON archive_records
BEGIN
  SELECT RAISE(ABORT, 'archive records are immutable');
END;

CREATE TRIGGER IF NOT EXISTS archive_records_cannot_be_deleted
BEFORE DELETE ON archive_records
BEGIN
  SELECT RAISE(ABORT, 'archive records are immutable');
END;

CREATE TABLE IF NOT EXISTS archive_assets (
  asset_id TEXT PRIMARY KEY,
  record_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  filename TEXT,
  content_type TEXT,
  byte_size INTEGER,
  source_url TEXT,
  archive_path TEXT,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT,
  FOREIGN KEY (record_id) REFERENCES archive_records(record_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS archive_assets_record
ON archive_assets (record_id, asset_id);

-- Mutable presentation changes never rewrite archive_records. A future
-- member-edit endpoint writes the current overlay and appends a revision event.
CREATE TABLE IF NOT EXISTS message_overlays (
  record_id TEXT PRIMARY KEY,
  content_text TEXT,
  content_markdown TEXT,
  attachments_json TEXT,
  overlay_json TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  edited_at TEXT NOT NULL,
  edited_by TEXT,
  edited_by_discord_id TEXT,
  FOREIGN KEY (record_id) REFERENCES archive_records(record_id)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS revision_events (
  event_id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL,
  event_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  actor_name TEXT,
  actor_discord_id TEXT
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS revision_events_entity
ON revision_events (entity_type, entity_id, created_at, event_id);

CREATE TABLE IF NOT EXISTS classifications (
  record_id TEXT PRIMARY KEY,
  primary_topic TEXT,
  secondary_topics_json TEXT NOT NULL DEFAULT '[]',
  confidence_score REAL NOT NULL DEFAULT 0 CHECK (confidence_score >= 0 AND confidence_score <= 1),
  confidence_label TEXT NOT NULL DEFAULT '',
  relevance TEXT CHECK (relevance IS NULL OR relevance IN ('high', 'medium', 'low')),
  review_status TEXT NOT NULL DEFAULT 'unreviewed',
  note TEXT NOT NULL DEFAULT '',
  assignment_json TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  updated_by TEXT,
  updated_by_discord_id TEXT,
  FOREIGN KEY (record_id) REFERENCES archive_records(record_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS classifications_primary_topic
ON classifications (primary_topic, record_id);

CREATE INDEX IF NOT EXISTS classifications_review_status
ON classifications (review_status, record_id);

CREATE TABLE IF NOT EXISTS topic_references (
  topic_path TEXT NOT NULL,
  record_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('primary', 'secondary')),
  score REAL NOT NULL DEFAULT 0,
  confidence_label TEXT NOT NULL DEFAULT '',
  record_created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (topic_path, record_id),
  FOREIGN KEY (record_id) REFERENCES archive_records(record_id)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS topic_references_page
ON topic_references (topic_path, record_created_at, record_id);

CREATE TABLE IF NOT EXISTS topic_metadata (
  topic_path TEXT PRIMARY KEY,
  title TEXT NOT NULL DEFAULT '',
  filters_json TEXT,
  notes TEXT,
  updated_at TEXT NOT NULL
) WITHOUT ROWID;
