import {
  financeSubmissionSchema,
  inspectMigDocument,
  sanitizeSourceFilename,
  turnkeyCredentialLeaseSchema,
  type AdapterAccount,
  type FinanceSubmissionRequest,
  type SubmissionManifest,
  type SubmissionView,
} from "../core/index.js";
import { AdapterError } from "../core/index.js";
import { sha256Hex } from "./crypto.js";
import { storeCredentialLease } from "./credential-vault.js";
import { validatePfxCredential } from "./pfx-signer.js";
import {
  getAccountById,
  getAccountForEntity,
  getSubmission,
  getSubmissionByIdempotency,
  insertSubmission,
  toSubmissionView,
  updateAccountCredentialLease,
} from "./repository.js";

export async function submitFinanceBatch(env: Env, raw: unknown): Promise<SubmissionView> {
  const parsed = financeSubmissionSchema.safeParse(raw);
  if (!parsed.success) {
    throw new AdapterError("TW_ADAPTER_REQUEST_INVALID", "Finance adapter request is invalid", {
      details: { issues: parsed.error.issues },
    });
  }
  const request = parsed.data;
  const existing = await getSubmissionByIdempotency(
    env.TURNKEY_DB,
    request.tenantId,
    request.legalEntityId,
    request.idempotencyKey,
  );
  if (existing) {
    if (existing.status === "RECEIVED") {
      await env.TURNKEY_JOBS.send({ kind: "TRANSMIT", submissionId: existing.id });
    }
    return toSubmissionView(existing);
  }

  enforceSubmissionSize(env, request);
  const account = await getAccountForEntity(env.TURNKEY_DB, request.tenantId, request.legalEntityId);
  if (!account) {
    throw new AdapterError(
      "TW_ADAPTER_ACCOUNT_NOT_FOUND",
      `No active Taiwan e-Invoice account for ${request.tenantId}/${request.legalEntityId}`,
    );
  }
  if (request.fromPartyId && request.fromPartyId !== account.companyBan) {
    throw new AdapterError("TW_FROM_PARTY_MISMATCH", "fromPartyId does not match the configured legal entity BAN");
  }
  if (request.processType === "EXCHANGE" && !request.toPartyId) {
    throw new AdapterError("TW_TO_PARTY_REQUIRED", "toPartyId is required for EXCHANGE submissions");
  }
  validatePfxCredential(request.credentials.signing);

  const acceptedAt = new Date().toISOString();
  const submissionId = crypto.randomUUID();
  const documents = request.documents.map((document, index) => {
    const inspection = inspectMigDocument(document.xml, request.messageType);
    return {
      externalDocumentId: document.externalDocumentId,
      sourceFilename: sanitizeSourceFilename(document.sourceFilename ?? `${request.messageType}-${index + 1}.xml`),
      invoiceIdentifier: inspection.invoiceIdentifier,
      xml: document.xml,
    };
  });
  const fromPartyId = account.companyBan;
  const toPartyId = request.processType === "EXCHANGE" ? request.toPartyId! : "00000000";
  const messageUuid = crypto.randomUUID();
  const messageDts = createTaipeiMessageDts(new Date());
  const manifest: SubmissionManifest = {
    contractVersion: "1",
    submissionId,
    country: "TW",
    tenantId: request.tenantId,
    legalEntityId: request.legalEntityId,
    externalBatchId: request.externalBatchId,
    idempotencyKey: request.idempotencyKey,
    messageType: request.messageType,
    categoryType: request.categoryType,
    processType: request.processType,
    fromPartyId,
    toPartyId,
    documents,
    metadata: request.metadata ?? {},
    acceptedAt,
  };
  const manifestText = JSON.stringify(manifest);
  const sourceSha256 = await sha256Hex(manifestText);
  const sourceKey = objectKey(manifest, "source/manifest.json");
  const credentialKey = objectKey(manifest, "credentials/lease.json");
  const credentialLease = await storeCredentialLease(
    env,
    request.credentials,
    credentialContext(account.id),
    credentialKey,
  );
  await env.TURNKEY_FILES.put(sourceKey, manifestText, {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { sha256: sourceSha256, submissionId },
  });

  const inserted = await insertSubmission({
    db: env.TURNKEY_DB,
    request,
    manifest,
    accountId: account.id,
    sourceKey,
    credentialKey: credentialLease.r2Key,
    credentialExpiresAt: credentialLease.expiresAt,
    sourceSha256,
    messageDts,
    messageUuid,
  });
  if (!inserted) {
    await Promise.allSettled([env.TURNKEY_FILES.delete(sourceKey), env.TURNKEY_FILES.delete(credentialKey)]);
    const raced = await getSubmissionByIdempotency(
      env.TURNKEY_DB,
      request.tenantId,
      request.legalEntityId,
      request.idempotencyKey,
    );
    if (!raced) {
      throw new AdapterError("TW_IDEMPOTENCY_RACE", "Submission was deduplicated but could not be reloaded", {
        retryable: true,
      });
    }
    return toSubmissionView(raced);
  }

  await updateAccountCredentialLease(env.TURNKEY_DB, account.id, credentialLease);

  await env.TURNKEY_JOBS.send({ kind: "TRANSMIT", submissionId });
  const row = await getSubmission(env.TURNKEY_DB, submissionId);
  if (!row) {
    throw new AdapterError("TW_SUBMISSION_NOT_FOUND", `Submission ${submissionId} was not persisted`, {
      retryable: true,
    });
  }
  return toSubmissionView(row);
}

export async function renewAccountCredentialLease(env: Env, accountId: string, raw: unknown): Promise<AdapterAccount> {
  const credentials = turnkeyCredentialLeaseSchema.parse(raw);
  const account = await getAccountById(env.TURNKEY_DB, accountId);
  if (!account?.active) {
    throw new AdapterError("TW_ADAPTER_ACCOUNT_NOT_FOUND", `Active account ${accountId} was not found`);
  }
  validatePfxCredential(credentials.signing);
  const leaseId = crypto.randomUUID();
  const key = [
    "tw",
    account.tenantId,
    account.legalEntityId,
    "credentials",
    `${leaseId}.json`,
  ].join("/");
  const lease = await storeCredentialLease(env, credentials, credentialContext(account.id), key);
  await updateAccountCredentialLease(env.TURNKEY_DB, account.id, lease);
  const updated = await getAccountById(env.TURNKEY_DB, account.id);
  if (!updated) {
    throw new AdapterError("TW_ADAPTER_ACCOUNT_NOT_FOUND", `Account ${accountId} disappeared`, { retryable: true });
  }
  return updated;
}

export function credentialContext(accountId: string): string {
  return `account:${accountId}`;
}

function enforceSubmissionSize(env: Env, request: FinanceSubmissionRequest): void {
  const bytes = request.documents.reduce((total, document) => total + new TextEncoder().encode(document.xml).byteLength, 0);
  const configuredLimit = Number(env.MAX_SUBMISSION_BYTES);
  const limit = Number.isFinite(configuredLimit) ? configuredLimit : 15_000_000;
  if (bytes > limit) {
    throw new AdapterError("TW_SUBMISSION_TOO_LARGE", `Submission XML is ${bytes} bytes; limit is ${limit}`);
  }
}

function objectKey(manifest: SubmissionManifest, suffix: string): string {
  const date = manifest.acceptedAt.slice(0, 10);
  return [
    "tw",
    manifest.tenantId,
    manifest.legalEntityId,
    date,
    manifest.submissionId,
    suffix,
  ].join("/");
}

function createTaipeiMessageDts(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}${value.month}${value.day}${value.hour}${value.minute}${value.second}${String(
    date.getMilliseconds(),
  ).padStart(3, "0")}`;
}
