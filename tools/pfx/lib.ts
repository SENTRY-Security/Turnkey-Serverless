import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import forge from "node-forge";

const OFFICIAL_PASSWORD_PATTERN = /^[A-Za-z0-9]{8}$/u;
const RSA_PUBLIC_EXPONENT = 0x10001;

/** Turnkey 3.2.1 PFXBuilder.CKM_RSA_PKCS_KEY_PAIR_GEN default. */
export const TURNKEY_RSA_BITS = 2_048;
const TURNKEY_PKCS12_ITERATIONS = 1_024;
const TURNKEY_PKCS12_SALT_BYTES = 20;

export interface CertificateRequestOptions {
  ban: string;
  password: string;
}

export interface CertificateRequestArtifacts {
  /** Password-protected PKCS#12 KeyStore. Turnkey names this binary file *.key. */
  keyStoreBytes: Uint8Array;
  csrPem: string;
  ban: string;
  rsaBits: typeof TURNKEY_RSA_BITS;
  csrSha256: string;
  keyStoreSha256: string;
}

export interface AssemblePfxOptions {
  keyStoreBytes: Uint8Array;
  certificateBytes: Uint8Array;
  chainCertificateBytes?: Uint8Array[];
  password: string;
}

export interface CertificateSummary {
  subject: string;
  issuer: string;
  serialNumber: string;
  notBefore: string;
  notAfter: string;
  sha256Fingerprint: string;
}

export interface KeyStoreSummary {
  alias: string;
  rsaBits: number;
  placeholderCertificate: CertificateSummary;
  privateKeyMatchesCertificate: true;
}

export interface PfxSummary {
  alias: string;
  certificate: CertificateSummary;
  certificateCount: number;
  rsaBits: number;
  privateKeyMatchesCertificate: true;
}

export interface AssembledPfx {
  pfxBytes: Uint8Array;
  summary: PfxSummary;
}

interface Pkcs12Material {
  alias: string;
  privateKey: forge.pki.rsa.PrivateKey;
  signerCertificate: forge.pki.Certificate;
  certificates: forge.pki.Certificate[];
}

export function validateOfficialPfxPassword(password: string): void {
  if (!OFFICIAL_PASSWORD_PATTERN.test(password)) {
    throw new Error("KEY/PFX 密碼必須恰好為 8 個 ASCII 英文字母或數字");
  }
}

export function validateBan(ban: string): void {
  if (!/^\d{8}$/u.test(ban)) {
    throw new Error("統一編號（BAN）必須恰好為 8 位數字");
  }
}

/**
 * Reimplements Turnkey 3.2.1's Step 1 and Step 2 semantics:
 *
 * - RSA-2048 / exponent 65537;
 * - a password-protected PKCS#12 KeyStore stored with the *.key extension;
 * - alias and temporary self-signed certificate subject CN equal to the BAN;
 * - PKCS#10 subject containing only CN=<BAN>;
 * - extensionRequest -> keyUsage: digitalSignature;
 * - SHA256withRSA CSR signature.
 *
 * The PKCS#12 bytes cannot be byte-identical to a Java/Bouncy Castle run because
 * salts, the key pair, serial number and timestamps are intentionally random.
 */
export function generateCertificateRequest(options: CertificateRequestOptions): CertificateRequestArtifacts {
  validateBan(options.ban);
  validateOfficialPfxPassword(options.password);

  const keys = forge.pki.rsa.generateKeyPair({ bits: TURNKEY_RSA_BITS, e: RSA_PUBLIC_EXPONENT });
  const placeholderCertificate = makeTurnkeyPlaceholderCertificate(keys, options.ban);
  const keyStoreBytes = encodePkcs12(
    keys.privateKey,
    [placeholderCertificate],
    options.password,
    options.ban,
  );

  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = keys.publicKey;
  csr.setSubject([{ name: "commonName", value: options.ban }]);
  csr.setAttributes([
    {
      name: "extensionRequest",
      extensions: [{ name: "keyUsage", digitalSignature: true }],
    },
  ]);
  csr.sign(keys.privateKey, forge.md.sha256.create());
  if (!csr.verify()) {
    throw new Error("產生的 Turnkey CSR 簽章驗證失敗");
  }

  const csrPem = forge.pki.certificationRequestToPem(csr);
  return {
    keyStoreBytes,
    csrPem,
    ban: options.ban,
    rsaBits: TURNKEY_RSA_BITS,
    csrSha256: sha256Hex(Buffer.from(csrPem, "utf8")),
    keyStoreSha256: sha256Hex(keyStoreBytes),
  };
}

/** Turnkey Step 3: replace the temporary self-signed certificate with the CA CER. */
export function assemblePfx(options: AssemblePfxOptions): AssembledPfx {
  validateOfficialPfxPassword(options.password);
  const keyStore = readPkcs12(options.keyStoreBytes, options.password, "KEY");
  const signerCertificate = parseCertificate(options.certificateBytes);
  assertRsaKeyMatchesCertificate(keyStore.privateKey, signerCertificate);

  const certificates = deduplicateCertificates([
    signerCertificate,
    ...(options.chainCertificateBytes ?? []).map((value) => parseCertificate(value)),
  ]);
  const pfxBytes = encodePkcs12(
    keyStore.privateKey,
    certificates,
    options.password,
    keyStore.alias,
  );

  // Re-open the exact bytes that will be written. This catches PKCS#12 assembly
  // problems before the operator imports the PFX into Finance.
  return { pfxBytes, summary: inspectPfx(pfxBytes, options.password) };
}

export function inspectKeyStore(keyStoreBytes: Uint8Array, password: string): KeyStoreSummary {
  validateOfficialPfxPassword(password);
  const material = readPkcs12(keyStoreBytes, password, "KEY");
  return {
    alias: material.alias,
    rsaBits: material.privateKey.n.bitLength(),
    placeholderCertificate: summarizeCertificate(material.signerCertificate),
    privateKeyMatchesCertificate: true,
  };
}

export function inspectPfx(pfxBytes: Uint8Array, password: string): PfxSummary {
  const material = readPkcs12(pfxBytes, password, "PFX");
  return {
    alias: material.alias,
    certificate: summarizeCertificate(material.signerCertificate),
    certificateCount: material.certificates.length,
    rsaBits: material.privateKey.n.bitLength(),
    privateKeyMatchesCertificate: true,
  };
}

export function summarizeCertificate(certificate: forge.pki.Certificate): CertificateSummary {
  return {
    subject: distinguishedName(certificate.subject.attributes),
    issuer: distinguishedName(certificate.issuer.attributes),
    serialNumber: certificate.serialNumber,
    notBefore: certificate.validity.notBefore.toISOString(),
    notAfter: certificate.validity.notAfter.toISOString(),
    sha256Fingerprint: certificateFingerprint(certificate),
  };
}

function makeTurnkeyPlaceholderCertificate(
  keys: forge.pki.rsa.KeyPair,
  ban: string,
): forge.pki.Certificate {
  const certificate = forge.pki.createCertificate();
  certificate.publicKey = keys.publicKey;
  certificate.serialNumber = randomPositiveSerialNumber();
  certificate.validity.notBefore = new Date();
  certificate.validity.notAfter = new Date(certificate.validity.notBefore);
  certificate.validity.notAfter.setUTCFullYear(certificate.validity.notAfter.getUTCFullYear() + 1);
  const subject = [{ name: "commonName", value: ban }];
  certificate.setSubject(subject);
  certificate.setIssuer(subject);
  certificate.sign(keys.privateKey, forge.md.sha256.create());
  return certificate;
}

function encodePkcs12(
  privateKey: forge.pki.rsa.PrivateKey,
  certificates: forge.pki.Certificate[],
  password: string,
  alias: string,
): Uint8Array {
  const p12 = forge.pkcs12.toPkcs12Asn1(privateKey, certificates, password, {
    algorithm: "3des",
    count: TURNKEY_PKCS12_ITERATIONS,
    saltSize: TURNKEY_PKCS12_SALT_BYTES,
    useMac: true,
    friendlyName: alias,
    generateLocalKeyId: true,
  });
  return Buffer.from(forge.asn1.toDer(p12).getBytes(), "binary");
}

function parseCertificate(certificateBytes: Uint8Array): forge.pki.Certificate {
  try {
    const buffer = Buffer.from(certificateBytes);
    const text = buffer.toString("utf8").replace(/^\uFEFF/u, "").trim();
    if (text.includes("-----BEGIN CERTIFICATE-----")) {
      return forge.pki.certificateFromPem(text);
    }
    const asn1 = forge.asn1.fromDer(buffer.toString("binary"));
    return forge.pki.certificateFromAsn1(asn1);
  } catch (error) {
    throw new Error("CER 必須是 PEM/Base-64 或 DER 格式的 X.509 憑證", { cause: error });
  }
}

function readPkcs12(bytes: Uint8Array, password: string, label: "KEY" | "PFX"): Pkcs12Material {
  try {
    const buffer = Buffer.from(bytes);
    if (buffer.byteLength === 0) {
      throw new Error(`${label} is empty`);
    }
    const p12Asn1 = forge.asn1.fromDer(buffer.toString("binary"));
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);
    const pkcs8BagOid = requiredOid("pkcs8ShroudedKeyBag");
    const keyBagOid = requiredOid("keyBag");
    const certBagOid = requiredOid("certBag");
    const keyBags = [
      ...(p12.getBags({ bagType: pkcs8BagOid })[pkcs8BagOid] ?? []),
      ...(p12.getBags({ bagType: keyBagOid })[keyBagOid] ?? []),
    ];
    const certificateBags = p12.getBags({ bagType: certBagOid })[certBagOid] ?? [];
    const certificates = certificateBags.flatMap((bag) => (bag.cert ? [bag.cert] : []));
    const privateKeyBags = keyBags.filter(
      (bag): bag is forge.pkcs12.Bag & { key: forge.pki.rsa.PrivateKey } => bag.key !== undefined,
    );
    for (const keyBag of privateKeyBags) {
      const matchingBag = certificateBags.find(
        (bag): bag is forge.pkcs12.Bag & { cert: forge.pki.Certificate } =>
          bag.cert !== undefined && keysMatch(keyBag.key, bag.cert),
      );
      if (!matchingBag) {
        continue;
      }
      const alias =
        firstBagAttribute(keyBag, "friendlyName") ??
        firstBagAttribute(matchingBag, "friendlyName") ??
        commonName(matchingBag.cert) ??
        "Turnkey software certificate";
      return {
        alias,
        privateKey: keyBag.key,
        signerCertificate: matchingBag.cert,
        certificates,
      };
    }
    throw new Error(`${label} does not contain a matching RSA private key and certificate`);
  } catch (error) {
    throw new Error(`無法用提供的密碼開啟 ${label}，或 ${label} 缺少相符的 RSA key/certificate`, {
      cause: error,
    });
  }
}

function firstBagAttribute(bag: forge.pkcs12.Bag, name: string): string | undefined {
  const values = bag.attributes?.[name];
  const first = Array.isArray(values) ? values[0] : undefined;
  return typeof first === "string" && first.length > 0 ? first : undefined;
}

function assertRsaKeyMatchesCertificate(
  privateKey: forge.pki.rsa.PrivateKey,
  certificate: forge.pki.Certificate,
): void {
  if (!keysMatch(privateKey, certificate)) {
    throw new Error("CER 的 public key 與 KEY 檔的 private key 不相符；不可組成 PFX");
  }
}

function keysMatch(privateKey: forge.pki.rsa.PrivateKey, certificate: forge.pki.Certificate): boolean {
  const publicKey = rsaPublicKey(certificate);
  return publicKey.n.compareTo(privateKey.n) === 0 && publicKey.e.compareTo(privateKey.e) === 0;
}

function rsaPublicKey(certificate: forge.pki.Certificate): forge.pki.rsa.PublicKey {
  const publicKey = certificate.publicKey;
  if (
    typeof publicKey !== "object" ||
    publicKey === null ||
    !("n" in publicKey) ||
    !("e" in publicKey)
  ) {
    throw new Error("CER 必須包含 RSA public key；目前 Worker 不支援 EC/EdDSA PFX");
  }
  return publicKey;
}

function deduplicateCertificates(certificates: forge.pki.Certificate[]): forge.pki.Certificate[] {
  const seen = new Set<string>();
  return certificates.filter((certificate) => {
    const fingerprint = certificateFingerprint(certificate);
    if (seen.has(fingerprint)) {
      return false;
    }
    seen.add(fingerprint);
    return true;
  });
}

function certificateFingerprint(certificate: forge.pki.Certificate): string {
  const der = forge.asn1.toDer(forge.pki.certificateToAsn1(certificate)).getBytes();
  return colonHex(sha256Hex(Buffer.from(der, "binary")));
}

function distinguishedName(attributes: forge.pki.CertificateField[]): string {
  return attributes
    .map((attribute) => {
      const name = attribute.shortName ?? attribute.name ?? attribute.type ?? "OID";
      return `${name}=${String(attribute.value ?? "")}`;
    })
    .join(", ");
}

function commonName(certificate: forge.pki.Certificate): string | undefined {
  const field = certificate.subject.getField("CN") as forge.pki.CertificateField | null;
  return typeof field?.value === "string" && field.value.length > 0 ? field.value : undefined;
}

function randomPositiveSerialNumber(): string {
  const serial = Buffer.from(forge.random.getBytesSync(4), "binary");
  serial[0] = (serial[0] ?? 0) & 0x7f;
  if (serial.every((value) => value === 0)) {
    serial[serial.length - 1] = 1;
  }
  return serial.toString("hex");
}

function requiredOid(name: keyof typeof forge.pki.oids): string {
  const oid = forge.pki.oids[name];
  if (!oid) {
    throw new Error(`node-forge does not expose required OID ${name}`);
  }
  return oid;
}

function sha256Hex(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function colonHex(value: string): string {
  return value.match(/.{2}/gu)?.join(":").toUpperCase() ?? value.toUpperCase();
}
