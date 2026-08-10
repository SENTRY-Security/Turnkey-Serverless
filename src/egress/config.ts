import { readFileSync } from "node:fs";
import { z } from "zod";

const accountSchema = z.object({
  environment: z.enum(["TEST", "PRODUCTION"]),
  sftp: z.object({
    host: z.string().min(1),
    port: z.number().int().min(1).max(65535).default(2222),
    hostKeySha256: z
      .string()
      .regex(
        /^(?:SHA256:)?[A-Za-z0-9+/]{43}=?$/u,
        "hostKeySha256 must be an OpenSSH SHA-256 fingerprint",
      ),
    inbox: z.string().default("in"),
    outbox: z.string().default("out"),
  }),
  gateway: z.object({
    baseUrl: z.string().url(),
    timeoutMs: z.number().int().min(1000).max(300_000).default(60_000),
  }),
  crossBorderSellerIds: z.array(z.string().regex(/^\d{8,10}$/u)).default([]),
});

const accountsSchema = z.record(z.string().min(1), accountSchema);

export type EgressAccount = z.infer<typeof accountSchema>;

export interface EgressConfig {
  host: string;
  port: number;
  hmacSecret: string;
  sessionTtlSeconds: number;
  xsdRoot: string;
  accounts: Record<string, EgressAccount>;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): EgressConfig {
  const hmacSecret = environment.EGRESS_HMAC_SECRET;
  if (!hmacSecret || hmacSecret.length < 24) {
    throw new Error("EGRESS_HMAC_SECRET must contain at least 24 characters");
  }

  const accountsText = environment.TURNKEY_ACCOUNTS_JSON ?? readAccountsFile(environment.TURNKEY_ACCOUNTS_FILE);
  if (!accountsText) {
    throw new Error("Set TURNKEY_ACCOUNTS_FILE or TURNKEY_ACCOUNTS_JSON");
  }

  return {
    host: environment.EGRESS_HOST ?? "127.0.0.1",
    port: parsePort(environment.EGRESS_PORT ?? "8788"),
    hmacSecret,
    sessionTtlSeconds: parseSessionTtl(environment.EGRESS_SESSION_TTL_SECONDS ?? "300"),
    xsdRoot: environment.TURNKEY_XSD_ROOT ?? "/opt/turnkey/schemas/xsd",
    accounts: accountsSchema.parse(JSON.parse(accountsText)),
  };
}

function parseSessionTtl(value: string): number {
  const seconds = Number(value);
  if (!Number.isInteger(seconds) || seconds < 30 || seconds > 900) {
    throw new Error(`Invalid EGRESS_SESSION_TTL_SECONDS: ${value}`);
  }
  return seconds;
}

function readAccountsFile(path: string | undefined): string | undefined {
  return path ? readFileSync(path, "utf8") : undefined;
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid EGRESS_PORT: ${value}`);
  }
  return port;
}
