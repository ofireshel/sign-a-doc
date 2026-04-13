CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  sender_user_id TEXT NOT NULL,
  sender_email TEXT NOT NULL,
  title TEXT NOT NULL,
  file_name TEXT NOT NULL,
  recipient_email TEXT NOT NULL,
  original_file_key TEXT NOT NULL,
  signed_file_key TEXT,
  status TEXT NOT NULL DEFAULT 'sent',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  signed_at TEXT
);

CREATE TABLE IF NOT EXISTS sign_requests (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  token TEXT NOT NULL UNIQUE,
  recipient_email TEXT NOT NULL,
  recipient_name TEXT,
  recipient_user_id TEXT,
  signer_field_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'sent',
  created_at TEXT NOT NULL,
  signed_at TEXT,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS audit_events (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL,
  sign_request_id TEXT,
  actor_user_id TEXT,
  actor_email TEXT,
  event_type TEXT NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (document_id) REFERENCES documents(id) ON DELETE CASCADE,
  FOREIGN KEY (sign_request_id) REFERENCES sign_requests(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_documents_sender ON documents(sender_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_sign_requests_document ON sign_requests(document_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_document ON audit_events(document_id, created_at DESC);
