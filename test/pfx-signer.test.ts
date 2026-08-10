import { spawnSync } from "node:child_process";
import { Buffer } from "node:buffer";
import forge from "node-forge";
import { describe, expect, it } from "vitest";
import { AdapterError } from "../src/core/index.js";
import { signEnvelopeWithPfx, validatePfxCredential } from "../src/worker/pfx-signer.js";

const password = "PfxPass8";
const pfxBase64 = makeTestPfx(password);

describe("Worker PFX signer", () => {
  it("creates an attached SHA-256 CMS payload that OpenSSL can verify", () => {
    const envelope = '<?xml version="1.0" encoding="UTF-8"?><InvoiceEnvelope>測試</InvoiceEnvelope>';
    const signing = { format: "PFX" as const, pfxBase64, password };
    validatePfxCredential(signing);
    const signed = signEnvelopeWithPfx(envelope, signing);
    const verification = spawnSync(
      "openssl",
      ["cms", "-verify", "-binary", "-inform", "DER", "-noverify", "-in", "/dev/stdin", "-out", "/dev/stdout"],
      { input: Buffer.from(signed, "base64") },
    );
    expect(verification.status, verification.stderr.toString()).toBe(0);
    expect(verification.stdout.toString("utf8")).toBe(envelope);
    const structure = spawnSync("openssl", ["cms", "-cmsout", "-print", "-inform", "DER"], {
      input: Buffer.from(signed, "base64"),
    });
    expect(structure.status, structure.stderr.toString()).toBe(0);
    expect(structure.stdout.toString("utf8")).toContain("sha256WithRSAEncryption (1.2.840.113549.1.1.11)");
  });

  it("does not accept an incorrect PFX password", () => {
    expect(() => validatePfxCredential({ format: "PFX", pfxBase64, password: "wrong-pass" })).toThrowError(
      expect.objectContaining<Partial<AdapterError>>({ code: "TW_PFX_INVALID" }),
    );
  });
});

function makeTestPfx(pfxPassword: string): string {
  const keys = forge.pki.rsa.generateKeyPair(1024);
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = "01";
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const attributes = [{ name: "commonName", value: "Turnkey Worker Test" }];
  certificate.setSubject(attributes);
  certificate.setIssuer(attributes);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  const p12 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [certificate], pfxPassword, {
    algorithm: "3des",
  });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary").toString("base64");
}
