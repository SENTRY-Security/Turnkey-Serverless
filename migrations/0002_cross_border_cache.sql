CREATE TABLE cross_border_refresh (
  account_id TEXT PRIMARY KEY REFERENCES adapter_accounts(id) ON DELETE CASCADE,
  refreshed_at TEXT NOT NULL
);

CREATE TABLE cross_border_sellers (
  account_id TEXT NOT NULL REFERENCES adapter_accounts(id) ON DELETE CASCADE,
  seller_id TEXT NOT NULL,
  PRIMARY KEY (account_id, seller_id)
);
