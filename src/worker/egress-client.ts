import type {
  EgressGatewayResult,
  EgressRemoteFile,
  EgressUploadResult,
  EgressValidationResult,
  GatewayInvoiceEvent,
  MessageType,
  TurnkeyCredentialBundle,
} from "../core/index.js";
import { AdapterError } from "../core/index.js";
import { hmacSha256Base64, sha256Hex } from "./crypto.js";

interface EgressRequestOptions {
  method?: "GET" | "POST" | "DELETE";
  profile: string;
  sessionToken?: string;
  body?: string | ArrayBuffer;
  bodySha256?: string;
  contentType?: string;
}

interface EgressSession {
  token: string;
  expiresAt: string;
}

export async function getEgressProfile(
  env: Env,
  profile: string,
): Promise<{ environment: "TEST" | "PRODUCTION" }> {
  return jsonResponse<{ environment: "TEST" | "PRODUCTION" }>(
    await egressFetch(env, "/v1/profile", { method: "GET", profile }),
  );
}

async function egressFetch(env: Env, path: string, options: EgressRequestOptions): Promise<Response> {
  const method = options.method ?? "GET";
  const timestamp = String(Date.now());
  const nonce = crypto.randomUUID();
  const sessionToken = options.sessionToken ?? "";
  const bodyHash = options.bodySha256 ?? (options.body === undefined ? await sha256Hex("") : await sha256Hex(options.body));
  const canonical = [method, path, options.profile, sessionToken, timestamp, nonce, bodyHash].join("\n");
  const signature = await hmacSha256Base64(env.EGRESS_HMAC_SECRET, canonical);
  const headers = new Headers({
    "x-turnkey-profile": options.profile,
    "x-turnkey-timestamp": timestamp,
    "x-turnkey-nonce": nonce,
    "x-turnkey-content-sha256": bodyHash,
    "x-turnkey-signature": signature,
  });
  if (sessionToken) {
    headers.set("x-turnkey-session", sessionToken);
  }
  if (options.contentType) {
    headers.set("content-type", options.contentType);
  }
  const requestInit: RequestInit = {
    method,
    headers,
    ...(options.body === undefined ? {} : { body: options.body }),
  };
  const response = await fetch(new URL(path, env.EGRESS_BASE_URL), requestInit);
  if (!response.ok) {
    const message = await response.text();
    throw new AdapterError("TW_EGRESS_REQUEST_FAILED", `Egress ${method} ${path} failed: ${response.status} ${message}`, {
      retryable: response.status >= 500 || response.status === 429,
    });
  }
  return response;
}

async function jsonResponse<T>(response: Response): Promise<T> {
  return response.json<T>();
}

async function createEgressSession(
  env: Env,
  profile: string,
  credentials: TurnkeyCredentialBundle["transport"],
): Promise<EgressSession> {
  const body = JSON.stringify({
    loginId: credentials.loginId,
    loginPassword: credentials.loginPassword,
    ttlSeconds: Number(env.EGRESS_SESSION_TTL_SECONDS),
  });
  return jsonResponse<EgressSession>(
    await egressFetch(env, "/v1/sessions", {
      method: "POST",
      profile,
      body,
      contentType: "application/json",
    }),
  );
}

async function credentialedFetch(
  env: Env,
  path: string,
  credentials: TurnkeyCredentialBundle["transport"],
  options: Omit<EgressRequestOptions, "sessionToken">,
): Promise<Response> {
  const session = await createEgressSession(env, options.profile, credentials);
  return egressFetch(env, path, { ...options, sessionToken: session.token });
}

export async function validateDocuments(
  env: Env,
  profile: string,
  messageType: MessageType,
  documents: string[],
  crossBorderSellerIds: string[] = [],
): Promise<EgressValidationResult> {
  const body = JSON.stringify({ schema: `v41/${messageType}`, documents, crossBorderSellerIds });
  return jsonResponse<EgressValidationResult>(
    await egressFetch(env, "/v1/xml/validate", {
      method: "POST",
      profile,
      body,
      contentType: "application/json",
    }),
  );
}

export async function queryCrossBorderSellers(
  env: Env,
  profile: string,
  credentials: TurnkeyCredentialBundle["transport"],
): Promise<string[]> {
  const body = "{}";
  const result = await jsonResponse<{ sellerIds: string[] }>(
    await credentialedFetch(env, "/v1/gateway/cross-border", credentials, {
      method: "POST",
      profile,
      body,
      contentType: "application/json",
    }),
  );
  return result.sellerIds;
}

export async function queryTurnkeyVersionInfo(
  env: Env,
  profile: string,
  credentials: TurnkeyCredentialBundle["transport"],
  input: {
    turnkeyVersion: string;
    apiVersion: string;
    compId: string;
    dbType: string;
    osType: string;
    jreVersion: string;
    tkyType: string;
  },
): Promise<Record<string, unknown>> {
  const body = JSON.stringify(input);
  return jsonResponse<Record<string, unknown>>(
    await credentialedFetch(env, "/v1/gateway/version-info", credentials, {
      method: "POST",
      profile,
      body,
      contentType: "application/json",
    }),
  );
}

export async function queryGatewayErrorMessages(
  env: Env,
  profile: string,
  credentials: TurnkeyCredentialBundle["transport"],
): Promise<Record<string, unknown>> {
  const body = "{}";
  return jsonResponse<Record<string, unknown>>(
    await credentialedFetch(env, "/v1/gateway/error-messages", credentials, {
      method: "POST",
      profile,
      body,
      contentType: "application/json",
    }),
  );
}

export async function validateEnvelope(env: Env, profile: string, envelope: string): Promise<void> {
  await validateXmlDocuments(env, profile, "common/v41/InvoiceEnvelope", [envelope]);
}

export async function validateXmlDocuments(
  env: Env,
  profile: string,
  schema: string,
  documents: string[],
): Promise<void> {
  const body = JSON.stringify({ schema, documents });
  const result = await jsonResponse<EgressValidationResult>(
    await egressFetch(env, "/v1/xml/validate", {
      method: "POST",
      profile,
      body,
      contentType: "application/json",
    }),
  );
  if (!result.valid) {
    throw new AdapterError(
      schema === "common/v41/InvoiceEnvelope" ? "TW_ENVELOPE_XSD_INVALID" : "TW_XSD_VALIDATION_FAILED",
      result.errors.map((error) => `#${error.index + 1}: ${error.message}`).join("; ") || `${schema} failed XSD validation`,
    );
  }
}

export async function uploadSignedFile(
  env: Env,
  profile: string,
  credentials: TurnkeyCredentialBundle["transport"],
  filename: string,
  signed: string,
  signedSha256: string,
): Promise<EgressUploadResult> {
  const path = `/v1/sftp/in/${encodeURIComponent(filename)}`;
  return jsonResponse<EgressUploadResult>(
    await credentialedFetch(env, path, credentials, {
      method: "POST",
      profile,
      body: signed,
      bodySha256: signedSha256,
      contentType: "application/pkcs7-mime",
    }),
  );
}

export async function registerGatewayEvent(
  env: Env,
  profile: string,
  credentials: TurnkeyCredentialBundle["transport"],
  event: GatewayInvoiceEvent,
): Promise<EgressGatewayResult> {
  const body = JSON.stringify(event);
  return jsonResponse<EgressGatewayResult>(
    await credentialedFetch(env, "/v1/gateway/register", credentials, {
      method: "POST",
      profile,
      body,
      contentType: "application/json",
    }),
  );
}

export interface TradingPartnerRoute {
  routingId: string;
  description: string;
}

export async function queryTradingPartner(
  env: Env,
  profile: string,
  credentials: TurnkeyCredentialBundle["transport"],
  partyId: string,
): Promise<TradingPartnerRoute> {
  const body = JSON.stringify({ partyId, partnerType: "1" });
  return jsonResponse<TradingPartnerRoute>(
    await credentialedFetch(env, "/v1/gateway/trading-partner", credentials, {
      method: "POST",
      profile,
      body,
      contentType: "application/json",
    }),
  );
}

export async function listOutboundResults(
  env: Env,
  profile: string,
  credentials: TurnkeyCredentialBundle["transport"],
): Promise<EgressRemoteFile[]> {
  return jsonResponse<EgressRemoteFile[]>(
    await credentialedFetch(env, "/v1/sftp/out?limit=100", credentials, { method: "GET", profile }),
  );
}

export async function downloadOutboundResult(
  env: Env,
  profile: string,
  credentials: TurnkeyCredentialBundle["transport"],
  filename: string,
): Promise<ArrayBuffer> {
  const response = await credentialedFetch(
    env,
    `/v1/sftp/out/${encodeURIComponent(filename)}`,
    credentials,
    { method: "GET", profile },
  );
  return response.arrayBuffer();
}

export async function verifySignedResult(env: Env, profile: string, signed: ArrayBuffer): Promise<string> {
  const response = await egressFetch(env, "/v1/signatures/verify", {
    method: "POST",
    profile,
    body: signed,
    contentType: "application/pkcs7-mime",
  });
  return response.text();
}

export async function decryptE0504Result(
  env: Env,
  profile: string,
  filename: string,
  encrypted: ArrayBuffer,
): Promise<Array<{ filename: string; xml: string }>> {
  const path = `/v1/e0504/decrypt?filename=${encodeURIComponent(filename)}`;
  const response = await egressFetch(env, path, {
    method: "POST",
    profile,
    body: encrypted,
    contentType: "application/octet-stream",
  });
  const result = await jsonResponse<{ documents: Array<{ filename: string; xml: string }> }>(response);
  return result.documents;
}

export async function deleteOutboundResult(
  env: Env,
  profile: string,
  credentials: TurnkeyCredentialBundle["transport"],
  filename: string,
): Promise<void> {
  await credentialedFetch(env, `/v1/sftp/out/${encodeURIComponent(filename)}`, credentials, {
    method: "DELETE",
    profile,
  });
}
