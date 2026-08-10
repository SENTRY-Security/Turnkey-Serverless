import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import {
  AdapterError,
  buildInvoiceEnvelope,
  classifyInboundFilename,
  createTurnkeyFilename,
  errorMessage,
  parseProcessResult,
  parseSummaryResult,
  resolveProcessResult,
  tryParseInvoiceEnvelope,
  type EgressGatewayResult,
  type FinanceAdapterEvent,
  type GatewayInvoiceEvent,
  type InboundWorkflowParams,
  type PartyInfo,
  type SubmissionManifest,
  type TurnkeyCredentialBundle,
  type TransmissionWorkflowParams,
} from "../core/index.js";
import {
  deleteOutboundResult,
  decryptE0504Result,
  downloadOutboundResult,
  listOutboundResults,
  queryTradingPartner,
  queryCrossBorderSellers,
  registerGatewayEvent,
  uploadSignedFile,
  validateDocuments,
  validateEnvelope,
  validateXmlDocuments,
  verifySignedResult,
} from "./egress-client.js";
import { sha256Hex } from "./crypto.js";
import { loadCredentialLease } from "./credential-vault.js";
import { signEnvelopeWithPfx } from "./pfx-signer.js";
import { credentialContext } from "./submissions.js";
import {
  appendStatusEvent,
  findSubmissionForResult,
  getAccountById,
  getCrossBorderSellerCache,
  getSubmission,
  getSubmissionDocuments,
  makeFinanceEvent,
  reserveInboundFile,
  replaceCrossBorderSellerCache,
  updateInboundFile,
  updateSubmissionDocumentOutcomes,
  updateSubmissionStatus,
  updateTransmissionArtifacts,
  type SubmissionRow,
  type StoredAdapterAccount,
} from "./repository.js";

const retryConfig = {
  retries: { limit: 5, delay: "10 seconds", backoff: "exponential" },
  timeout: "5 minutes",
} as const;

interface TransmissionContext {
  submission: SubmissionRow;
  account: StoredAdapterAccount;
}

interface PackedArtifact {
  envelopeKey: string;
  envelopeSha256: string;
  remoteFilename: string;
  from: PartyInfo;
  to: PartyInfo;
}

interface SignedArtifact extends PackedArtifact {
  signedKey: string;
  signedSha256: string;
  signedSize: number;
}

export class TransmissionWorkflow extends WorkflowEntrypoint<Env, TransmissionWorkflowParams> {
  override async run(event: WorkflowEvent<TransmissionWorkflowParams>, step: WorkflowStep): Promise<void> {
    const submissionId = event.payload.submissionId;
    try {
      const context = await step.do("load transmission context", async () => this.loadContext(submissionId));

      await step.do("validate MIG documents", retryConfig, async () => {
        await updateSubmissionStatus(this.env.TURNKEY_DB, submissionId, "VALIDATING");
        const manifest = await loadManifest(this.env, context.submission.source_r2_key);
        const crossBorderSellerIds = await this.resolveCrossBorderSellers(context);
        const validation = await validateDocuments(
          this.env,
          context.account.egressProfile,
          manifest.messageType,
          manifest.documents.map((document) => document.xml),
          crossBorderSellerIds,
        );
        if (!validation.valid) {
          const message = validation.errors.map((error) => `#${error.index + 1}: ${error.message}`).join("; ");
          await updateSubmissionStatus(this.env.TURNKEY_DB, submissionId, "FAILED", {
            errorCode: "TW_XSD_VALIDATION_FAILED",
            errorMessage: message,
            completed: true,
            details: { errors: validation.errors },
          });
          throw new NonRetryableError(message);
        }
        await updateSubmissionStatus(this.env.TURNKEY_DB, submissionId, "VALIDATED");
        return { valid: true };
      });

      const packed = await step.do("pack invoice envelope", retryConfig, async () => {
        const manifest = await loadManifest(this.env, context.submission.source_r2_key);
        const parties = await this.resolveParties(context, manifest);
        const envelope = buildInvoiceEnvelope({
          messageType: manifest.messageType,
          from: parties.from,
          to: parties.to,
          documents: manifest.documents,
        });
        const envelopeSha256 = await sha256Hex(envelope);
        const envelopeKey = artifactKey(context.submission, "packed/envelope.xml");
        await this.env.TURNKEY_FILES.put(envelopeKey, envelope, {
          httpMetadata: { contentType: "application/xml; charset=utf-8" },
          customMetadata: { sha256: envelopeSha256, submissionId },
        });
        const proposedFilename = createTurnkeyFilename({
          messageType: manifest.messageType,
          messageDts: context.submission.message_dts,
          uuid: context.submission.message_uuid,
        });
        const coordinator = this.env.TRANSMISSION_COORDINATOR.getByName(context.account.id);
        const reservation = await coordinator.reserve(submissionId, proposedFilename);
        await updateTransmissionArtifacts(this.env.TURNKEY_DB, submissionId, {
          envelopeKey,
          remoteFilename: reservation.remoteFilename,
          fromRoutingId: parties.from.routingId,
          toRoutingId: parties.to.routingId,
          workflowInstanceId: event.instanceId,
        });
        await updateSubmissionStatus(this.env.TURNKEY_DB, submissionId, "PACKED");
        return {
          envelopeKey,
          envelopeSha256,
          remoteFilename: reservation.remoteFilename,
          from: parties.from,
          to: parties.to,
        } satisfies PackedArtifact;
      });

      const signed = await step.do("sign invoice envelope", retryConfig, async () => {
        const envelopeObject = await this.env.TURNKEY_FILES.get(packed.envelopeKey);
        if (!envelopeObject) {
          throw new AdapterError("TW_ENVELOPE_MISSING", `Missing ${packed.envelopeKey}`, { retryable: true });
        }
        const envelope = await envelopeObject.text();
        await validateEnvelope(this.env, context.account.egressProfile, envelope);
        const credentials = await loadSubmissionCredentials(this.env, context);
        const signedText = signEnvelopeWithPfx(envelope, credentials.signing);
        const signedSize = new TextEncoder().encode(signedText).byteLength;
        if (signedSize > 0x14_00000) {
          throw new NonRetryableError(`Signed Turnkey file exceeds 20 MiB: ${signedSize} bytes`);
        }
        const signedSha256 = await sha256Hex(signedText);
        const signedKey = artifactKey(context.submission, `signed/${packed.remoteFilename}`);
        await this.env.TURNKEY_FILES.put(signedKey, signedText, {
          httpMetadata: { contentType: "application/pkcs7-mime" },
          customMetadata: { sha256: signedSha256, submissionId },
        });
        await updateTransmissionArtifacts(this.env.TURNKEY_DB, submissionId, { signedKey, signedSha256 });
        await updateSubmissionStatus(this.env.TURNKEY_DB, submissionId, "SIGNED");
        return { ...packed, signedKey, signedSha256, signedSize } satisfies SignedArtifact;
      });

      await step.do("upload signed file over SFTP", retryConfig, async () => {
        const object = await this.env.TURNKEY_FILES.get(signed.signedKey);
        if (!object) {
          throw new AdapterError("TW_SIGNED_FILE_MISSING", `Missing ${signed.signedKey}`, { retryable: true });
        }
        const signedText = await object.text();
        const result = await uploadSignedFile(
          this.env,
          context.account.egressProfile,
          (await loadSubmissionCredentials(this.env, context)).transport,
          signed.remoteFilename,
          signedText,
          signed.signedSha256,
        );
        if (result.size !== signed.signedSize) {
          throw new AdapterError(
            "TW_SFTP_SIZE_MISMATCH",
            `Uploaded size ${result.size} differs from local ${signed.signedSize}`,
            { retryable: true },
          );
        }
        await this.env.TRANSMISSION_COORDINATOR.getByName(context.account.id).markStage(submissionId, "SFTP_UPLOADED");
        await updateSubmissionStatus(this.env.TURNKEY_DB, submissionId, "SFTP_UPLOADED");
        return result;
      });

      const gateway = await step.do("register Gateway invoice event", retryConfig, async () => {
        await updateTransmissionArtifacts(this.env.TURNKEY_DB, submissionId, { incrementAttempt: true });
        const gatewayAttempt = await getSubmission(this.env.TURNKEY_DB, submissionId);
        const manifest = await loadManifest(this.env, context.submission.source_r2_key);
        const invoiceEvent: GatewayInvoiceEvent = {
          transFrom: {
            partyInfo: { partyId: signed.from.partyId, description: signed.from.description },
            routingInfo: { routingId: signed.from.routingId, description: signed.from.routingDescription },
          },
          transTo: {
            partyInfo: { partyId: signed.to.partyId, description: signed.to.description },
            routingInfo: { routingId: signed.to.routingId, description: signed.to.routingDescription },
          },
          serviceType: manifest.processType === "EXCHANGE" ? "E" : "S",
          messageType: manifest.messageType,
          action: manifest.categoryType,
          quantity: manifest.documents.length,
          migVersion: "v41",
          filename: signed.remoteFilename,
          size: signed.signedSize,
          zip: "0",
          retry: (gatewayAttempt?.attempt_count ?? 1) > 1 ? 1 : 0,
          apiVersion: this.env.GATEWAY_API_VERSION,
          turnkeyVersion: this.env.TURNKEY_COMPAT_VERSION,
        };
        const credentials = await loadSubmissionCredentials(this.env, context);
        const result = await registerGatewayEvent(
          this.env,
          context.account.egressProfile,
          credentials.transport,
          invoiceEvent,
        );
        try {
          assertGatewayAccepted(result);
        } catch (error) {
          if (error instanceof AdapterError && !error.retryable) {
            await updateSubmissionStatus(this.env.TURNKEY_DB, submissionId, "FAILED", {
              errorCode: error.code,
              errorMessage: error.message,
              completed: true,
              details: { gateway: result },
            });
            throw new NonRetryableError(error.message);
          }
          throw error;
        }
        await this.env.TRANSMISSION_COORDINATOR.getByName(context.account.id).markStage(submissionId, "API_ACCEPTED");
        await updateSubmissionStatus(this.env.TURNKEY_DB, submissionId, "API_ACCEPTED");
        return result;
      });

      await step.do("wait for ProcessResult", async () => {
        await updateSubmissionStatus(this.env.TURNKEY_DB, submissionId, "WAITING_RESULT", {
          details: { gatewayStatusCode: gateway.statusCode },
        });
        const latest = await getSubmission(this.env.TURNKEY_DB, submissionId);
        if (latest) {
          await this.env.FINANCE_EVENTS.send(makeFinanceEvent(latest, "WAITING_RESULT"));
        }
      });
    } catch (error) {
      await step.do("record terminal transmission failure", async () => {
        const current = await getSubmission(this.env.TURNKEY_DB, submissionId);
        if (current && current.status !== "FAILED") {
          const code = error instanceof AdapterError ? error.code : "TW_TRANSMISSION_FAILED";
          await updateSubmissionStatus(this.env.TURNKEY_DB, submissionId, "FAILED", {
            errorCode: code,
            errorMessage: errorMessage(error),
            completed: true,
          });
        }
        const failed = await getSubmission(this.env.TURNKEY_DB, submissionId);
        if (failed) {
          await this.env.FINANCE_EVENTS.send(
            makeFinanceEvent(failed, "FAILED", { code: failed.last_error_code ?? "TW_TRANSMISSION_FAILED" }),
          );
        }
      });
      throw error;
    }
  }

  private async loadContext(submissionId: string): Promise<TransmissionContext> {
    const submission = await getSubmission(this.env.TURNKEY_DB, submissionId);
    if (!submission) {
      throw new NonRetryableError(`Submission ${submissionId} was not found`);
    }
    const account = await getAccountById(this.env.TURNKEY_DB, submission.account_id);
    if (!account?.active) {
      throw new NonRetryableError(`Adapter account ${submission.account_id} is missing or inactive`);
    }
    return { submission, account };
  }

  private async resolveParties(
    context: TransmissionContext,
    manifest: SubmissionManifest,
  ): Promise<{ from: PartyInfo; to: PartyInfo }> {
    const from: PartyInfo = {
      partyId: context.account.companyBan,
      description: context.account.companyName,
      routingId: context.account.routingId,
      routingDescription: context.account.routingDescription,
    };
    if (manifest.processType !== "EXCHANGE") {
      return {
        from,
        to: { partyId: "00000000", description: "", routingId: "0", routingDescription: "" },
      };
    }
    const cached = await this.env.TURNKEY_DB.prepare(
      "SELECT routing_id, description FROM routing_cache WHERE account_id = ? AND party_id = ? AND expires_at > ?",
    )
      .bind(context.account.id, manifest.toPartyId, new Date().toISOString())
      .first<{ routing_id: string; description: string }>();
    const route = cached
      ? { routingId: cached.routing_id, description: cached.description }
      : await queryTradingPartner(
          this.env,
          context.account.egressProfile,
          (await loadSubmissionCredentials(this.env, context)).transport,
          manifest.toPartyId,
        );
    if (!cached) {
      const now = new Date();
      const expires = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
      await this.env.TURNKEY_DB.prepare(
        `INSERT INTO routing_cache (account_id, party_id, routing_id, description, expires_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, party_id) DO UPDATE SET routing_id = excluded.routing_id,
         description = excluded.description, expires_at = excluded.expires_at, updated_at = excluded.updated_at`,
      )
        .bind(context.account.id, manifest.toPartyId, route.routingId, route.description, expires, now.toISOString())
        .run();
    }
    return {
      from,
      to: {
        partyId: manifest.toPartyId,
        description: route.description,
        routingId: route.routingId,
        routingDescription: route.description,
      },
    };
  }

  private async resolveCrossBorderSellers(context: TransmissionContext): Promise<string[]> {
    const cached = await getCrossBorderSellerCache(this.env.TURNKEY_DB, context.account.id);
    const freshAfter = Date.now() - 24 * 60 * 60 * 1000;
    if (cached.refreshedAt && Date.parse(cached.refreshedAt) > freshAfter) {
      return cached.sellerIds;
    }
    const sellerIds = await queryCrossBorderSellers(
      this.env,
      context.account.egressProfile,
      (await loadSubmissionCredentials(this.env, context)).transport,
    );
    await replaceCrossBorderSellerCache(this.env.TURNKEY_DB, context.account.id, sellerIds);
    return sellerIds;
  }
}

export class InboundWorkflow extends WorkflowEntrypoint<Env, InboundWorkflowParams> {
  override async run(event: WorkflowEvent<InboundWorkflowParams>, step: WorkflowStep): Promise<void> {
    const account = await step.do("load inbound account", async () => {
      const value = await getAccountById(this.env.TURNKEY_DB, event.payload.accountId);
      if (!value?.active) {
        throw new NonRetryableError(`Account ${event.payload.accountId} is missing or inactive`);
      }
      return value;
    });
    const files = await step.do("list SFTP outbox", retryConfig, async () =>
      listOutboundResults(
        this.env,
        account.egressProfile,
        (await loadAccountCredentials(this.env, account)).transport,
      ),
    );

    for (const [index, file] of files.entries()) {
      const inbound = await step.do(`inbound ${index} reserve`, async () =>
        reserveInboundFile(this.env.TURNKEY_DB, {
          id: crypto.randomUUID(),
          accountId: account.id,
          remoteFilename: file.name,
          size: file.size,
        }),
      );
      if (["PROCESSED", "FORWARDED", "UNMATCHED", "QUARANTINED", "DELETED"].includes(inbound.status)) {
        await step.do(`inbound ${index} remove processed duplicate`, retryConfig, async () => {
          await deleteOutboundResult(
            this.env,
            account.egressProfile,
            (await loadAccountCredentials(this.env, account)).transport,
            file.name,
          );
          if (inbound.status !== "DELETED") {
            await updateInboundFile(this.env.TURNKEY_DB, inbound.id, { status: "DELETED" });
          }
        });
        continue;
      }

      const downloaded = await step.do(`inbound ${index} download`, retryConfig, async () => {
        const bytes = await downloadOutboundResult(
          this.env,
          account.egressProfile,
          (await loadAccountCredentials(this.env, account)).transport,
          file.name,
        );
        if (bytes.byteLength !== file.size) {
          throw new AdapterError(
            "TW_INBOUND_SIZE_MISMATCH",
            `${file.name}: listed ${file.size}, downloaded ${bytes.byteLength}`,
            { retryable: true },
          );
        }
        const hash = await sha256Hex(bytes);
        const encryptedE0504 = classifyInboundFilename(file.name).kind === "E0504";
        const rawKey = `tw/${account.tenantId}/${account.legalEntityId}/inbound/${inbound.id}/${
          encryptedE0504 ? "raw.e0504" : "raw.p7m"
        }`;
        await this.env.TURNKEY_FILES.put(rawKey, bytes, {
          httpMetadata: { contentType: encryptedE0504 ? "application/octet-stream" : "application/pkcs7-mime" },
          customMetadata: { sha256: hash, remoteFilename: file.name },
        });
        await updateInboundFile(this.env.TURNKEY_DB, inbound.id, { status: "DOWNLOADED", rawKey, sha256: hash });
        return { rawKey, hash };
      });

      let processed: { status: string; submissionId: string | null; extractedKey: string };
      try {
        processed = await step.do(`inbound ${index} verify and process`, retryConfig, async () => {
          const raw = await this.env.TURNKEY_FILES.get(downloaded.rawKey);
          if (!raw) {
            throw new AdapterError("TW_INBOUND_OBJECT_MISSING", `Missing ${downloaded.rawKey}`, { retryable: true });
          }
          const classification = classifyInboundFilename(file.name);
          const rawBytes = await raw.arrayBuffer();

          if (classification.kind === "E0504") {
            const documents = await decryptE0504Result(
              this.env,
              account.egressProfile,
              file.name,
              rawBytes,
            );
            const extractedKey = `tw/${account.tenantId}/${account.legalEntityId}/inbound/${inbound.id}/content.json`;
            await this.env.TURNKEY_FILES.put(extractedKey, JSON.stringify({ messageType: "E0504", documents }), {
              httpMetadata: { contentType: "application/json; charset=utf-8" },
              customMetadata: { remoteFilename: file.name, messageType: "E0504" },
            });
            await updateInboundFile(this.env.TURNKEY_DB, inbound.id, { status: "FORWARDED", extractedKey });
            await this.env.FINANCE_EVENTS.send(
              inboundEvent(account, inbound.id, file.name, "INBOUND_DOCUMENTS_RECEIVED", {
                messageType: "E0504",
                documentCount: documents.length,
                sellerPartyId: classification.value.sellerPartyId,
                rocYearMonth: classification.value.rocYearMonth,
              }),
            );
            return { status: "FORWARDED", submissionId: null, extractedKey };
          }

          const xml = await verifySignedResult(this.env, account.egressProfile, rawBytes);
          const extractedKey = `tw/${account.tenantId}/${account.legalEntityId}/inbound/${inbound.id}/content.xml`;
          await this.env.TURNKEY_FILES.put(extractedKey, xml, {
            httpMetadata: {
              contentType:
                classification.kind === "SUMMARY_RESULT" && /^\s*\d+\s*$/u.test(xml)
                  ? "text/plain; charset=utf-8"
                  : "application/xml; charset=utf-8",
            },
            customMetadata: { remoteFilename: file.name },
          });

          if (classification.kind === "PROCESS_RESULT") {
            await validateXmlDocuments(this.env, account.egressProfile, "common/v41/ProcessResult", [xml]);
            const result = parseProcessResult(xml);
            if (result.service === "E" && result.infos.length > 1) {
              throw new AdapterError(
                "TW_RESULT_INFO_INVALID",
                "An EXCHANGE ProcessResult must contain exactly one Result/Info entry",
              );
            }
            if (result.messageType !== classification.value.messageType) {
              throw new AdapterError(
                "TW_RESULT_MESSAGE_TYPE_MISMATCH",
                `Filename declares ${classification.value.messageType}; ProcessResult contains ${result.messageType}`,
              );
            }
            const submission = await findSubmissionForResult(
              this.env.TURNKEY_DB,
              account.id,
              classification.value.uuid,
              classification.value.messageDts,
            );
            if (!submission) {
              await updateInboundFile(this.env.TURNKEY_DB, inbound.id, {
                status: "UNMATCHED",
                extractedKey,
                lastError: `No submission for ${classification.value.uuid}/${classification.value.messageDts}`,
              });
              await this.env.FINANCE_EVENTS.send(
                inboundEvent(account, inbound.id, file.name, "INBOUND_FILE_UNMATCHED", {
                  reason: "PROCESS_RESULT_SUBMISSION_NOT_FOUND",
                  uuid: classification.value.uuid,
                }, "UNMATCHED"),
              );
              return { status: "UNMATCHED", submissionId: null, extractedKey };
            }
            if (result.messageType !== submission.message_type) {
              throw new AdapterError(
                "TW_RESULT_MESSAGE_TYPE_MISMATCH",
                `ProcessResult contains ${result.messageType}; expected ${submission.message_type}`,
              );
            }
            const expectedService = submission.process_type === "EXCHANGE" ? "E" : "S";
            if (result.service !== expectedService || result.action !== submission.category_type) {
              throw new AdapterError(
                "TW_RESULT_PROTOCOL_MISMATCH",
                `ProcessResult service/action ${result.service}/${result.action}; expected ${expectedService}/${submission.category_type}`,
              );
            }
            const documentRows = await getSubmissionDocuments(this.env.TURNKEY_DB, submission.id);
            const resolved = resolveProcessResult(
              result,
              documentRows.map((document) => ({
                documentIndex: document.document_index,
                invoiceIdentifier: document.invoice_identifier,
              })),
            );
            const rejected = resolved.outcomes.filter((outcome) => outcome.status === "REJECTED");
            await updateSubmissionDocumentOutcomes(this.env.TURNKEY_DB, submission.id, resolved.outcomes);
            await updateTransmissionArtifacts(this.env.TURNKEY_DB, submission.id, { resultKey: extractedKey });
            await updateSubmissionStatus(this.env.TURNKEY_DB, submission.id, resolved.status, {
              completed: true,
              errorCode: rejected[0]?.errorCode ?? null,
              errorMessage: rejected[0]?.errorMessage ?? null,
              details: {
                result: result.infos,
                documentOutcomes: resolved.outcomes,
                unresolvedErrors: resolved.unresolvedErrors,
                remoteFilename: file.name,
              },
            });
            await updateInboundFile(this.env.TURNKEY_DB, inbound.id, {
              status: "PROCESSED",
              extractedKey,
              submissionId: submission.id,
            });
            const updated = await getSubmission(this.env.TURNKEY_DB, submission.id);
            if (updated) {
              await this.env.FINANCE_EVENTS.send(
                makeFinanceEvent(updated, resolved.status, {
                  remoteFilename: file.name,
                  confirmedDocuments: resolved.outcomes.length - rejected.length,
                  rejectedDocuments: rejected.length,
                }),
              );
            }
            return { status: resolved.status, submissionId: submission.id, extractedKey };
          }

          if (classification.kind === "ACK") {
            await validateXmlDocuments(this.env, account.egressProfile, "common/v41/ProcessResult", [xml]);
            const result = parseProcessResult(xml);
            if (result.infos.length < 2) {
              throw new AdapterError("TW_ACK_INFO_INVALID", "Turnkey Ack must contain at least two Result/Info entries");
            }
            if (
              result.messageType !== classification.value.messageType ||
              result.service !== "E" ||
              result.action !== "B2B"
            ) {
              throw new AdapterError(
                "TW_ACK_PROTOCOL_MISMATCH",
                `Ack filename/message/service/action mismatch: ${classification.value.messageType}/${result.messageType}/${result.service}/${result.action}`,
              );
            }
            const acknowledgement = result.infos[1];
            await updateInboundFile(this.env.TURNKEY_DB, inbound.id, { status: "FORWARDED", extractedKey });
            await this.env.FINANCE_EVENTS.send(
              inboundEvent(account, inbound.id, file.name, "INBOUND_ACK_RECEIVED", {
                messageType: result.messageType,
                uuid: classification.value.uuid,
                accepted: acknowledgement?.code === "00000",
                code: acknowledgement?.code ?? null,
                description: acknowledgement?.description ?? null,
              }),
            );
            return { status: "FORWARDED", submissionId: null, extractedKey };
          }

          if (classification.kind === "SUMMARY_RESULT") {
            const quantity = /^\s*\d+\s*$/u.test(xml) ? Number(xml.trim()) : null;
            if (quantity !== null && !Number.isSafeInteger(quantity)) {
              throw new AdapterError("TW_SUMMARY_QUANTITY_INVALID", "SummaryResult quantity is not a safe integer");
            }
            let summary = null;
            if (quantity === null) {
              await validateXmlDocuments(this.env, account.egressProfile, "common/v41/SummaryResult", [xml]);
              summary = parseSummaryResult(xml);
              if (
                summary.from.partyId !== classification.value.senderPartyId ||
                summary.from.routingId !== classification.value.senderRoutingId ||
                summary.to.partyId !== classification.value.receiverPartyId ||
                summary.to.routingId !== classification.value.receiverRoutingId
              ) {
                throw new AdapterError(
                  "TW_SUMMARY_ROUTING_MISMATCH",
                  "SummaryResult filename routing does not match its signed XML content",
                );
              }
              if (summary.messages.some((message) => message.total.count !== message.good.count + message.failed.count)) {
                throw new AdapterError(
                  "TW_SUMMARY_COUNT_MISMATCH",
                  "SummaryResult total count does not equal good plus failed counts",
                );
              }
            }
            await updateInboundFile(this.env.TURNKEY_DB, inbound.id, { status: "FORWARDED", extractedKey });
            await this.env.FINANCE_EVENTS.send(
              inboundEvent(account, inbound.id, file.name, "SUMMARY_RESULT_RECEIVED", {
                transmissionDate: classification.value.transmissionDate,
                senderPartyId: classification.value.senderPartyId,
                receiverPartyId: classification.value.receiverPartyId,
                quantity: quantity ?? classification.value.count,
                messageCount: summary?.messages.length ?? 0,
                goodCount: summary?.messages.reduce((total, message) => total + message.good.count, 0) ?? 0,
                failedCount: summary?.messages.reduce((total, message) => total + message.failed.count, 0) ?? 0,
              }),
            );
            return { status: "FORWARDED", submissionId: null, extractedKey };
          }

          const envelope = tryParseInvoiceEnvelope(xml);
          if (envelope && (classification.kind === "E05" || classification.kind === "INVOICE")) {
            if (classification.kind === "E05" && envelope.messageType !== classification.value.messageType) {
              throw new AdapterError(
                "TW_INBOUND_MESSAGE_TYPE_MISMATCH",
                `Filename declares ${classification.value.messageType}; envelope contains ${envelope.messageType}`,
              );
            }
            if (classification.kind === "INVOICE") {
              const declaredType = file.name.slice(4, 9);
              if (envelope.messageType !== declaredType) {
                throw new AdapterError(
                  "TW_INBOUND_MESSAGE_TYPE_MISMATCH",
                  `Filename declares ${declaredType}; envelope contains ${envelope.messageType}`,
                );
              }
            }
            await validateXmlDocuments(this.env, account.egressProfile, "common/v41/InvoiceEnvelope", [xml]);
            const payloadSchema = ["E0501", "E0502", "E0503"].includes(envelope.messageType)
              ? `common/v41/${envelope.messageType}`
              : `v41/${envelope.messageType}`;
            await validateXmlDocuments(this.env, account.egressProfile, payloadSchema, envelope.documents);
            await updateInboundFile(this.env.TURNKEY_DB, inbound.id, { status: "FORWARDED", extractedKey });
            await this.env.FINANCE_EVENTS.send(
              inboundEvent(account, inbound.id, file.name, "INBOUND_DOCUMENTS_RECEIVED", {
                messageType: envelope.messageType,
                documentCount: envelope.count,
                fromPartyId: envelope.from.partyId,
                toPartyId: envelope.to.partyId,
              }),
            );
            return { status: "FORWARDED", submissionId: null, extractedKey };
          }

          await updateInboundFile(this.env.TURNKEY_DB, inbound.id, { status: "UNMATCHED", extractedKey });
          await this.env.FINANCE_EVENTS.send(
            inboundEvent(account, inbound.id, file.name, "INBOUND_FILE_UNMATCHED", {}, "UNMATCHED"),
          );
          return { status: "UNMATCHED", submissionId: null, extractedKey };
        });
      } catch (error) {
        const permanent = error instanceof AdapterError && !error.retryable;
        await step.do(`inbound ${index} record processing failure`, async () => {
          await updateInboundFile(this.env.TURNKEY_DB, inbound.id, {
            status: "FAILED",
            lastError: errorMessage(error),
          });
          await appendStatusEvent(this.env.TURNKEY_DB, {
            submissionId: null,
            accountId: account.id,
            eventType: "INBOUND_PROCESSING_FAILED",
            fromStatus: inbound.status,
            toStatus: "FAILED",
            code: error instanceof AdapterError ? error.code : "TW_INBOUND_PROCESSING_FAILED",
            message: errorMessage(error),
            data: { remoteFilename: file.name, rawKey: downloaded.rawKey },
          });
        });
        if (permanent) {
          await step.do(`inbound ${index} quarantine remote`, retryConfig, async () => {
            await deleteOutboundResult(
              this.env,
              account.egressProfile,
              (await loadAccountCredentials(this.env, account)).transport,
              file.name,
            );
            await updateInboundFile(this.env.TURNKEY_DB, inbound.id, {
              status: "QUARANTINED",
              lastError: errorMessage(error),
            });
            await appendStatusEvent(this.env.TURNKEY_DB, {
              submissionId: null,
              accountId: account.id,
              eventType: "INBOUND_QUARANTINED",
              fromStatus: "FAILED",
              toStatus: "QUARANTINED",
              code: error.code,
              message: file.name,
              data: { rawKey: downloaded.rawKey },
            });
          });
        }
        continue;
      }

      await step.do(`inbound ${index} delete remote`, retryConfig, async () => {
        await deleteOutboundResult(
          this.env,
          account.egressProfile,
          (await loadAccountCredentials(this.env, account)).transport,
          file.name,
        );
        await updateInboundFile(this.env.TURNKEY_DB, inbound.id, { status: "DELETED" });
        await appendStatusEvent(this.env.TURNKEY_DB, {
          submissionId: processed.submissionId,
          accountId: account.id,
          eventType: "INBOUND_REMOTE_DELETED",
          fromStatus: processed.status,
          toStatus: "DELETED",
          code: null,
          message: file.name,
          data: { extractedKey: processed.extractedKey },
        });
      });
    }
  }
}

async function loadSubmissionCredentials(env: Env, context: TransmissionContext): Promise<TurnkeyCredentialBundle> {
  if (Date.parse(context.submission.credential_expires_at) <= Date.now()) {
    return loadAccountCredentials(env, context.account);
  }
  return loadCredentialLease(
    env,
    context.submission.credential_r2_key,
    credentialContext(context.account.id),
    context.submission.credential_expires_at,
  );
}

async function loadAccountCredentials(env: Env, account: StoredAdapterAccount): Promise<TurnkeyCredentialBundle> {
  if (!account.credentialR2Key || !account.credentialExpiresAt) {
    throw new NonRetryableError(`Account ${account.id} has no active credential lease`);
  }
  return loadCredentialLease(
    env,
    account.credentialR2Key,
    credentialContext(account.id),
    account.credentialExpiresAt,
  );
}

async function loadManifest(env: Env, key: string): Promise<SubmissionManifest> {
  const object = await env.TURNKEY_FILES.get(key);
  if (!object) {
    throw new AdapterError("TW_SOURCE_MANIFEST_MISSING", `Missing ${key}`, { retryable: true });
  }
  return object.json<SubmissionManifest>();
}

function artifactKey(submission: SubmissionRow, suffix: string): string {
  return `tw/${submission.tenant_id}/${submission.legal_entity_id}/${submission.created_at.slice(0, 10)}/${submission.id}/${suffix}`;
}

function assertGatewayAccepted(result: EgressGatewayResult): void {
  if (result.statusCode === 0) {
    return;
  }
  const detail = result.details.map((item) => `[${item.code}] ${item.description}`).join("; ");
  throw new AdapterError(
    result.details[0]?.code ?? "TW_GATEWAY_REJECTED",
    detail || result.statusMessage || `Gateway status ${result.statusCode}`,
    { retryable: result.statusCode >= 500 },
  );
}

function inboundEvent(
  account: StoredAdapterAccount,
  inboundFileId: string,
  remoteFilename: string,
  eventType: FinanceAdapterEvent["eventType"],
  data: FinanceAdapterEvent["data"],
  status: FinanceAdapterEvent["status"] = "RECEIVED",
): FinanceAdapterEvent {
  return {
    contractVersion: "1",
    eventId: `tw:inbound:${inboundFileId}:${eventType}`,
    eventType,
    adapter: "tw-mof-einvoice",
    country: "TW",
    tenantId: account.tenantId,
    legalEntityId: account.legalEntityId,
    submissionId: null,
    externalBatchId: null,
    status,
    occurredAt: new Date().toISOString(),
    data: { inboundFileId, remoteFilename, ...data },
  };
}
