import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/egress/config.js";

const account = {
  environment: "TEST",
  sftp: {
    host: "tsftp.einvoice.nat.gov.tw",
    port: 2222,
    hostKeySha256: "SHA256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    inbox: "in",
    outbox: "out",
  },
  gateway: {
    baseUrl: "https://tgw.einvoice.nat.gov.tw/gateway/api",
    timeoutMs: 60_000,
  },
  crossBorderSellerIds: [],
};

describe("egress configuration", () => {
  it("accepts an OpenSSH SHA-256 host-key fingerprint", () => {
    expect(
      loadConfig({
        ...process.env,
        EGRESS_HMAC_SECRET: "a-secret-longer-than-twenty-four-characters",
        TURNKEY_ACCOUNTS_JSON: JSON.stringify({ test: account }),
      }).accounts.test?.sftp.hostKeySha256,
    ).toBe(account.sftp.hostKeySha256);
  });

  it("refuses a host-key placeholder", () => {
    expect(() =>
      loadConfig({
        ...process.env,
        EGRESS_HMAC_SECRET: "a-secret-longer-than-twenty-four-characters",
        TURNKEY_ACCOUNTS_JSON: JSON.stringify({
          test: {
            ...account,
            sftp: { ...account.sftp, hostKeySha256: "SHA256:REPLACE_WITH_PINNED_HOST_KEY" },
          },
        }),
      }),
    ).toThrow();
  });
});
