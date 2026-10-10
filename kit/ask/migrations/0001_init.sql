CREATE TABLE conversations (
  id TEXT PRIMARY KEY,            -- client-generated id, validated as a UUID
  started_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
  locale TEXT NOT NULL, page TEXT, country TEXT,
  caller_key TEXT,                -- hashed IP (kit caller.ts); set to NULL at retention
  turns INTEGER NOT NULL DEFAULT 0,
  tokens_in INTEGER NOT NULL DEFAULT 0, tokens_out INTEGER NOT NULL DEFAULT 0,
  cost_usd REAL NOT NULL DEFAULT 0,
  model TEXT, topic TEXT, handoff INTEGER NOT NULL DEFAULT 0, lead_sent INTEGER NOT NULL DEFAULT 0,
  cited TEXT,                     -- JSON array of cited URLs
  text_deleted_at INTEGER
);
CREATE TABLE messages (
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  seq INTEGER NOT NULL, role TEXT NOT NULL CHECK (role IN ('user','assistant')),
  text TEXT NOT NULL,             -- stripped
  tools TEXT,                     -- JSON: [{name, slug?}] for assistant turns
  created_at INTEGER NOT NULL,
  PRIMARY KEY (conversation_id, seq)
);
CREATE TABLE kept_questions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  text TEXT NOT NULL, note TEXT, kept_at INTEGER NOT NULL, conversation_id TEXT
);
CREATE INDEX conversations_last_at ON conversations(last_at);
