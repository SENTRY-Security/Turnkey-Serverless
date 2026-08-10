import { EgressHttpError } from "./auth.js";
import { runProcess } from "./process.js";

export async function verifyAndExtractCms(payload: Buffer): Promise<string> {
  const ascii = payload.toString("utf8").replaceAll(/\s/gu, "");
  let der: Buffer;
  try {
    if (!ascii || ascii.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(ascii)) {
      throw new Error("invalid Base64 alphabet or padding");
    }
    der = Buffer.from(ascii, "base64");
    if (der.length === 0) {
      throw new Error("empty CMS payload");
    }
  } catch (error) {
    throw new EgressHttpError(422, "EGRESS_CMS_BASE64_INVALID", "Signed result is not valid Base64 CMS", {
      cause: error,
    });
  }
  const result = await runProcess(
    "openssl",
    ["cms", "-verify", "-binary", "-inform", "DER", "-noverify", "-in", "/dev/stdin", "-out", "/dev/stdout"],
    der,
  );
  if (result.exitCode !== 0) {
    throw new EgressHttpError(422, "EGRESS_CMS_VERIFY_FAILED", result.stderr || "CMS signature verification failed");
  }
  return result.stdout.toString("utf8");
}
