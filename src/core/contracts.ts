import { z } from "zod";

export const countryCode = "TW" as const;
export const migVersion = "4.1" as const;

export const outboundMessageTypes = [
  "A0101",
  "A0102",
  "A0201",
  "A0202",
  "A0301",
  "A0302",
  "B0101",
  "B0102",
  "B0201",
  "B0202",
  "E0401",
  "E0402",
  "F0401",
  "F0501",
  "F0701",
  "G0401",
  "G0501",
  "G0701",
] as const;

export const inboundOnlyMessageTypes = ["E0501", "E0502", "E0503", "E0504"] as const;
export const messageTypes = [...outboundMessageTypes, ...inboundOnlyMessageTypes] as const;

export const categoryTypes = ["B2B", "B2C", "B2S", "B2P"] as const;
export const processTypes = ["STORAGE", "EXCHANGE", "MESSAGE"] as const;

export type MessageType = (typeof messageTypes)[number];
export type OutboundMessageType = (typeof outboundMessageTypes)[number];
export type CategoryType = (typeof categoryTypes)[number];
export type ProcessType = (typeof processTypes)[number];

export const outboundProtocolRules: Record<
  OutboundMessageType,
  { categoryType: CategoryType; processType: ProcessType }
> = {
  A0101: { categoryType: "B2B", processType: "EXCHANGE" },
  A0102: { categoryType: "B2B", processType: "EXCHANGE" },
  A0201: { categoryType: "B2B", processType: "EXCHANGE" },
  A0202: { categoryType: "B2B", processType: "EXCHANGE" },
  A0301: { categoryType: "B2B", processType: "EXCHANGE" },
  A0302: { categoryType: "B2B", processType: "EXCHANGE" },
  B0101: { categoryType: "B2B", processType: "EXCHANGE" },
  B0102: { categoryType: "B2B", processType: "EXCHANGE" },
  B0201: { categoryType: "B2B", processType: "EXCHANGE" },
  B0202: { categoryType: "B2B", processType: "EXCHANGE" },
  E0401: { categoryType: "B2P", processType: "MESSAGE" },
  E0402: { categoryType: "B2P", processType: "MESSAGE" },
  F0401: { categoryType: "B2S", processType: "STORAGE" },
  F0501: { categoryType: "B2S", processType: "STORAGE" },
  F0701: { categoryType: "B2S", processType: "STORAGE" },
  G0401: { categoryType: "B2S", processType: "STORAGE" },
  G0501: { categoryType: "B2S", processType: "STORAGE" },
  G0701: { categoryType: "B2S", processType: "STORAGE" },
};

export const submissionStatuses = [
  "RECEIVED",
  "VALIDATING",
  "VALIDATED",
  "PACKED",
  "SIGNED",
  "SFTP_UPLOADED",
  "API_ACCEPTED",
  "WAITING_RESULT",
  "CONFIRMED",
  "PARTIALLY_REJECTED",
  "REJECTED",
  "FAILED",
] as const;

export type SubmissionStatus = (typeof submissionStatuses)[number];

const idSchema = z.string().trim().min(1).max(128);
const banSchema = z.string().regex(/^\d{8,10}$/, "BAN must contain 8 to 10 digits");
const pfxBase64Schema = z
  .string()
  .trim()
  .min(16)
  .max(4_000_000)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/u, "pfxBase64 must be standard Base64 without line breaks");

export const turnkeyCredentialLeaseSchema = z.object({
  transport: z.object({
    loginId: z.string().trim().min(1).max(256),
    loginPassword: z.string().min(1).max(1024),
  }),
  signing: z.object({
    format: z.literal("PFX"),
    pfxBase64: pfxBase64Schema,
    password: z.string().max(1024),
  }),
  leaseSeconds: z.number().int().min(300).max(30 * 24 * 60 * 60).default(7 * 24 * 60 * 60),
});

export type TurnkeyCredentialLeaseInput = z.infer<typeof turnkeyCredentialLeaseSchema>;
export type TurnkeyCredentialBundle = Omit<TurnkeyCredentialLeaseInput, "leaseSeconds">;

export const financeDocumentSchema = z.object({
  externalDocumentId: idSchema,
  sourceFilename: z.string().trim().min(1).max(180).optional(),
  xml: z.string().min(20).max(15_000_000),
});

export const financeSubmissionSchema = z
  .object({
    contractVersion: z.literal("1"),
    country: z.literal(countryCode),
    tenantId: idSchema,
    legalEntityId: idSchema,
    externalBatchId: idSchema,
    idempotencyKey: z.string().trim().min(8).max(180),
    messageType: z.enum(outboundMessageTypes),
    categoryType: z.enum(categoryTypes),
    processType: z.enum(processTypes),
    fromPartyId: banSchema.optional(),
    toPartyId: banSchema.optional(),
    credentials: turnkeyCredentialLeaseSchema,
    documents: z.array(financeDocumentSchema).min(1).max(1000),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .superRefine((request, context) => {
    const protocolRule = outboundProtocolRules[request.messageType];
    if (request.categoryType !== protocolRule.categoryType) {
      context.addIssue({
        code: "custom",
        path: ["categoryType"],
        message: `${request.messageType} requires categoryType ${protocolRule.categoryType}`,
      });
    }
    if (request.processType !== protocolRule.processType) {
      context.addIssue({
        code: "custom",
        path: ["processType"],
        message: `${request.messageType} requires processType ${protocolRule.processType}`,
      });
    }
    if (request.processType === "EXCHANGE" && request.documents.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["documents"],
        message: "Turnkey B2B EXCHANGE accepts exactly one invoice document per transmission",
      });
    }
    if (request.processType === "EXCHANGE" && request.categoryType !== "B2B") {
      context.addIssue({
        code: "custom",
        path: ["categoryType"],
        message: "Turnkey EXCHANGE transmissions must use categoryType B2B",
      });
    }
    if (request.processType !== "EXCHANGE" && request.toPartyId !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["toPartyId"],
        message: "toPartyId is only accepted for EXCHANGE; storage/message transmissions target the platform",
      });
    }
  });

export type FinanceSubmissionRequest = z.infer<typeof financeSubmissionSchema>;
export type FinanceDocument = z.infer<typeof financeDocumentSchema>;

export const adapterAccountSchema = z.object({
  id: idSchema,
  tenantId: idSchema,
  legalEntityId: idSchema,
  companyBan: banSchema,
  companyName: z.string().trim().min(1).max(200),
  routingId: z.string().trim().min(1).max(39),
  routingDescription: z.string().trim().max(200).default(""),
  egressProfile: z.string().trim().min(1).max(80),
  platformEnvironment: z.enum(["TEST", "PRODUCTION"]),
  active: z.boolean().default(true),
});

export type AdapterAccountInput = z.infer<typeof adapterAccountSchema>;

export interface AdapterAccount extends AdapterAccountInput {
  hasCredentialLease: boolean;
  credentialExpiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StoredDocument {
  externalDocumentId: string;
  sourceFilename: string;
  invoiceIdentifier: string | null;
  xml: string;
}

export interface SubmissionManifest {
  contractVersion: "1";
  submissionId: string;
  country: typeof countryCode;
  tenantId: string;
  legalEntityId: string;
  externalBatchId: string;
  idempotencyKey: string;
  messageType: OutboundMessageType;
  categoryType: CategoryType;
  processType: ProcessType;
  fromPartyId: string;
  toPartyId: string;
  documents: StoredDocument[];
  metadata: Record<string, string>;
  acceptedAt: string;
}

export interface SubmissionView {
  id: string;
  adapter: "tw-mof-einvoice";
  country: typeof countryCode;
  tenantId: string;
  legalEntityId: string;
  externalBatchId: string;
  messageType: MessageType;
  categoryType: CategoryType;
  processType: ProcessType;
  status: SubmissionStatus;
  documentCount: number;
  credentialExpiresAt: string;
  remoteFilename: string | null;
  lastError: { code: string | null; message: string } | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface SubmissionQueueMessage {
  kind: "TRANSMIT";
  submissionId: string;
}

export interface PollQueueMessage {
  kind: "POLL";
  accountId: string;
  pollId: string;
}

export type AdapterJobMessage = SubmissionQueueMessage | PollQueueMessage;

export interface FinanceAdapterEvent {
  contractVersion: "1";
  eventId: string;
  eventType:
    | "SUBMISSION_STATUS_CHANGED"
    | "INBOUND_DOCUMENTS_RECEIVED"
    | "INBOUND_ACK_RECEIVED"
    | "SUMMARY_RESULT_RECEIVED"
    | "INBOUND_FILE_UNMATCHED";
  adapter: "tw-mof-einvoice";
  country: typeof countryCode;
  tenantId: string;
  legalEntityId: string;
  submissionId: string | null;
  externalBatchId: string | null;
  status: SubmissionStatus | "UNMATCHED";
  occurredAt: string;
  data: Record<string, string | number | boolean | null>;
}

export interface TransmissionWorkflowParams {
  submissionId: string;
}

export interface InboundWorkflowParams {
  accountId: string;
  pollId: string;
}

export interface PartyInfo {
  partyId: string;
  description: string;
  routingId: string;
  routingDescription: string;
}

export interface GatewayInvoiceEvent {
  transFrom: {
    partyInfo: { partyId: string; description: string };
    routingInfo: { routingId: string; description: string };
  };
  transTo: {
    partyInfo: { partyId: string; description: string };
    routingInfo: { routingId: string; description: string };
  };
  serviceType: "E" | "S";
  messageType: OutboundMessageType;
  action: CategoryType;
  quantity: number;
  migVersion: "v41";
  filename: string;
  size: number;
  zip: "0";
  retry: number;
  apiVersion: string;
  turnkeyVersion: string;
}

export interface EgressValidationResult {
  valid: boolean;
  errors: Array<{ index: number; schema: string; message: string }>;
}

export interface EgressUploadResult {
  filename: string;
  size: number;
  alreadyExisted: boolean;
}

export interface EgressGatewayResult {
  statusCode: number;
  statusMessage?: string;
  details: Array<{ code: string; description: string; parameters: string[] }>;
}

export interface EgressRemoteFile {
  name: string;
  size: number;
  modifiedAt: number;
}
