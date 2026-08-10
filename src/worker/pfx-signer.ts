import { Buffer } from "node:buffer";
import forge from "node-forge";
import { AdapterError, type TurnkeyCredentialBundle } from "../core/index.js";

interface PfxMaterial {
  privateKey: forge.pki.rsa.PrivateKey;
  signerCertificate: forge.pki.Certificate;
  certificates: forge.pki.Certificate[];
}

export function validatePfxCredential(signing: TurnkeyCredentialBundle["signing"]): void {
  const material = readPfx(signing.pfxBase64, signing.password);
  const now = new Date();
  if (material.signerCertificate.validity.notBefore > now || material.signerCertificate.validity.notAfter <= now) {
    throw new AdapterError("TW_PFX_CERTIFICATE_EXPIRED", "PFX signing certificate is not currently valid");
  }
}

export function signEnvelopeWithPfx(
  envelope: string,
  signing: TurnkeyCredentialBundle["signing"],
): string {
  try {
    const material = readPfx(signing.pfxBase64, signing.password);
    const now = new Date();
    if (material.signerCertificate.validity.notBefore > now || material.signerCertificate.validity.notAfter <= now) {
      throw new AdapterError("TW_PFX_CERTIFICATE_EXPIRED", "PFX signing certificate is not currently valid");
    }

    const signedData = forge.pkcs7.createSignedData();
    signedData.content = forge.util.createBuffer(Buffer.from(envelope, "utf8").toString("binary"));
    for (const certificate of material.certificates) {
      signedData.addCertificate(certificate);
    }
    const sha256Oid = requiredOid("sha256");
    const contentTypeOid = requiredOid("contentType");
    const dataOid = requiredOid("data");
    const messageDigestOid = requiredOid("messageDigest");
    const signingTimeOid = requiredOid("signingTime");
    signedData.addSigner({
      key: material.privateKey,
      certificate: material.signerCertificate,
      digestAlgorithm: sha256Oid,
      authenticatedAttributes: [
        { type: contentTypeOid, value: dataOid },
        { type: messageDigestOid },
        { type: signingTimeOid, value: now as unknown as string },
      ],
    });
    signedData.sign({ detached: false });
    const asn1 = signedData.toAsn1();
    useSha256WithRsaSignatureIdentifier(asn1);
    const der = forge.asn1.toDer(asn1).getBytes();
    return Buffer.from(der, "binary").toString("base64");
  } catch (error) {
    if (error instanceof AdapterError) {
      throw error;
    }
    throw new AdapterError("TW_PFX_SIGN_FAILED", "Failed to create an attached PKCS#7 signature", {
      cause: error,
    });
  }
}

function useSha256WithRsaSignatureIdentifier(contentInfo: forge.asn1.Asn1): void {
  const content = asn1Children(contentInfo);
  const signedDataWrapper = content[1];
  const signedData = signedDataWrapper ? asn1Children(signedDataWrapper)[0] : undefined;
  const signedDataFields = signedData ? asn1Children(signedData) : [];
  const signerInfos = signedDataFields.at(-1);
  const signerInfo = signerInfos ? asn1Children(signerInfos)[0] : undefined;
  const signerFields = signerInfo ? asn1Children(signerInfo) : [];
  const signatureAlgorithm = signerFields[4];
  const algorithmFields = signatureAlgorithm ? asn1Children(signatureAlgorithm) : [];
  if (!algorithmFields[0]) {
    throw new AdapterError("TW_PFX_RUNTIME_UNSUPPORTED", "Could not locate CMS SignerInfo signatureAlgorithm");
  }
  algorithmFields[0] = forge.asn1.create(
    forge.asn1.Class.UNIVERSAL,
    forge.asn1.Type.OID,
    false,
    forge.asn1.oidToDer("1.2.840.113549.1.1.11").getBytes(),
  );
}

function asn1Children(value: forge.asn1.Asn1): forge.asn1.Asn1[] {
  if (!Array.isArray(value.value)) {
    throw new AdapterError("TW_PFX_RUNTIME_UNSUPPORTED", "Unexpected CMS ASN.1 structure");
  }
  return value.value;
}

function readPfx(pfxBase64: string, password: string): PfxMaterial {
  try {
    const pfxBytes = Buffer.from(pfxBase64, "base64");
    if (pfxBytes.byteLength === 0) {
      throw new Error("PFX payload is empty");
    }
    const p12Asn1 = forge.asn1.fromDer(pfxBytes.toString("binary"));
    const p12 = forge.pkcs12.pkcs12FromAsn1(p12Asn1, false, password);
    const pkcs8BagOid = requiredOid("pkcs8ShroudedKeyBag");
    const keyBagOid = requiredOid("keyBag");
    const certBagOid = requiredOid("certBag");
    const keyBags: forge.pkcs12.Bag[] = [
      ...(p12.getBags({ bagType: pkcs8BagOid })[pkcs8BagOid] ?? []),
      ...(p12.getBags({ bagType: keyBagOid })[keyBagOid] ?? []),
    ];
    const certificateBags: forge.pkcs12.Bag[] = p12.getBags({ bagType: certBagOid })[certBagOid] ?? [];
    const privateKey = keyBags.find((bag) => bag.key)?.key;
    if (!privateKey) {
      throw new Error("PFX does not contain an RSA private key");
    }
    const certificates = certificateBags.flatMap((bag) => (bag.cert ? [bag.cert] : []));
    const signerCertificate = certificates.find((certificate) => {
      const publicKey = certificate.publicKey as forge.pki.rsa.PublicKey;
      return publicKey.n?.compareTo(privateKey.n) === 0;
    });
    if (!signerCertificate) {
      throw new Error("PFX does not contain a certificate matching its private key");
    }
    return { privateKey, signerCertificate, certificates };
  } catch (error) {
    throw new AdapterError("TW_PFX_INVALID", "PFX could not be opened with the supplied password", { cause: error });
  }
}

function requiredOid(name: keyof typeof forge.pki.oids): string {
  const oid = forge.pki.oids[name];
  if (!oid) {
    throw new AdapterError("TW_PFX_RUNTIME_UNSUPPORTED", `node-forge does not expose OID ${name}`);
  }
  return oid;
}
