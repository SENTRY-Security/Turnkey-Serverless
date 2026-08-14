import { Buffer } from "node:buffer";
import forge from "node-forge";
import { describe, expect, it } from "vitest";
import { validatePfxCredential } from "../src/worker/pfx-signer.js";
import {
  TURNKEY_RSA_BITS,
  assemblePfx,
  generateCertificateRequest,
  inspectKeyStore,
  inspectPfx,
  validateOfficialPfxPassword,
} from "../tools/pfx/lib.js";

const ban = "12345678";
const password = "PfxPass8";

describe("Turnkey 3.2.1-compatible PFX offline tool", () => {
  it("generates the Turnkey PKCS#12 KEY container and exact CSR semantics", () => {
    const artifacts = generateCertificateRequest({ ban, password });
    const keySummary = inspectKeyStore(artifacts.keyStoreBytes, password);

    expect(artifacts.rsaBits).toBe(TURNKEY_RSA_BITS);
    expect(keySummary.alias).toBe(ban);
    expect(keySummary.rsaBits).toBe(2_048);
    expect(keySummary.placeholderCertificate.subject).toBe(`CN=${ban}`);
    expect(keySummary.placeholderCertificate.issuer).toBe(`CN=${ban}`);

    const csr = forge.pki.certificationRequestFromPem(artifacts.csrPem);
    expect(csr.verify()).toBe(true);
    expect(csr.subject.attributes).toHaveLength(1);
    expect(csr.subject.getField("CN").value).toBe(ban);
    expect(csr.signatureOid).toBe(forge.pki.oids.sha256WithRSAEncryption);
    expect(rsaCsrKeyBits(csr)).toBe(2_048);

    const extensionRequest = csr.getAttribute({ name: "extensionRequest" });
    expect(extensionRequest?.type).toBe("1.2.840.113549.1.9.14");
    expect(extensionRequest?.extensions).toHaveLength(1);
    expect(extensionRequest?.extensions?.[0]).toMatchObject({
      name: "keyUsage",
      digitalSignature: true,
    });
  });

  it("replaces the placeholder certificate with a matching CA CER and emits Worker-compatible PFX", () => {
    const request = generateCertificateRequest({ ban, password });
    const privateKey = privateKeyFromPkcs12(request.keyStoreBytes, password);
    const certificate = makeCertificate(privateKey, ban);
    const assembled = assemblePfx({
      keyStoreBytes: request.keyStoreBytes,
      certificateBytes: Buffer.from(forge.pki.certificateToPem(certificate), "utf8"),
      password,
    });

    expect(assembled.summary.alias).toBe(ban);
    expect(assembled.summary.rsaBits).toBe(2_048);
    expect(assembled.summary.privateKeyMatchesCertificate).toBe(true);
    expect(assembled.summary.certificateCount).toBe(1);
    expect(assembled.summary.certificate.subject).toContain(`CN=${ban}`);
    expect(inspectPfx(assembled.pfxBytes, password)).toEqual(assembled.summary);
    expect(() =>
      validatePfxCredential({
        format: "PFX",
        pfxBase64: Buffer.from(assembled.pfxBytes).toString("base64"),
        password,
      }),
    ).not.toThrow();
  });

  it("rejects a CER issued for a different private key", () => {
    const request = generateCertificateRequest({ ban, password });
    const otherKey = forge.pki.rsa.generateKeyPair(2_048).privateKey;
    const unrelatedCertificate = makeCertificate(otherKey, "87654321");

    expect(() =>
      assemblePfx({
        keyStoreBytes: request.keyStoreBytes,
        certificateBytes: Buffer.from(forge.pki.certificateToPem(unrelatedCertificate), "utf8"),
        password,
      }),
    ).toThrow("不相符");
  });

  it("rejects a wrong KEY password", () => {
    const request = generateCertificateRequest({ ban, password });
    expect(() => inspectKeyStore(request.keyStoreBytes, "Wrong123")).toThrow("無法用提供的密碼開啟 KEY");
  });

  it("enforces the Turnkey eight-character alphanumeric password rule", () => {
    expect(() => validateOfficialPfxPassword("Abcd1234")).not.toThrow();
    expect(() => validateOfficialPfxPassword("too-short")).toThrow("8");
    expect(() => validateOfficialPfxPassword("Abcd!234")).toThrow("8");
    expect(() => validateOfficialPfxPassword("Ａbcd1234")).toThrow("8");
  });
});

function privateKeyFromPkcs12(bytes: Uint8Array, passwordValue: string): forge.pki.rsa.PrivateKey {
  const asn1 = forge.asn1.fromDer(Buffer.from(bytes).toString("binary"));
  const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, passwordValue);
  const bagType = forge.pki.oids.pkcs8ShroudedKeyBag;
  if (!bagType) {
    throw new Error("node-forge pkcs8ShroudedKeyBag OID missing");
  }
  const key = p12.getBags({ bagType })[bagType]?.[0]?.key;
  if (!key) {
    throw new Error("test KEY does not contain a private key");
  }
  return key;
}

function rsaCsrKeyBits(csr: forge.pki.CertificateSigningRequest): number {
  const publicKey = csr.publicKey;
  if (publicKey === null || !("n" in publicKey)) {
    throw new Error("test CSR does not contain an RSA public key");
  }
  return publicKey.n.bitLength();
}

function makeCertificate(privateKey: forge.pki.rsa.PrivateKey, commonName: string): forge.pki.Certificate {
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = forge.pki.rsa.setPublicKey(privateKey.n, privateKey.e);
  certificate.serialNumber = "01";
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + 24 * 60 * 60 * 1000);
  const attributes = [
    { name: "countryName", value: "TW" },
    { name: "commonName", value: commonName },
  ];
  certificate.setSubject(attributes);
  certificate.setIssuer(attributes);
  certificate.sign(privateKey, forge.md.sha256.create());
  return certificate;
}
