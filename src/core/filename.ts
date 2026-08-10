import { outboundMessageTypes, outboundProtocolRules, type OutboundMessageType } from "./contracts.js";

function taipeiDateParts(date: Date): Record<string, string> {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

export function createMessageDts(date: Date): string {
  const part = taipeiDateParts(date);
  return `${part.year}${part.month}${part.day}${part.hour}${part.minute}${part.second}${String(
    date.getMilliseconds(),
  ).padStart(3, "0")}`;
}

export function sanitizeSourceFilename(value: string): string {
  const sanitized = value.normalize("NFKC").replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 100);
  return sanitized || "finance.xml";
}

export function createTurnkeyFilename(input: {
  messageType: OutboundMessageType;
  messageDts: string;
  uuid: string;
}): string {
  const date = input.messageDts.slice(0, 8);
  const time = input.messageDts.slice(8, 17);
  return `v41-${input.messageType}-${date}-${time}-${input.uuid}`;
}

export interface ParsedResultFilename {
  version: "v41";
  messageType: OutboundMessageType;
  messageDts: string;
  uuid: string;
  resultType: "ProcessResult" | "Ack";
}

const resultFilenamePattern =
  /^(v41)-([A-Z]\d{4})-(\d{8})-(\d{9})-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(ProcessResult|Ack)$/iu;

export function parseResultFilename(filename: string): ParsedResultFilename | null {
  const match = resultFilenamePattern.exec(filename);
  if (!match) {
    return null;
  }
  const [, version, messageType, date, time, uuid, resultType] = match;
  if (!outboundMessageTypes.includes(messageType as OutboundMessageType)) {
    return null;
  }
  return {
    version: version as "v41",
    messageType: messageType as OutboundMessageType,
    messageDts: `${date}${time}`,
    uuid: uuid?.toLowerCase() ?? "",
    resultType: resultType as "ProcessResult" | "Ack",
  };
}

export interface ParsedSummaryResultFilename {
  senderPartyId: string;
  senderRoutingId: string;
  receiverPartyId: string;
  receiverRoutingId: string;
  transmissionDate: string;
  platformMessageDts: string;
  count: number | null;
  final: boolean;
}

export function parseSummaryResultFilename(filename: string): ParsedSummaryResultFilename | null {
  if (!filename.endsWith(".SummaryResult")) {
    return null;
  }
  let common = filename.slice(0, -".SummaryResult".length);
  const final = common.endsWith(".Final") || common.endsWith("-Final") || common.endsWith("_Final");
  if (final) {
    common = common.slice(0, -6);
  }
  const delimiter = common.includes("_") ? "_" : "-";
  const parts = common.split(delimiter);
  if (parts.length !== 6 && parts.length !== 7) {
    return null;
  }
  const [senderPartyId, senderRoutingId, receiverPartyId, receiverRoutingId, transmissionDate, platformMessageDts] =
    parts;
  const countText = parts[6];
  if (
    !senderPartyId ||
    !senderRoutingId ||
    !receiverPartyId ||
    !receiverRoutingId ||
    !/^\d{8}$/u.test(transmissionDate ?? "") ||
    !/^\d{17}$/u.test(platformMessageDts ?? "") ||
    (countText !== undefined && !/^\d+$/u.test(countText))
  ) {
    return null;
  }
  return {
    senderPartyId: senderPartyId ?? "",
    senderRoutingId: senderRoutingId ?? "",
    receiverPartyId: receiverPartyId ?? "",
    receiverRoutingId: receiverRoutingId ?? "",
    transmissionDate: transmissionDate ?? "",
    platformMessageDts: platformMessageDts ?? "",
    count: countText === undefined ? null : Number(countText),
    final,
  };
}

export interface ParsedE05Filename {
  messageType: "E0501" | "E0502" | "E0503";
  partyId: string;
  messageDts: string;
}

const e05FilenamePattern = /^(v41)-(\d{8,10})-(\d{8})-(\d{9})\.(E050[123])$/u;

export function parseE05Filename(filename: string): ParsedE05Filename | null {
  const match = e05FilenamePattern.exec(filename);
  if (!match) {
    return null;
  }
  return {
    partyId: match[2] ?? "",
    messageDts: `${match[3] ?? ""}${match[4] ?? ""}`,
    messageType: match[5] as ParsedE05Filename["messageType"],
  };
}

export interface ParsedE0504Filename {
  sellerPartyId: string;
  rocYearMonth: string;
  messageDts: string;
  fileSequence: number;
  fileCount: number;
}

const e0504FilenamePattern =
  /^[^_]_[^_]_(\d{8})_(\d{5})_(\d{14})_(\d{3})_(\d{3})\.zip\.E0504$/u;

export function parseE0504Filename(filename: string): ParsedE0504Filename | null {
  const match = e0504FilenamePattern.exec(filename);
  if (!match) {
    return null;
  }
  const rocYearMonth = match[2] ?? "";
  const month = Number(rocYearMonth.slice(3));
  if (month < 1 || month > 12) {
    return null;
  }
  return {
    sellerPartyId: match[1] ?? "",
    rocYearMonth,
    messageDts: match[3] ?? "",
    fileSequence: Number(match[4]),
    fileCount: Number(match[5]),
  };
}

export type InboundFilename =
  | { kind: "PROCESS_RESULT"; value: ParsedResultFilename }
  | { kind: "ACK"; value: ParsedResultFilename }
  | { kind: "SUMMARY_RESULT"; value: ParsedSummaryResultFilename }
  | { kind: "E05"; value: ParsedE05Filename }
  | { kind: "E0504"; value: ParsedE0504Filename }
  | { kind: "INVOICE" }
  | { kind: "UNKNOWN" };

export function classifyInboundFilename(filename: string): InboundFilename {
  const common = parseResultFilename(filename);
  if (common) {
    return { kind: common.resultType === "Ack" ? "ACK" : "PROCESS_RESULT", value: common };
  }
  const summary = parseSummaryResultFilename(filename);
  if (summary) {
    return { kind: "SUMMARY_RESULT", value: summary };
  }
  const e0504 = parseE0504Filename(filename);
  if (e0504) {
    return { kind: "E0504", value: e0504 };
  }
  const e05 = parseE05Filename(filename);
  if (e05) {
    return { kind: "E05", value: e05 };
  }
  const invoice = /^(v41)-([A-Z]\d{4})-\d{8}-\d{9}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.exec(
    filename,
  );
  const messageType = invoice?.[2]?.toUpperCase() as OutboundMessageType | undefined;
  return messageType &&
    outboundMessageTypes.includes(messageType) &&
    outboundProtocolRules[messageType].processType === "EXCHANGE"
    ? { kind: "INVOICE" }
    : { kind: "UNKNOWN" };
}
