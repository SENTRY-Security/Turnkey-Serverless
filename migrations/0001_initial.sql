PRAGMA foreign_keys = ON;

CREATE TABLE adapter_accounts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  legal_entity_id TEXT NOT NULL,
  company_ban TEXT NOT NULL,
  company_name TEXT NOT NULL,
  routing_id TEXT NOT NULL,
  routing_description TEXT NOT NULL DEFAULT '',
  egress_profile TEXT NOT NULL,
  platform_environment TEXT NOT NULL CHECK (platform_environment IN ('TEST', 'PRODUCTION')),
  credential_r2_key TEXT,
  credential_expires_at TEXT,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, legal_entity_id)
);

CREATE TABLE submissions (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  legal_entity_id TEXT NOT NULL,
  account_id TEXT NOT NULL REFERENCES adapter_accounts(id),
  external_batch_id TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  message_type TEXT NOT NULL,
  category_type TEXT NOT NULL,
  process_type TEXT NOT NULL,
  mig_version TEXT NOT NULL DEFAULT '4.1',
  status TEXT NOT NULL,
  document_count INTEGER NOT NULL,
  source_r2_key TEXT NOT NULL,
  credential_r2_key TEXT NOT NULL,
  credential_expires_at TEXT NOT NULL,
  envelope_r2_key TEXT,
  signed_r2_key TEXT,
  result_r2_key TEXT,
  remote_filename TEXT,
  message_dts TEXT NOT NULL,
  message_uuid TEXT NOT NULL,
  from_party_id TEXT NOT NULL,
  to_party_id TEXT NOT NULL,
  from_routing_id TEXT,
  to_routing_id TEXT,
  source_sha256 TEXT NOT NULL,
  signed_sha256 TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0,
  workflow_instance_id TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  result_details_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (tenant_id, legal_entity_id, idempotency_key),
  UNIQUE (message_uuid, message_dts)
);

CREATE INDEX submissions_status_idx ON submissions(status, updated_at);
CREATE INDEX submissions_credential_expiry_idx ON submissions(credential_expires_at);
CREATE INDEX submissions_external_batch_idx ON submissions(tenant_id, legal_entity_id, external_batch_id);

CREATE TABLE submission_documents (
  submission_id TEXT NOT NULL REFERENCES submissions(id) ON DELETE CASCADE,
  document_index INTEGER NOT NULL,
  external_document_id TEXT NOT NULL,
  invoice_identifier TEXT,
  source_filename TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'RECEIVED',
  error_code TEXT,
  error_message TEXT,
  PRIMARY KEY (submission_id, document_index),
  UNIQUE (submission_id, external_document_id)
);

CREATE TABLE status_events (
  id TEXT PRIMARY KEY,
  submission_id TEXT REFERENCES submissions(id) ON DELETE CASCADE,
  account_id TEXT REFERENCES adapter_accounts(id),
  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,
  code TEXT,
  message TEXT,
  data_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX status_events_submission_idx ON status_events(submission_id, created_at);

CREATE TABLE inbound_files (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES adapter_accounts(id),
  remote_filename TEXT NOT NULL,
  size INTEGER NOT NULL,
  status TEXT NOT NULL,
  raw_r2_key TEXT,
  extracted_r2_key TEXT,
  sha256 TEXT,
  submission_id TEXT REFERENCES submissions(id),
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, remote_filename)
);

CREATE INDEX inbound_files_status_idx ON inbound_files(account_id, status, updated_at);

CREATE TABLE routing_cache (
  account_id TEXT NOT NULL REFERENCES adapter_accounts(id),
  party_id TEXT NOT NULL,
  routing_id TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  expires_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (account_id, party_id)
);
