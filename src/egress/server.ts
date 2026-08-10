import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { z } from "zod";
import { authenticateRequest, EgressHttpError, readVerifiedBody } from "./auth.js";
import { loadConfig, type EgressAccount } from "./config.js";
import {
  queryCrossBorderSellers,
  queryErrorMessageInfo,
  queryTurnkeyVersionInfo,
  registerInvoiceEvent,
  queryTradingPartner,
} from "./gateway.js";
import { deleteOutbox, downloadOutbox, listOutbox, uploadInbox } from "./sftp.js";
import { verifyAndExtractCms } from "./cms.js";
import { validateXml } from "./xml-validator.js";
import { validateBusinessRules } from "./business-rules.js";
import {
  messageTypes,
  outboundMessageTypes,
  outboundProtocolRules,
  type GatewayInvoiceEvent,
} from "../core/index.js";
import { EphemeralSessionStore } from "./sessions.js";
import { decryptE0504 } from "./e0504.js";

const config = loadConfig();
const sessions = new EphemeralSessionStore(config.sessionTtlSeconds);

const sessionRequestSchema = z.object({
  loginId: z.string().trim().min(1).max(256),
  loginPassword: z.string().min(1).max(1024),
  ttlSeconds: z.number().int().min(30).max(900).optional(),
});

const validationRequestSchema = z.object({
  schema: z.string().min(1),
  documents: z.array(z.string().min(1)).min(1).max(1000),
  crossBorderSellerIds: z.array(z.string().regex(/^\d{8,10}$/u)).max(10_000).default([]),
});

const tradingPartnerSchema = z.object({
  partyId: z.string().regex(/^\d{8,10}$/u),
  partnerType: z.enum(["0", "1"]),
});

const turnkeyVersionSchema = z.object({
  turnkeyVersion: z.string().min(1),
  apiVersion: z.string().min(1),
  compId: z.string().regex(/^\d{8,10}$/u),
  dbType: z.string().min(1),
  osType: z.string().min(1),
  jreVersion: z.string().min(1),
  tkyType: z.string().min(1),
});

const gatewayEventSchema = z.object({
  transFrom: z.object({
    partyInfo: z.object({ partyId: z.string(), description: z.string() }),
    routingInfo: z.object({ routingId: z.string(), description: z.string() }),
  }),
  transTo: z.object({
    partyInfo: z.object({ partyId: z.string(), description: z.string() }),
    routingInfo: z.object({ routingId: z.string(), description: z.string() }),
  }),
  serviceType: z.enum(["E", "S"]),
  messageType: z.enum(outboundMessageTypes),
  action: z.enum(["B2B", "B2C", "B2S", "B2P"]),
  quantity: z.number().int().min(1).max(1000),
  migVersion: z.literal("v41"),
  filename: z.string().min(1),
  size: z.number().int().positive().max(0x14_00000),
  zip: z.literal("0"),
  retry: z.number().int().min(0).max(1),
  apiVersion: z.string().min(1),
  turnkeyVersion: z.string().min(1),
});

const server = createServer(async (request, response) => {
  const requestId = crypto.randomUUID();
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
  try {
    if (request.method === "GET" && url.pathname === "/healthz") {
      return json(response, 200, { ok: true, service: "turnkey-egress", requestId });
    }
    const auth = authenticateRequest(request, `${url.pathname}${url.search}`, config.hmacSecret);
    const account = getAccount(auth.profile);

    if (request.method === "GET" && url.pathname === "/v1/profile") {
      await verifyEmptyBodyHash(request, auth.expectedBodySha256);
      return json(response, 200, { environment: account.environment });
    }

    if (request.method === "POST" && url.pathname === "/v1/sessions") {
      const body = await readVerifiedBody(request, auth.expectedBodySha256, 8 * 1024);
      const input = sessionRequestSchema.parse(JSON.parse(body.toString("utf8")));
      return json(response, 201, sessions.issue(auth.profile, input, input.ttlSeconds));
    }

    if (request.method === "POST" && url.pathname === "/v1/xml/validate") {
      const body = await readVerifiedBody(request, auth.expectedBodySha256);
      const input = validationRequestSchema.parse(JSON.parse(body.toString("utf8")));
      const errors: Array<{ index: number; schema: string; message: string }> = [];
      for (const [index, document] of input.documents.entries()) {
        const error = await validateXml(config.xsdRoot, input.schema, document);
        if (error) {
          errors.push({ index, schema: input.schema, message: error });
          continue;
        }
        const messageType = /^v41\/([A-Z]\d{4})$/u.exec(input.schema)?.[1];
        if (messageType && messageTypes.includes(messageType as (typeof messageTypes)[number])) {
          const businessFailure = validateBusinessRules(
            messageType as (typeof messageTypes)[number],
            document,
            Array.from(new Set([...account.crossBorderSellerIds, ...input.crossBorderSellerIds])),
          );
          if (businessFailure) {
            errors.push({
              index,
              schema: input.schema,
              message: `[${businessFailure.code}] ${businessFailure.message}`,
            });
          }
        }
      }
      return json(response, 200, { valid: errors.length === 0, errors });
    }

    if (request.method === "POST" && url.pathname === "/v1/signatures/verify") {
      const body = await readVerifiedBody(request, auth.expectedBodySha256);
      return text(response, 200, await verifyAndExtractCms(body), "application/xml; charset=utf-8");
    }

    if (request.method === "POST" && url.pathname === "/v1/e0504/decrypt") {
      const filename = url.searchParams.get("filename") ?? "";
      const body = await readVerifiedBody(request, auth.expectedBodySha256);
      const documents = decryptE0504(filename, body);
      for (const [index, document] of documents.entries()) {
        const error = await validateXml(config.xsdRoot, "common/v41/E0504", document.xml);
        if (error) {
          throw new EgressHttpError(
            422,
            "EGRESS_E0504_XSD_INVALID",
            `E0504 ZIP entry #${index + 1} (${document.filename}) failed XSD validation: ${error}`,
          );
        }
      }
      return json(response, 200, { documents });
    }

    const uploadMatch = /^\/v1\/sftp\/in\/([^/]+)$/u.exec(url.pathname);
    if (request.method === "POST" && uploadMatch?.[1]) {
      const body = await readVerifiedBody(request, auth.expectedBodySha256);
      const credentials = sessions.consume(auth.sessionToken, auth.profile);
      return json(response, 200, await uploadInbox(account, credentials, decodeURIComponent(uploadMatch[1]), body));
    }

    if (request.method === "GET" && url.pathname === "/v1/sftp/out") {
      await verifyEmptyBodyHash(request, auth.expectedBodySha256);
      const credentials = sessions.consume(auth.sessionToken, auth.profile);
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get("limit") ?? "100")));
      return json(response, 200, await listOutbox(account, credentials, limit));
    }

    const outboxMatch = /^\/v1\/sftp\/out\/([^/]+)$/u.exec(url.pathname);
    if (request.method === "GET" && outboxMatch?.[1]) {
      await verifyEmptyBodyHash(request, auth.expectedBodySha256);
      const credentials = sessions.consume(auth.sessionToken, auth.profile);
      const bytes = await downloadOutbox(account, credentials, decodeURIComponent(outboxMatch[1]));
      response.writeHead(200, {
        "content-type": "application/pkcs7-mime",
        "content-length": String(bytes.length),
      });
      return response.end(bytes);
    }
    if (request.method === "DELETE" && outboxMatch?.[1]) {
      await verifyEmptyBodyHash(request, auth.expectedBodySha256);
      const credentials = sessions.consume(auth.sessionToken, auth.profile);
      await deleteOutbox(account, credentials, decodeURIComponent(outboxMatch[1]));
      response.writeHead(204);
      return response.end();
    }

    if (request.method === "POST" && url.pathname === "/v1/gateway/register") {
      const body = await readVerifiedBody(request, auth.expectedBodySha256);
      const credentials = sessions.consume(auth.sessionToken, auth.profile);
      const event = gatewayEventSchema.parse(JSON.parse(body.toString("utf8"))) as GatewayInvoiceEvent;
      assertGatewayEventProtocol(event);
      return json(response, 200, await registerInvoiceEvent(account, credentials, event));
    }

    if (request.method === "POST" && url.pathname === "/v1/gateway/trading-partner") {
      const body = await readVerifiedBody(request, auth.expectedBodySha256);
      const credentials = sessions.consume(auth.sessionToken, auth.profile);
      const input = tradingPartnerSchema.parse(JSON.parse(body.toString("utf8")));
      return json(response, 200, await queryTradingPartner(account, credentials, input));
    }

    if (request.method === "POST" && url.pathname === "/v1/gateway/cross-border") {
      await readVerifiedBody(request, auth.expectedBodySha256, 1024);
      const credentials = sessions.consume(auth.sessionToken, auth.profile);
      return json(response, 200, { sellerIds: await queryCrossBorderSellers(account, credentials) });
    }

    if (request.method === "POST" && url.pathname === "/v1/gateway/version-info") {
      const body = await readVerifiedBody(request, auth.expectedBodySha256, 8 * 1024);
      const credentials = sessions.consume(auth.sessionToken, auth.profile);
      const input = turnkeyVersionSchema.parse(JSON.parse(body.toString("utf8")));
      return json(response, 200, await queryTurnkeyVersionInfo(account, credentials, input));
    }

    if (request.method === "POST" && url.pathname === "/v1/gateway/error-messages") {
      await readVerifiedBody(request, auth.expectedBodySha256, 1024);
      const credentials = sessions.consume(auth.sessionToken, auth.profile);
      return json(response, 200, await queryErrorMessageInfo(account, credentials));
    }

    throw new EgressHttpError(404, "EGRESS_ROUTE_NOT_FOUND", "Route not found");
  } catch (error) {
    const httpError = normalizeError(error);
    console.error(
      JSON.stringify({
        level: "error",
        message: "egress request failed",
        requestId,
        method: request.method,
        path: url.pathname,
        code: httpError.code,
        error: httpError.message,
      }),
    );
    return json(response, httpError.status, {
      code: httpError.code,
      message: httpError.status >= 500 ? "Egress operation failed" : httpError.message,
      requestId,
    });
  }
});

server.listen(config.port, config.host, () => {
  console.log(
    JSON.stringify({
      level: "info",
      message: "Turnkey egress agent listening",
      host: config.host,
      port: config.port,
      profiles: Object.keys(config.accounts),
    }),
  );
});

function getAccount(profile: string): EgressAccount {
  const account = config.accounts[profile];
  if (!account) {
    throw new EgressHttpError(404, "EGRESS_PROFILE_NOT_FOUND", `Unknown egress profile ${profile}`);
  }
  return account;
}

function assertGatewayEventProtocol(event: GatewayInvoiceEvent): void {
  const rule = outboundProtocolRules[event.messageType];
  const expectedService = rule.processType === "EXCHANGE" ? "E" : "S";
  if (event.action !== rule.categoryType || event.serviceType !== expectedService) {
    throw new EgressHttpError(
      400,
      "EGRESS_GATEWAY_PROTOCOL_INVALID",
      `${event.messageType} requires ${expectedService}/${rule.categoryType}`,
    );
  }
  if (rule.processType === "EXCHANGE" && event.quantity !== 1) {
    throw new EgressHttpError(
      400,
      "EGRESS_GATEWAY_PROTOCOL_INVALID",
      `${event.messageType} exchange requires exactly one document`,
    );
  }
}

async function verifyEmptyBodyHash(request: IncomingMessage, expectedSha256: string): Promise<void> {
  await readVerifiedBody(request, expectedSha256, 1);
}

function normalizeError(error: unknown): EgressHttpError {
  if (error instanceof EgressHttpError) {
    return error;
  }
  if (error instanceof z.ZodError) {
    return new EgressHttpError(400, "EGRESS_REQUEST_INVALID", error.issues.map((issue) => issue.message).join("; "));
  }
  return new EgressHttpError(500, "EGRESS_INTERNAL_ERROR", error instanceof Error ? error.message : String(error));
}

function json(response: ServerResponse, status: number, body: unknown): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(Buffer.byteLength(encoded)),
  });
  response.end(encoded);
}

function text(response: ServerResponse, status: number, body: string, contentType: string): void {
  response.writeHead(status, {
    "content-type": contentType,
    "content-length": String(Buffer.byteLength(body)),
  });
  response.end(body);
}
