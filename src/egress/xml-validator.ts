import { resolve, sep } from "node:path";
import type { MessageType } from "../core/index.js";
import { EgressHttpError } from "./auth.js";
import { runProcess } from "./process.js";

const commonSchemas = new Set<MessageType>(["E0501", "E0502", "E0503", "E0504"]);
const commonDocumentSchemas = new Set([
  "InvoiceEnvelope",
  "ProcessResult",
  "SummaryResult",
  "E0501",
  "E0502",
  "E0503",
  "E0504",
]);

export function schemaPath(xsdRoot: string, schema: string): string {
  let relative: string;
  const commonMatch = /^common\/v41\/([A-Za-z0-9]+)$/u.exec(schema)?.[1];
  if (commonMatch && commonDocumentSchemas.has(commonMatch)) {
    relative = `common/v41/${commonMatch}.xsd`;
  } else {
    const match = /^v41\/([A-Z]\d{4})$/u.exec(schema);
    if (!match?.[1]) {
      throw new EgressHttpError(400, "EGRESS_SCHEMA_INVALID", `Unsupported schema ${schema}`);
    }
    const messageType = match[1] as MessageType;
    relative = commonSchemas.has(messageType) ? `common/v41/${messageType}.xsd` : `v41/${messageType}.xsd`;
  }
  const root = resolve(xsdRoot);
  const path = resolve(root, relative);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new EgressHttpError(400, "EGRESS_SCHEMA_INVALID", "Schema path escaped the configured root");
  }
  return path;
}

export async function validateXml(xsdRoot: string, schema: string, xml: string): Promise<string | null> {
  if (/<!DOCTYPE|<!ENTITY/iu.test(xml)) {
    return "DOCTYPE and ENTITY declarations are not accepted";
  }
  const xsd = schemaPath(xsdRoot, schema);
  const result = await runProcess("xmllint", ["--nonet", "--noout", "--schema", xsd, "-"], xml);
  return result.exitCode === 0 ? null : result.stderr || `xmllint exited with ${result.exitCode}`;
}
