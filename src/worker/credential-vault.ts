import { Buffer } from "node:buffer";
import { AdapterError, type TurnkeyCredentialBundle, type TurnkeyCredentialLeaseInput } from "../core/index.js";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

interface SealedCredentialLease {
  version: 1;
  algorithm: "A256GCM";
  iv: string;
  ciphertext: string;
  expiresAt: string;
}

export interface StoredCredentialLease {
  r2Key: string;
  expiresAt: string;
}

export async function storeCredentialLease(
  env: Env,
  input: TurnkeyCredentialLeaseInput,
  context: string,
  r2Key: string,
): Promise<StoredCredentialLease> {
  const expiresAt = new Date(Date.now() + input.leaseSeconds * 1000).toISOString();
  const bundle: TurnkeyCredentialBundle = {
    transport: input.transport,
    signing: input.signing,
  };
  const sealed = await seal(bundle, env.CREDENTIAL_ENCRYPTION_KEY, context, expiresAt);
  await env.TURNKEY_FILES.put(r2Key, JSON.stringify(sealed), {
    httpMetadata: { contentType: "application/vnd.tw-turnkey.credential-lease+json" },
    customMetadata: { expiresAt, context },
  });
  return { r2Key, expiresAt };
}

export async function loadCredentialLease(
  env: Env,
  r2Key: string,
  context: string,
  expectedExpiresAt: string,
): Promise<TurnkeyCredentialBundle> {
  if (Date.parse(expectedExpiresAt) <= Date.now()) {
    throw new AdapterError("TW_CREDENTIAL_LEASE_EXPIRED", "Turnkey credential lease has expired");
  }
  const object = await env.TURNKEY_FILES.get(r2Key);
  if (!object) {
    throw new AdapterError("TW_CREDENTIAL_LEASE_MISSING", "Encrypted Turnkey credential lease is missing", {
      retryable: true,
    });
  }
  const sealed = await object.json<SealedCredentialLease>();
  if (sealed.expiresAt !== expectedExpiresAt) {
    throw new AdapterError("TW_CREDENTIAL_LEASE_MISMATCH", "Credential lease metadata does not match D1");
  }
  return open(sealed, env.CREDENTIAL_ENCRYPTION_KEY, context);
}

async function seal(
  bundle: TurnkeyCredentialBundle,
  encodedKey: string,
  context: string,
  expiresAt: string,
): Promise<SealedCredentialLease> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await importEncryptionKey(encodedKey, ["encrypt"]);
  const plaintext = encoder.encode(JSON.stringify(bundle));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(authenticatedContext(context, expiresAt)) },
    key,
    plaintext,
  );
  plaintext.fill(0);
  return {
    version: 1,
    algorithm: "A256GCM",
    iv: Buffer.from(iv).toString("base64url"),
    ciphertext: Buffer.from(ciphertext).toString("base64url"),
    expiresAt,
  };
}

async function open(
  sealed: SealedCredentialLease,
  encodedKey: string,
  context: string,
): Promise<TurnkeyCredentialBundle> {
  if (sealed.version !== 1 || sealed.algorithm !== "A256GCM") {
    throw new AdapterError("TW_CREDENTIAL_LEASE_FORMAT_INVALID", "Unsupported credential lease format");
  }
  if (Date.parse(sealed.expiresAt) <= Date.now()) {
    throw new AdapterError("TW_CREDENTIAL_LEASE_EXPIRED", "Turnkey credential lease has expired");
  }
  try {
    const key = await importEncryptionKey(encodedKey, ["decrypt"]);
    const plaintext = new Uint8Array(await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: Buffer.from(sealed.iv, "base64url"),
        additionalData: encoder.encode(authenticatedContext(context, sealed.expiresAt)),
      },
      key,
      Buffer.from(sealed.ciphertext, "base64url"),
    ));
    try {
      return JSON.parse(decoder.decode(plaintext)) as TurnkeyCredentialBundle;
    } finally {
      plaintext.fill(0);
    }
  } catch (error) {
    throw new AdapterError("TW_CREDENTIAL_LEASE_DECRYPT_FAILED", "Could not decrypt the Turnkey credential lease", {
      cause: error,
    });
  }
}

async function importEncryptionKey(encoded: string, usages: KeyUsage[]): Promise<CryptoKey> {
  const normalized = encoded.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/u.test(normalized)) {
    throw new AdapterError(
      "TW_CREDENTIAL_KEY_INVALID",
      "CREDENTIAL_ENCRYPTION_KEY must be Base64 encoding of exactly 32 random bytes",
    );
  }
  const bytes = Buffer.from(normalized, "base64");
  return crypto.subtle.importKey("raw", bytes, "AES-GCM", false, usages);
}

function authenticatedContext(context: string, expiresAt: string): string {
  return `tw-turnkey-credential-lease\n${context}\n${expiresAt}`;
}
