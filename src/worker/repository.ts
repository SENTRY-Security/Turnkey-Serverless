import type {
  AdapterAccount,
  AdapterAccountInput,
  FinanceAdapterEvent,
  FinanceSubmissionRequest,
  OutboundMessageType,
  ProcessResultDocumentOutcome,
  SubmissionManifest,
  SubmissionStatus,
  SubmissionView,
} from "../core/index.js";

export interface SubmissionRow {
  id: string;
  tenant_id: string;
  legal_entity_id: string;
  account_id: string;
  external_batch_id: string;
  idempotency_key: string;
  message_type: OutboundMessageType;
  category_type: "B2B" | "B2C" | "B2S" | "B2P";
  process_type: "STORAGE" | "EXCHANGE" | "MESSAGE";
  mig_version: "4.1";
  status: SubmissionStatus;
  document_count: number;
  source_r2_key: string;
  credential_r2_key: string;
  credential_expires_at: string;
  envelope_r2_key: string | null;
  signed_r2_key: string | null;
  result_r2_key: string | null;
  remote_filename: string | null;
  message_dts: string;
  message_uuid: string;
  from_party_id: string;
  to_party_id: string;
  from_routing_id: string | null;
  to_routing_id: string | null;
  source_sha256: string;
  signed_sha256: string | null;
  attempt_count: number;
  workflow_instance_id: string | null;
  last_error_code: string | null;
  last_error_message: string | null;
  result_details_json: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

interface AccountRow {
  id: string;
  tenant_id: string;
  legal_entity_id: string;
  company_ban: string;
  company_name: string;
  routing_id: string;
  routing_description: string;
  egress_profile: string;
  platform_environment: "TEST" | "PRODUCTION";
  credential_r2_key: string | null;
  credential_expires_at: string | null;
  active: number;
  created_at: string;
  updated_at: string;
}

export interface StoredAdapterAccount extends AdapterAccount {
  credentialR2Key: string | null;
}

export interface InboundFileRow {
  id: string;
  account_id: string;
  remote_filename: string;
  size: number;
  status: string;
  raw_r2_key: string | null;
  extracted_r2_key: string | null;
  sha256: string | null;
  submission_id: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface SubmissionDocumentRow {
  submission_id: string;
  document_index: number;
  external_document_id: string;
  invoice_identifier: string | null;
  source_filename: string;
  status: string;
  error_code: string | null;
  error_message: string | null;
}

function mapAccount(row: AccountRow): StoredAdapterAccount {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    legalEntityId: row.legal_entity_id,
    companyBan: row.company_ban,
    companyName: row.company_name,
    routingId: row.routing_id,
    routingDescription: row.routing_description,
    egressProfile: row.egress_profile,
    platformEnvironment: row.platform_environment,
    hasCredentialLease:
      row.credential_r2_key !== null &&
      row.credential_expires_at !== null &&
      Date.parse(row.credential_expires_at) > Date.now(),
    credentialExpiresAt: row.credential_expires_at,
    credentialR2Key: row.credential_r2_key,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toSubmissionView(row: SubmissionRow): SubmissionView {
  return {
    id: row.id,
    adapter: "tw-mof-einvoice",
    country: "TW",
    tenantId: row.tenant_id,
    legalEntityId: row.legal_entity_id,
    externalBatchId: row.external_batch_id,
    messageType: row.message_type,
    categoryType: row.category_type,
    processType: row.process_type,
    status: row.status,
    documentCount: row.document_count,
    credentialExpiresAt: row.credential_expires_at,
    remoteFilename: row.remote_filename,
    lastError: row.last_error_message
      ? { code: row.last_error_code, message: row.last_error_message }
      : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

export async function getAccountForEntity(
  db: D1Database,
  tenantId: string,
  legalEntityId: string,
): Promise<StoredAdapterAccount | null> {
  const row = await db
    .prepare("SELECT * FROM adapter_accounts WHERE tenant_id = ? AND legal_entity_id = ? AND active = 1")
    .bind(tenantId, legalEntityId)
    .first<AccountRow>();
  return row ? mapAccount(row) : null;
}

export async function getAccountById(db: D1Database, id: string): Promise<StoredAdapterAccount | null> {
  const row = await db.prepare("SELECT * FROM adapter_accounts WHERE id = ?").bind(id).first<AccountRow>();
  return row ? mapAccount(row) : null;
}

export async function listActiveAccounts(db: D1Database): Promise<StoredAdapterAccount[]> {
  const result = await db
    .prepare(
      `SELECT * FROM adapter_accounts
       WHERE active = 1 AND credential_r2_key IS NOT NULL AND credential_expires_at > ?
       ORDER BY id`,
    )
    .bind(new Date().toISOString())
    .all<AccountRow>();
  return result.results.map(mapAccount);
}

export async function listExpiredCredentialKeys(
  db: D1Database,
  expiredBefore: string,
  limit = 1_000,
): Promise<string[]> {
  const result = await db
    .prepare(
      `SELECT expired.key FROM (
         SELECT credential_r2_key AS key FROM submissions WHERE credential_expires_at <= ?
         UNION
         SELECT credential_r2_key AS key FROM adapter_accounts
         WHERE credential_r2_key IS NOT NULL AND credential_expires_at <= ?
       ) AS expired
       WHERE NOT EXISTS (
         SELECT 1 FROM purged_credential_objects purged WHERE purged.r2_key = expired.key
       )
       ORDER BY expired.key
       LIMIT ?`,
    )
    .bind(expiredBefore, expiredBefore, limit)
    .all<{ key: string }>();
  return result.results.map((row) => row.key);
}

export async function markCredentialKeysPurged(db: D1Database, keys: string[], purgedAt: string): Promise<void> {
  const statements = keys.map((key) =>
    db
      .prepare("INSERT OR IGNORE INTO purged_credential_objects (r2_key, purged_at) VALUES (?, ?)")
      .bind(key, purgedAt),
  );
  for (let offset = 0; offset < statements.length; offset += 100) {
    await db.batch(statements.slice(offset, offset + 100));
  }
}

export async function upsertAccount(db: D1Database, account: AdapterAccountInput): Promise<AdapterAccount> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT INTO adapter_accounts (
        id, tenant_id, legal_entity_id, company_ban, company_name, routing_id,
        routing_description, egress_profile, platform_environment, active, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        tenant_id = excluded.tenant_id,
        legal_entity_id = excluded.legal_entity_id,
        company_ban = excluded.company_ban,
        company_name = excluded.company_name,
        routing_id = excluded.routing_id,
        routing_description = excluded.routing_description,
        egress_profile = excluded.egress_profile,
        platform_environment = excluded.platform_environment,
        active = excluded.active,
        updated_at = excluded.updated_at`,
    )
    .bind(
      account.id,
      account.tenantId,
      account.legalEntityId,
      account.companyBan,
      account.companyName,
      account.routingId,
      account.routingDescription,
      account.egressProfile,
      account.platformEnvironment,
      account.active ? 1 : 0,
      now,
      now,
    )
    .run();
  const stored = await getAccountById(db, account.id);
  if (!stored) {
    throw new Error(`Account ${account.id} was not stored`);
  }
  return stored;
}

export async function updateAccountCredentialLease(
  db: D1Database,
  accountId: string,
  lease: { r2Key: string; expiresAt: string },
): Promise<void> {
  await db
    .prepare(
      `UPDATE adapter_accounts
       SET credential_r2_key = ?, credential_expires_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(lease.r2Key, lease.expiresAt, new Date().toISOString(), accountId)
    .run();
}

export async function getCrossBorderSellerCache(
  db: D1Database,
  accountId: string,
): Promise<{ sellerIds: string[]; refreshedAt: string | null }> {
  const [refresh, sellers] = await Promise.all([
    db
      .prepare("SELECT refreshed_at FROM cross_border_refresh WHERE account_id = ?")
      .bind(accountId)
      .first<{ refreshed_at: string }>(),
    db
      .prepare("SELECT seller_id FROM cross_border_sellers WHERE account_id = ? ORDER BY seller_id")
      .bind(accountId)
      .all<{ seller_id: string }>(),
  ]);
  return { sellerIds: sellers.results.map((row) => row.seller_id), refreshedAt: refresh?.refreshed_at ?? null };
}

export async function replaceCrossBorderSellerCache(
  db: D1Database,
  accountId: string,
  sellerIds: string[],
): Promise<void> {
  const refreshedAt = new Date().toISOString();
  const statements: D1PreparedStatement[] = [
    db.prepare("DELETE FROM cross_border_sellers WHERE account_id = ?").bind(accountId),
    ...Array.from(new Set(sellerIds)).map((sellerId) =>
      db
        .prepare("INSERT INTO cross_border_sellers (account_id, seller_id) VALUES (?, ?)")
        .bind(accountId, sellerId),
    ),
  ];
  for (let offset = 0; offset < statements.length; offset += 100) {
    await db.batch(statements.slice(offset, offset + 100));
  }
  // Publish freshness only after every seller row has been replaced. If a
  // chunk fails, the previous timestamp remains stale and the next run retries.
  await db
    .prepare(
      `INSERT INTO cross_border_refresh (account_id, refreshed_at) VALUES (?, ?)
       ON CONFLICT(account_id) DO UPDATE SET refreshed_at = excluded.refreshed_at`,
    )
    .bind(accountId, refreshedAt)
    .run();
}

export async function getSubmission(db: D1Database, id: string): Promise<SubmissionRow | null> {
  return db.prepare("SELECT * FROM submissions WHERE id = ?").bind(id).first<SubmissionRow>();
}

export async function getSubmissionByIdempotency(
  db: D1Database,
  tenantId: string,
  legalEntityId: string,
  idempotencyKey: string,
): Promise<SubmissionRow | null> {
  return db
    .prepare(
      "SELECT * FROM submissions WHERE tenant_id = ? AND legal_entity_id = ? AND idempotency_key = ?",
    )
    .bind(tenantId, legalEntityId, idempotencyKey)
    .first<SubmissionRow>();
}

export async function insertSubmission(input: {
  db: D1Database;
  request: FinanceSubmissionRequest;
  manifest: SubmissionManifest;
  accountId: string;
  sourceKey: string;
  credentialKey: string;
  credentialExpiresAt: string;
  sourceSha256: string;
  messageDts: string;
  messageUuid: string;
}): Promise<boolean> {
  const now = input.manifest.acceptedAt;
  const result = await input.db
    .prepare(
      `INSERT OR IGNORE INTO submissions (
        id, tenant_id, legal_entity_id, account_id, external_batch_id, idempotency_key,
        message_type, category_type, process_type, status, document_count, source_r2_key,
        credential_r2_key, credential_expires_at, message_dts, message_uuid, from_party_id,
        to_party_id, source_sha256, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      input.manifest.submissionId,
      input.request.tenantId,
      input.request.legalEntityId,
      input.accountId,
      input.request.externalBatchId,
      input.request.idempotencyKey,
      input.request.messageType,
      input.request.categoryType,
      input.request.processType,
      input.request.documents.length,
      input.sourceKey,
      input.credentialKey,
      input.credentialExpiresAt,
      input.messageDts,
      input.messageUuid,
      input.manifest.fromPartyId,
      input.manifest.toPartyId,
      input.sourceSha256,
      now,
      now,
    )
    .run();

  if (result.meta.changes === 0) {
    return false;
  }

  const statements = input.manifest.documents.map((document, index) =>
    input.db
      .prepare(
        `INSERT INTO submission_documents (
          submission_id, document_index, external_document_id, invoice_identifier, source_filename
        ) VALUES (?, ?, ?, ?, ?)`,
      )
      .bind(
        input.manifest.submissionId,
        index,
        document.externalDocumentId,
        document.invoiceIdentifier,
        document.sourceFilename,
      ),
  );
  for (let offset = 0; offset < statements.length; offset += 100) {
    await input.db.batch(statements.slice(offset, offset + 100));
  }
  await appendStatusEvent(input.db, {
    submissionId: input.manifest.submissionId,
    accountId: input.accountId,
    eventType: "SUBMISSION_CREATED",
    fromStatus: null,
    toStatus: "RECEIVED",
    code: null,
    message: null,
    data: { externalBatchId: input.request.externalBatchId },
  });
  return true;
}

export async function updateSubmissionStatus(
  db: D1Database,
  submissionId: string,
  status: SubmissionStatus,
  options: {
    errorCode?: string | null;
    errorMessage?: string | null;
    completed?: boolean;
    reopen?: boolean;
    details?: Record<string, unknown> | null;
  } = {},
): Promise<void> {
  const current = await getSubmission(db, submissionId);
  if (!current) {
    throw new Error(`Submission ${submissionId} was not found`);
  }
  const now = new Date().toISOString();
  await db
    .prepare(
      `UPDATE submissions SET status = ?, last_error_code = ?, last_error_message = ?,
       result_details_json = COALESCE(?, result_details_json), updated_at = ?, completed_at = ?
       WHERE id = ?`,
    )
    .bind(
      status,
      options.errorCode ?? null,
      options.errorMessage ?? null,
      options.details === undefined || options.details === null ? null : JSON.stringify(options.details),
      now,
      options.completed ? now : options.reopen ? null : current.completed_at,
      submissionId,
    )
    .run();
  await appendStatusEvent(db, {
    submissionId,
    accountId: current.account_id,
    eventType: "STATUS_CHANGED",
    fromStatus: current.status,
    toStatus: status,
    code: options.errorCode ?? null,
    message: options.errorMessage ?? null,
    data: options.details ?? null,
  });
}

export async function updateTransmissionArtifacts(
  db: D1Database,
  submissionId: string,
  values: {
    envelopeKey?: string;
    signedKey?: string;
    signedSha256?: string;
    remoteFilename?: string;
    fromRoutingId?: string;
    toRoutingId?: string;
    workflowInstanceId?: string;
    resultKey?: string;
    incrementAttempt?: boolean;
  },
): Promise<void> {
  const fields: string[] = ["updated_at = ?"];
  const bindings: Array<string | number> = [new Date().toISOString()];
  const add = (column: string, value: string | undefined): void => {
    if (value !== undefined) {
      fields.push(`${column} = ?`);
      bindings.push(value);
    }
  };
  add("envelope_r2_key", values.envelopeKey);
  add("signed_r2_key", values.signedKey);
  add("signed_sha256", values.signedSha256);
  add("remote_filename", values.remoteFilename);
  add("from_routing_id", values.fromRoutingId);
  add("to_routing_id", values.toRoutingId);
  add("workflow_instance_id", values.workflowInstanceId);
  add("result_r2_key", values.resultKey);
  if (values.incrementAttempt) {
    fields.push("attempt_count = attempt_count + 1");
  }
  bindings.push(submissionId);
  await db.prepare(`UPDATE submissions SET ${fields.join(", ")} WHERE id = ?`).bind(...bindings).run();
}

export async function findSubmissionForResult(
  db: D1Database,
  accountId: string,
  messageUuid: string,
  messageDts: string,
): Promise<SubmissionRow | null> {
  return db
    .prepare("SELECT * FROM submissions WHERE account_id = ? AND message_uuid = ? AND message_dts = ?")
    .bind(accountId, messageUuid, messageDts)
    .first<SubmissionRow>();
}

export async function getSubmissionDocuments(
  db: D1Database,
  submissionId: string,
): Promise<SubmissionDocumentRow[]> {
  const result = await db
    .prepare("SELECT * FROM submission_documents WHERE submission_id = ? ORDER BY document_index")
    .bind(submissionId)
    .all<SubmissionDocumentRow>();
  return result.results;
}

export async function updateSubmissionDocumentOutcomes(
  db: D1Database,
  submissionId: string,
  outcomes: ProcessResultDocumentOutcome[],
): Promise<void> {
  const statements = outcomes.map((outcome) =>
    db
      .prepare(
        `UPDATE submission_documents
         SET status = ?, error_code = ?, error_message = ?
         WHERE submission_id = ? AND document_index = ?`,
      )
      .bind(outcome.status, outcome.errorCode, outcome.errorMessage, submissionId, outcome.documentIndex),
  );
  for (let offset = 0; offset < statements.length; offset += 100) {
    await db.batch(statements.slice(offset, offset + 100));
  }
}

export async function reserveInboundFile(
  db: D1Database,
  input: { id: string; accountId: string; remoteFilename: string; size: number },
): Promise<InboundFileRow> {
  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT OR IGNORE INTO inbound_files
       (id, account_id, remote_filename, size, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'DISCOVERED', ?, ?)`,
    )
    .bind(input.id, input.accountId, input.remoteFilename, input.size, now, now)
    .run();
  const row = await db
    .prepare("SELECT * FROM inbound_files WHERE account_id = ? AND remote_filename = ?")
    .bind(input.accountId, input.remoteFilename)
    .first<InboundFileRow>();
  if (!row) {
    throw new Error(`Failed to reserve inbound file ${input.remoteFilename}`);
  }
  return row;
}

export async function getInboundFile(db: D1Database, id: string): Promise<InboundFileRow | null> {
  return db.prepare("SELECT * FROM inbound_files WHERE id = ?").bind(id).first<InboundFileRow>();
}

export async function updateInboundFile(
  db: D1Database,
  id: string,
  values: {
    status: string;
    rawKey?: string;
    extractedKey?: string;
    sha256?: string;
    submissionId?: string;
    lastError?: string;
  },
): Promise<void> {
  await db
    .prepare(
      `UPDATE inbound_files SET status = ?, raw_r2_key = COALESCE(?, raw_r2_key),
       extracted_r2_key = COALESCE(?, extracted_r2_key), sha256 = COALESCE(?, sha256),
       submission_id = COALESCE(?, submission_id), last_error = ?, updated_at = ? WHERE id = ?`,
    )
    .bind(
      values.status,
      values.rawKey ?? null,
      values.extractedKey ?? null,
      values.sha256 ?? null,
      values.submissionId ?? null,
      values.lastError ?? null,
      new Date().toISOString(),
      id,
    )
    .run();
}

export async function appendStatusEvent(
  db: D1Database,
  input: {
    submissionId: string | null;
    accountId: string | null;
    eventType: string;
    fromStatus: string | null;
    toStatus: string | null;
    code: string | null;
    message: string | null;
    data: Record<string, unknown> | null;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO status_events
       (id, submission_id, account_id, event_type, from_status, to_status, code, message, data_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      crypto.randomUUID(),
      input.submissionId,
      input.accountId,
      input.eventType,
      input.fromStatus,
      input.toStatus,
      input.code,
      input.message,
      input.data ? JSON.stringify(input.data) : null,
      new Date().toISOString(),
    )
    .run();
}

export function makeFinanceEvent(
  row: SubmissionRow,
  status: SubmissionStatus,
  data: FinanceAdapterEvent["data"] = {},
): FinanceAdapterEvent {
  return {
    contractVersion: "1",
    eventId: `tw:${row.id}:${status}:${row.updated_at}`,
    eventType: "SUBMISSION_STATUS_CHANGED",
    adapter: "tw-mof-einvoice",
    country: "TW",
    tenantId: row.tenant_id,
    legalEntityId: row.legal_entity_id,
    submissionId: row.id,
    externalBatchId: row.external_batch_id,
    status,
    occurredAt: row.updated_at,
    data,
  };
}
