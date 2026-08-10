/// <reference types="node" />

import { createCipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import { zipSync } from "fflate";
import { decryptE0504, deriveSunSha1PrngKey } from "../src/egress/e0504.js";

const salt = Buffer.from("XwtXPTCoKniT/2qYiepvqg==", "base64");
const iv = Buffer.from("CDo1qERBxyttfz9rMkiG9A==", "base64");

describe("E0504 compatibility", () => {
  it("reproduces the Sun SHA1PRNG key emitted by the official Java implementation", () => {
    expect(deriveSunSha1PrngKey("1234202401025678", salt, 32).toString("hex")).toBe(
      "05ac91b953a2557e882f536ef1e7f21d93b19b14e4ece848b9cd819e1ae183c7",
    );
  });

  it("decrypts and expands the current AES-256-CTR E0504 package", () => {
    const filename = "1_A_12345678_11302_20240201000000_001_001.zip.E0504";
    const xml = '<Award xmlns="urn:GEINV:eInvoiceMessage:E0504:4.1"><Main/></Award>';
    const archive = Buffer.from(zipSync({ "award.xml": new TextEncoder().encode(xml) }));
    const paddingLength = 16 - (archive.length % 16);
    const paddedArchive = Buffer.concat([archive, Buffer.alloc(paddingLength, paddingLength)]);
    const key = deriveSunSha1PrngKey("1234202401025678", salt, 32);
    const cipher = createCipheriv("aes-256-ctr", key, iv);
    cipher.setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(paddedArchive), cipher.final()]);
    expect(decryptE0504(filename, encrypted)).toEqual([{ filename: "award.xml", xml }]);
  });
});
