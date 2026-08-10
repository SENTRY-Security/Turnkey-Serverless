import { createDecipheriv, createHash } from "node:crypto";
import { unzipSync } from "fflate";
import { parseE0504Filename } from "../core/index.js";
import { EgressHttpError } from "./auth.js";

const NEW_SALT = Buffer.from("XwtXPTCoKniT/2qYiepvqg==", "base64");
const NEW_IV = Buffer.from("CDo1qERBxyttfz9rMkiG9A==", "base64");
const OLD_SALT = Buffer.from("Nd8NUYIxHIBxlzExqGM9gA==", "base64");
const OLD_IV = Buffer.from("Dt8lyToo17X/XkXaQvihuA==", "base64");
const ZIP_LOCAL_HEADER = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const MAX_ENTRIES = 1_000;
const MAX_EXTRACTED_BYTES = 40 * 1024 * 1024;

export interface E0504Document {
  filename: string;
  xml: string;
}

export function decryptE0504(filename: string, encrypted: Buffer): E0504Document[] {
  const parsed = parseE0504Filename(filename);
  if (!parsed) {
    throw new EgressHttpError(400, "EGRESS_E0504_FILENAME_INVALID", "Invalid E0504 filename");
  }
  const rocYear = Number(parsed.rocYearMonth.slice(0, 3));
  const declaredMonth = Number(parsed.rocYearMonth.slice(3));
  const periodEndMonth = Math.floor(declaredMonth / 2) * 2;
  if (periodEndMonth < 2 || periodEndMonth > 12) {
    throw new EgressHttpError(400, "EGRESS_E0504_PERIOD_INVALID", "Invalid E0504 ROC year/month period");
  }
  const passphrase = [
    parsed.sellerPartyId.slice(0, 4),
    String(rocYear + 1911),
    String(periodEndMonth - 1).padStart(2, "0"),
    String(periodEndMonth).padStart(2, "0"),
    parsed.sellerPartyId.slice(4),
  ].join("");

  const decrypted = decryptNew(encrypted, passphrase) ?? decryptLegacy(encrypted, passphrase);
  if (!decrypted) {
    throw new EgressHttpError(422, "EGRESS_E0504_DECRYPT_FAILED", "E0504 AES decryption failed");
  }

  let entryCount = 0;
  let extractedBytes = 0;
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(decrypted, {
      filter: (entry) => {
        if (entry.name.endsWith("/")) {
          return false;
        }
        entryCount += 1;
        extractedBytes += entry.originalSize;
        if (entryCount > MAX_ENTRIES || extractedBytes > MAX_EXTRACTED_BYTES) {
          throw new Error("E0504 ZIP exceeds extraction limits");
        }
        return true;
      },
    });
  } catch (error) {
    throw new EgressHttpError(422, "EGRESS_E0504_ZIP_INVALID", "E0504 payload is not a safe ZIP archive", {
      cause: error,
    });
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const documents = Object.entries(entries).map(([entryName, bytes]) => {
    if (entryName.includes("..") || entryName.startsWith("/") || entryName.includes("\\")) {
      throw new EgressHttpError(422, "EGRESS_E0504_ENTRY_INVALID", `Unsafe E0504 ZIP entry ${entryName}`);
    }
    try {
      return { filename: entryName, xml: decoder.decode(bytes) };
    } catch (error) {
      throw new EgressHttpError(422, "EGRESS_E0504_ENCODING_INVALID", `${entryName} is not UTF-8 XML`, {
        cause: error,
      });
    }
  });
  if (documents.length === 0) {
    throw new EgressHttpError(422, "EGRESS_E0504_EMPTY", "E0504 ZIP contains no invoice documents");
  }
  return documents;
}

export function deriveSunSha1PrngKey(passphrase: string, salt: Buffer, length: number): Buffer {
  const seed = createHash("sha1").update(passphrase, "utf8").update(salt).digest();
  let state = createHash("sha1").update(seed).digest();
  const chunks: Buffer[] = [];
  let generated = 0;
  while (generated < length) {
    const output = createHash("sha1").update(state).digest();
    chunks.push(output);
    generated += output.length;
    let carry = 1;
    let changed = false;
    for (let index = 0; index < state.length; index += 1) {
      const stateByte = signedByte(state[index] ?? 0);
      const outputByte = signedByte(output[index] ?? 0);
      const value = stateByte + outputByte + carry;
      const next = value & 0xff;
      changed ||= state[index] !== next;
      state[index] = next;
      carry = value >> 8;
    }
    if (!changed) {
      state[0] = ((state[0] ?? 0) + 1) & 0xff;
    }
  }
  return Buffer.concat(chunks).subarray(0, length);
}

function decryptNew(encrypted: Buffer, passphrase: string): Buffer | null {
  try {
    const key = deriveSunSha1PrngKey(passphrase, NEW_SALT, 32);
    const decipher = createDecipheriv("aes-256-ctr", key, NEW_IV);
    decipher.setAutoPadding(false);
    const value = stripPkcs7(Buffer.concat([decipher.update(encrypted), decipher.final()]));
    return value.subarray(0, 4).equals(ZIP_LOCAL_HEADER) ? value : null;
  } catch {
    return null;
  }
}

function stripPkcs7(value: Buffer): Buffer {
  const padding = value.at(-1) ?? 0;
  if (padding < 1 || padding > 16 || padding > value.length) {
    throw new Error("Invalid E0504 PKCS#7 padding");
  }
  for (let index = value.length - padding; index < value.length; index += 1) {
    if (value[index] !== padding) {
      throw new Error("Invalid E0504 PKCS#7 padding");
    }
  }
  return value.subarray(0, -padding);
}

function decryptLegacy(encrypted: Buffer, passphrase: string): Buffer | null {
  try {
    const key = deriveSunSha1PrngKey(passphrase, OLD_SALT, 16);
    const decipher = createDecipheriv("aes-128-cbc", key, OLD_IV);
    const value = Buffer.concat([decipher.update(encrypted), decipher.final()]);
    return value.subarray(0, 4).equals(ZIP_LOCAL_HEADER) ? value : null;
  } catch {
    return null;
  }
}

function signedByte(value: number): number {
  return value > 127 ? value - 256 : value;
}
