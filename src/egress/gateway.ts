import type { GatewayInvoiceEvent } from "../core/index.js";
import type { EgressAccount } from "./config.js";
import { EgressHttpError } from "./auth.js";
import type { TransportCredentials } from "./sessions.js";

export interface GatewayResult {
  statusCode: number;
  statusMessage?: string;
  details: Array<{ code: string; description: string; parameters: string[] }>;
}

interface PlatformStatus {
  statusCode?: number;
  statusMsg?: string;
  statusMessage?: string;
  statusDetail?: Array<{
    code?: string;
    description?: string;
    parameter?: string[];
  }>;
  routeData?: {
    defaultRoutingId?: string;
    description?: string;
    dtpData?: Array<{ id?: string; description?: string }>;
  };
  compId?: string[];
}

export interface TurnkeyVersionQuery {
  turnkeyVersion: string;
  apiVersion: string;
  compId: string;
  dbType: string;
  osType: string;
  jreVersion: string;
  tkyType: string;
}

export async function queryTurnkeyVersionInfo(
  account: EgressAccount,
  credentials: TransportCredentials,
  input: TurnkeyVersionQuery,
): Promise<Record<string, unknown>> {
  const result = await platformPost(account, credentials, "/pfs004i/queryTurnkeyVersionInfo", {
    ...input,
    loginId: credentials.loginId,
    loginPassword: credentials.loginPassword,
  });
  assertSuccessfulQuery(result, "EGRESS_VERSION_QUERY_REJECTED");
  return result as Record<string, unknown>;
}

export async function queryErrorMessageInfo(
  account: EgressAccount,
  credentials: TransportCredentials,
): Promise<Record<string, unknown>> {
  const result = await platformPost(account, credentials, "/pfs005i/queryErrorMessageInfo", {
    loginId: credentials.loginId,
    loginPassword: credentials.loginPassword,
  });
  assertSuccessfulQuery(result, "EGRESS_ERROR_MESSAGE_QUERY_REJECTED");
  return result as Record<string, unknown>;
}

export async function queryCrossBorderSellers(
  account: EgressAccount,
  credentials: TransportCredentials,
): Promise<string[]> {
  const result = await platformPost(account, credentials, "/pfs003i/queryCrossBorderInfo", {
    loginId: credentials.loginId,
    loginPassword: credentials.loginPassword,
  });
  if (result.statusCode !== 0) {
    throw new EgressHttpError(
      422,
      "EGRESS_CROSS_BORDER_QUERY_REJECTED",
      result.statusMsg ?? result.statusMessage ?? `Gateway status ${result.statusCode ?? "unknown"}`,
    );
  }
  return Array.from(new Set((result.compId ?? []).filter((value) => /^\d{8,10}$/u.test(value)))).slice(0, 10_000);
}

export async function registerInvoiceEvent(
  account: EgressAccount,
  credentials: TransportCredentials,
  event: GatewayInvoiceEvent,
): Promise<GatewayResult> {
  const payload = {
    ...event,
    loginId: credentials.loginId,
    loginPassword: credentials.loginPassword,
  };
  const result = await platformPost(account, credentials, "/pfs001i/uploadInvoiceMessage", payload);
  return {
    statusCode: result.statusCode ?? -1,
    ...(result.statusMsg || result.statusMessage
      ? { statusMessage: result.statusMsg ?? result.statusMessage }
      : {}),
    details: (result.statusDetail ?? []).map((detail) => ({
      code: detail.code ?? "UNKNOWN",
      description: detail.description ?? "",
      parameters: detail.parameter ?? [],
    })),
  };
}

export async function queryTradingPartner(
  account: EgressAccount,
  credentials: TransportCredentials,
  input: { partyId: string; partnerType: "0" | "1" },
): Promise<{ routingId: string; description: string }> {
  const result = await platformPost(account, credentials, "/pfs002i/queryTradingPartnerInfo", {
    loginId: credentials.loginId,
    loginPassword: credentials.loginPassword,
    compId: input.partyId,
    partnerType: input.partnerType,
  });
  if (result.statusCode !== 0) {
    throw new EgressHttpError(
      422,
      "EGRESS_TRADING_PARTNER_REJECTED",
      result.statusMsg ?? result.statusMessage ?? `Gateway status ${result.statusCode ?? "unknown"}`,
    );
  }
  const route = selectTradingPartnerRoute(result.routeData);
  if (!route) {
    throw new EgressHttpError(404, "EGRESS_TRADING_PARTNER_NOT_FOUND", `No routing code for ${input.partyId}`);
  }
  return route;
}

export function selectTradingPartnerRoute(
  routeData: PlatformStatus["routeData"],
): { routingId: string; description: string } | null {
  const defaultRoutingId = routeData?.defaultRoutingId ?? "";
  if (!defaultRoutingId || defaultRoutingId.startsWith("EINVCT99")) {
    return null;
  }
  const route = routeData?.dtpData?.find((candidate) => candidate.id === defaultRoutingId);
  return route ? { routingId: defaultRoutingId, description: route.description ?? routeData?.description ?? "" } : null;
}

async function platformPost(
  account: EgressAccount,
  credentials: TransportCredentials,
  path: string,
  body: object,
): Promise<PlatformStatus> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), account.gateway.timeoutMs);
  try {
    const response = await fetch(gatewayUrl(account.gateway.baseUrl, path), {
      method: "POST",
      headers: {
        authorization: `Basic ${Buffer.from(`${credentials.loginId}:${credentials.loginPassword}`).toString("base64")}`,
        "content-type": "application/json",
        accept: "application/json",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) {
      throw new EgressHttpError(
        response.status >= 500 ? 502 : 422,
        "EGRESS_GATEWAY_HTTP_ERROR",
        `Gateway returned ${response.status}: ${text.slice(0, 1000)}`,
      );
    }
    return JSON.parse(text) as PlatformStatus;
  } finally {
    clearTimeout(timeout);
  }
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

export function gatewayUrl(baseUrl: string, path: string): URL {
  return new URL(path.replace(/^\/+/, ""), ensureTrailingSlash(baseUrl));
}

function assertSuccessfulQuery(result: PlatformStatus, code: string): void {
  if (result.statusCode !== 0) {
    throw new EgressHttpError(
      422,
      code,
      result.statusMsg ?? result.statusMessage ?? `Gateway status ${result.statusCode ?? "unknown"}`,
    );
  }
}
