import { WorkerEntrypoint } from "cloudflare:workers";
import { z } from "zod";
import {
  AdapterError,
  adapterAccountSchema,
  errorMessage,
  type AdapterAccount,
  type AdapterJobMessage,
  type FinanceSubmissionRequest,
  type SubmissionView,
} from "../core/index.js";
import { hasValidBearer } from "./crypto.js";
import { loadCredentialLease } from "./credential-vault.js";
import { getEgressProfile, queryGatewayErrorMessages, queryTurnkeyVersionInfo } from "./egress-client.js";
import { TransmissionCoordinator } from "./coordinator.js";
import {
  getAccountById,
  getInboundFile,
  getSubmission,
  getSubmissionDocuments,
  listActiveAccounts,
  listExpiredCredentialKeys,
  markCredentialKeysPurged,
  toSubmissionView,
  updateSubmissionStatus,
  upsertAccount,
} from "./repository.js";
import { credentialContext, renewAccountCredentialLease, submitFinanceBatch } from "./submissions.js";
import { InboundWorkflow, TransmissionWorkflow } from "./workflows.js";

export { InboundWorkflow, TransmissionCoordinator, TransmissionWorkflow };

export class TaiwanEinvoiceAdapter extends WorkerEntrypoint<Env> {
  async submit(input: FinanceSubmissionRequest): Promise<SubmissionView> {
    return submitFinanceBatch(this.env, input);
  }

  async status(submissionId: string): Promise<SubmissionView | null> {
    const row = await getSubmission(this.env.TURNKEY_DB, submissionId);
    return row ? toSubmissionView(row) : null;
  }
}

const artifactKinds = {
  source: "source_r2_key",
  envelope: "envelope_r2_key",
  signed: "signed_r2_key",
  result: "result_r2_key",
} as const;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const requestId = crypto.randomUUID();
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/healthz") {
        return Response.json({ ok: true, adapter: "tw-mof-einvoice", country: "TW", requestId });
      }
      if (!hasValidBearer(request, env.ADAPTER_API_KEY)) {
        return problem(401, "TW_UNAUTHORIZED", "Missing or invalid adapter API key", requestId);
      }

      if (request.method === "PUT" && url.pathname === "/v1/accounts") {
        const account = adapterAccountSchema.parse(await request.json());
        const profile = await getEgressProfile(env, account.egressProfile);
        if (profile.environment !== account.platformEnvironment) {
          throw new AdapterError(
            "TW_EGRESS_ENVIRONMENT_MISMATCH",
            `Egress profile ${account.egressProfile} is ${profile.environment}, not ${account.platformEnvironment}`,
          );
        }
        return Response.json(toPublicAccount(await upsertAccount(env.TURNKEY_DB, account)));
      }
      const credentialLeaseMatch = /^\/v1\/accounts\/([^/]+)\/credential-lease$/u.exec(url.pathname);
      if (request.method === "POST" && credentialLeaseMatch?.[1]) {
        const accountId = decodeURIComponent(credentialLeaseMatch[1]);
        const account = await renewAccountCredentialLease(env, accountId, await request.json());
        return Response.json(toPublicAccount(account), { status: 201 });
      }
      const gatewayDiagnosticMatch = /^\/v1\/accounts\/([^/]+)\/gateway\/(version-info|error-messages)$/u.exec(
        url.pathname,
      );
      if (request.method === "POST" && gatewayDiagnosticMatch?.[1] && gatewayDiagnosticMatch[2]) {
        const account = await getAccountById(env.TURNKEY_DB, decodeURIComponent(gatewayDiagnosticMatch[1]));
        if (!account?.active || !account.credentialR2Key || !account.credentialExpiresAt) {
          return problem(404, "TW_ACCOUNT_CREDENTIALS_NOT_FOUND", "Active account credentials were not found", requestId);
        }
        const credentials = await loadCredentialLease(
          env,
          account.credentialR2Key,
          credentialContext(account.id),
          account.credentialExpiresAt,
        );
        if (gatewayDiagnosticMatch[2] === "version-info") {
          return Response.json(
            await queryTurnkeyVersionInfo(env, account.egressProfile, credentials.transport, {
              turnkeyVersion: env.TURNKEY_COMPAT_VERSION,
              apiVersion: env.GATEWAY_API_VERSION,
              compId: account.companyBan,
              dbType: "D1",
              osType: "Cloudflare Workers",
              jreVersion: "N/A",
              tkyType: "E",
            }),
          );
        }
        return Response.json(await queryGatewayErrorMessages(env, account.egressProfile, credentials.transport));
      }
      if (request.method === "GET" && url.pathname.startsWith("/v1/accounts/")) {
        const id = decodeURIComponent(url.pathname.slice("/v1/accounts/".length));
        const account = await getAccountById(env.TURNKEY_DB, id);
        return account
          ? Response.json(toPublicAccount(account))
          : problem(404, "TW_ACCOUNT_NOT_FOUND", "Account not found", requestId);
      }
      if (request.method === "POST" && url.pathname === "/v1/submissions") {
        const contentLength = Number(request.headers.get("content-length") ?? "0");
        if (contentLength > Number(env.MAX_SUBMISSION_BYTES) + 5_000_000) {
          return problem(413, "TW_REQUEST_TOO_LARGE", "Submission request is too large", requestId);
        }
        const result = await submitFinanceBatch(env, await request.json());
        return Response.json(result, { status: result.status === "RECEIVED" ? 202 : 200 });
      }

      const submissionMatch = /^\/v1\/submissions\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "GET" && submissionMatch?.[1]) {
        const row = await getSubmission(env.TURNKEY_DB, decodeURIComponent(submissionMatch[1]));
        return row ? Response.json(toSubmissionView(row)) : problem(404, "TW_SUBMISSION_NOT_FOUND", "Submission not found", requestId);
      }
      const submissionDocumentsMatch = /^\/v1\/submissions\/([^/]+)\/documents$/u.exec(url.pathname);
      if (request.method === "GET" && submissionDocumentsMatch?.[1]) {
        const submissionId = decodeURIComponent(submissionDocumentsMatch[1]);
        if (!(await getSubmission(env.TURNKEY_DB, submissionId))) {
          return problem(404, "TW_SUBMISSION_NOT_FOUND", "Submission not found", requestId);
        }
        const documents = await getSubmissionDocuments(env.TURNKEY_DB, submissionId);
        return Response.json(
          documents.map((document) => ({
            index: document.document_index,
            externalDocumentId: document.external_document_id,
            sourceFilename: document.source_filename,
            invoiceIdentifier: document.invoice_identifier,
            status: document.status,
            errorCode: document.error_code,
            errorMessage: document.error_message,
          })),
        );
      }
      const retryMatch = /^\/v1\/submissions\/([^/]+)\/retry$/u.exec(url.pathname);
      if (request.method === "POST" && retryMatch?.[1]) {
        const submissionId = decodeURIComponent(retryMatch[1]);
        const row = await getSubmission(env.TURNKEY_DB, submissionId);
        if (!row) {
          return problem(404, "TW_SUBMISSION_NOT_FOUND", "Submission not found", requestId);
        }
        if (row.status !== "FAILED") {
          return problem(409, "TW_RETRY_NOT_ALLOWED", "Only FAILED submissions can be retried", requestId);
        }
        await updateSubmissionStatus(env.TURNKEY_DB, submissionId, "RECEIVED", {
          errorCode: null,
          errorMessage: null,
          reopen: true,
        });
        await env.TURNKEY_JOBS.send({ kind: "TRANSMIT", submissionId });
        const updated = await getSubmission(env.TURNKEY_DB, submissionId);
        return Response.json(updated ? toSubmissionView(updated) : toSubmissionView(row), { status: 202 });
      }
      const artifactMatch = /^\/v1\/submissions\/([^/]+)\/artifacts\/(source|envelope|signed|result)$/u.exec(
        url.pathname,
      );
      if (request.method === "GET" && artifactMatch?.[1] && artifactMatch[2]) {
        const row = await getSubmission(env.TURNKEY_DB, decodeURIComponent(artifactMatch[1]));
        if (!row) {
          return problem(404, "TW_SUBMISSION_NOT_FOUND", "Submission not found", requestId);
        }
        const key = row[artifactKinds[artifactMatch[2] as keyof typeof artifactKinds]];
        if (!key) {
          return problem(404, "TW_ARTIFACT_NOT_READY", "Artifact is not available", requestId);
        }
        const object = await env.TURNKEY_FILES.get(key);
        if (!object) {
          return problem(404, "TW_ARTIFACT_NOT_FOUND", "Artifact object is missing", requestId);
        }
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        return new Response(object.body, { headers });
      }
      const inboundArtifactMatch = /^\/v1\/inbound-files\/([^/]+)\/artifact$/u.exec(url.pathname);
      if (request.method === "GET" && inboundArtifactMatch?.[1]) {
        const inbound = await getInboundFile(env.TURNKEY_DB, decodeURIComponent(inboundArtifactMatch[1]));
        if (!inbound) {
          return problem(404, "TW_INBOUND_FILE_NOT_FOUND", "Inbound file was not found", requestId);
        }
        const key = inbound.extracted_r2_key ?? inbound.raw_r2_key;
        if (!key) {
          return problem(404, "TW_INBOUND_ARTIFACT_NOT_READY", "Inbound artifact is not ready", requestId);
        }
        const object = await env.TURNKEY_FILES.get(key);
        if (!object) {
          return problem(404, "TW_INBOUND_ARTIFACT_NOT_FOUND", "Inbound artifact object is missing", requestId);
        }
        const headers = new Headers();
        object.writeHttpMetadata(headers);
        headers.set("etag", object.httpEtag);
        return new Response(object.body, { headers });
      }
      return problem(404, "TW_ROUTE_NOT_FOUND", "Route not found", requestId);
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "request failed",
          requestId,
          method: request.method,
          path: url.pathname,
          error: errorMessage(error),
        }),
      );
      if (error instanceof z.ZodError) {
        return problem(400, "TW_REQUEST_INVALID", "Request validation failed", requestId, { issues: error.issues });
      }
      if (error instanceof AdapterError) {
        return problem(error.retryable ? 503 : 400, error.code, error.message, requestId, error.details);
      }
      return problem(500, "TW_INTERNAL_ERROR", "Internal adapter error", requestId);
    }
  },

  async queue(batch: MessageBatch<AdapterJobMessage>, env: Env): Promise<void> {
    for (const message of batch.messages) {
      try {
        if (message.body.kind === "TRANSMIT") {
          await startWorkflowIfNeeded(env.TRANSMISSION_WORKFLOW, message.body.submissionId, {
            submissionId: message.body.submissionId,
          });
        } else {
          await startWorkflowIfNeeded(env.INBOUND_WORKFLOW, message.body.pollId, {
            accountId: message.body.accountId,
            pollId: message.body.pollId,
          });
        }
        message.ack();
      } catch (error) {
        console.error(
          JSON.stringify({
            level: "error",
            message: "queue dispatch failed",
            queueMessageId: message.id,
            error: errorMessage(error),
          }),
        );
        message.retry();
      }
    }
  },

  async scheduled(event: ScheduledController, env: Env): Promise<void> {
    const accounts = await listActiveAccounts(env.TURNKEY_DB);
    const bucket = new Date(event.scheduledTime).toISOString().slice(0, 16).replaceAll(/[-:T]/gu, "");
    await Promise.all(
      accounts.map((account) =>
        env.TURNKEY_JOBS.send({
          kind: "POLL",
          accountId: account.id,
          pollId: `poll-${account.id}-${bucket}`,
        }),
      ),
    );
    const expiredCredentialKeys = await listExpiredCredentialKeys(env.TURNKEY_DB, new Date(event.scheduledTime).toISOString());
    if (expiredCredentialKeys.length > 0) {
      await env.TURNKEY_FILES.delete(expiredCredentialKeys);
      await markCredentialKeysPurged(
        env.TURNKEY_DB,
        expiredCredentialKeys,
        new Date(event.scheduledTime).toISOString(),
      );
    }
  },
} satisfies ExportedHandler<Env, AdapterJobMessage>;

function toPublicAccount(account: AdapterAccount): AdapterAccount {
  return {
    id: account.id,
    tenantId: account.tenantId,
    legalEntityId: account.legalEntityId,
    companyBan: account.companyBan,
    companyName: account.companyName,
    routingId: account.routingId,
    routingDescription: account.routingDescription,
    egressProfile: account.egressProfile,
    platformEnvironment: account.platformEnvironment,
    active: account.active,
    hasCredentialLease: account.hasCredentialLease,
    credentialExpiresAt: account.credentialExpiresAt,
    createdAt: account.createdAt,
    updatedAt: account.updatedAt,
  };
}

async function startWorkflowIfNeeded<T extends object>(workflow: Workflow<T>, id: string, params: T): Promise<void> {
  const instance = await workflow.get(id);
  const status = await instance.status();
  if (status.status === "unknown") {
    await workflow.create({ id, params });
  } else if (status.status === "errored" || status.status === "terminated") {
    await instance.restart();
  }
}

function problem(
  status: number,
  code: string,
  message: string,
  requestId: string,
  details?: Record<string, unknown>,
): Response {
  return Response.json(
    {
      type: `https://finance.example/problems/${code.toLowerCase()}`,
      title: message,
      status,
      code,
      requestId,
      ...(details ? { details } : {}),
    },
    { status, headers: { "content-type": "application/problem+json" } },
  );
}
