import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;
const usedNonces = new Map<string, number>();

export interface AuthenticatedRequest {
  profile: string;
  sessionToken: string;
  expectedBodySha256: string;
}

export function authenticateRequest(
  request: IncomingMessage,
  pathnameWithSearch: string,
  secret: string,
): AuthenticatedRequest {
  const profile = requiredHeader(request, "x-turnkey-profile");
  const sessionToken = optionalHeader(request, "x-turnkey-session");
  const timestamp = requiredHeader(request, "x-turnkey-timestamp");
  const nonce = requiredHeader(request, "x-turnkey-nonce");
  const bodySha256 = requiredHeader(request, "x-turnkey-content-sha256");
  const suppliedSignature = requiredHeader(request, "x-turnkey-signature");
  const timestampNumber = Number(timestamp);
  if (!Number.isFinite(timestampNumber) || Math.abs(Date.now() - timestampNumber) > MAX_CLOCK_SKEW_MS) {
    throw new EgressHttpError(401, "EGRESS_AUTH_EXPIRED", "Request timestamp is outside the allowed window");
  }

  evictExpiredNonces();
  if (usedNonces.has(nonce)) {
    throw new EgressHttpError(409, "EGRESS_AUTH_REPLAY", "Request nonce has already been used");
  }

  const method = request.method ?? "GET";
  const canonical = [method, pathnameWithSearch, profile, sessionToken, timestamp, nonce, bodySha256].join("\n");
  const expectedSignature = createHmac("sha256", secret).update(canonical).digest("base64url");
  const supplied = Buffer.from(suppliedSignature, "utf8");
  const expected = Buffer.from(expectedSignature, "utf8");
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new EgressHttpError(401, "EGRESS_AUTH_INVALID", "Request signature is invalid");
  }
  usedNonces.set(nonce, timestampNumber);
  return { profile, sessionToken, expectedBodySha256: bodySha256.toLowerCase() };
}

function optionalHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return typeof value === "string" ? value : "";
}

export async function readVerifiedBody(
  request: IncomingMessage,
  expectedSha256: string,
  maxBytes = 22 * 1024 * 1024,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const hash = createHash("sha256");
  let total = 0;
  for await (const chunk of request) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) {
      throw new EgressHttpError(413, "EGRESS_BODY_TOO_LARGE", `Request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(bytes);
    hash.update(bytes);
  }
  const actual = hash.digest("hex");
  if (actual !== expectedSha256) {
    throw new EgressHttpError(400, "EGRESS_BODY_HASH_MISMATCH", "Request body SHA-256 does not match the signed header");
  }
  return Buffer.concat(chunks, total);
}

function requiredHeader(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  if (typeof value !== "string" || !value) {
    throw new EgressHttpError(401, "EGRESS_AUTH_MISSING", `Missing ${name}`);
  }
  return value;
}

function evictExpiredNonces(): void {
  const cutoff = Date.now() - MAX_CLOCK_SKEW_MS;
  for (const [nonce, timestamp] of usedNonces) {
    if (timestamp < cutoff) {
      usedNonces.delete(nonce);
    }
  }
}

export class EgressHttpError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EgressHttpError";
    this.status = status;
    this.code = code;
  }
}
