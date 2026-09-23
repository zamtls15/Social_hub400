CREATE TABLE IF NOT EXISTS runtime_settings (
  key TEXT PRIMARY KEY NOT NULL,
  value TEXT NOT NULL,
  type TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  requires_restart INTEGER NOT NULL DEFAULT 0
);
