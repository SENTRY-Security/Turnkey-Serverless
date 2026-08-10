import { webcrypto } from "node:crypto";
import { Buffer } from "node:buffer";
import { beforeAll, describe, expect, it } from "vitest";
import { loadCredentialLease, storeCredentialLease } from "../src/worker/credential-vault.js";

beforeAll(() => {
  if (!globalThis.crypto) {
    Object.defineProperty(globalThis, "crypto", { value: webcrypto });
  }
});

describe("credential vault", () => {
  it("stores only authenticated ciphertext and decrypts it for the same account", async () => {
    const objects = new Map<string, string>();
    const env = {
      CREDENTIAL_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
      TURNKEY_FILES: {
        async put(key: string, value: string) {
          objects.set(key, value);
        },
        async get(key: string) {
          const value = objects.get(key);
          return value === undefined
            ? null
            : {
                async json<T>() {
                  return JSON.parse(value) as T;
                },
              };
        },
      },
    } as unknown as Env;
    const input = {
      transport: { loginId: "mof-user", loginPassword: "secret-transport-password" },
      signing: { format: "PFX" as const, pfxBase64: "c2VjcmV0LXBleC1ieXRlcw==", password: "secret-pfx-password" },
      leaseSeconds: 600,
    };
    const lease = await storeCredentialLease(env, input, "account:tenant/entity", "credentials/lease.json");
    const stored = objects.get(lease.r2Key) ?? "";
    expect(stored).not.toContain(input.transport.loginId);
    expect(stored).not.toContain(input.transport.loginPassword);
    expect(stored).not.toContain(input.signing.pfxBase64);
    await expect(
      loadCredentialLease(env, lease.r2Key, "account:tenant/entity", lease.expiresAt),
    ).resolves.toEqual({ transport: input.transport, signing: input.signing });
    await expect(
      loadCredentialLease(env, lease.r2Key, "account:another", lease.expiresAt),
    ).rejects.toMatchObject({ code: "TW_CREDENTIAL_LEASE_DECRYPT_FAILED" });
  });
});
