import {
  DOMParser,
  XMLSerializer,
  type Document as XmlDocument,
  type Element as XmlElement,
} from "@xmldom/xmldom";
import { messageTypes } from "./contracts.js";
import type { MessageType, OutboundMessageType, PartyInfo, StoredDocument } from "./contracts.js";
import { AdapterError } from "./errors.js";

const XML_DECLARATION = /^\s*<\?xml[^?]*\?>\s*/iu;
const UNSAFE_XML = /<!DOCTYPE|<!ENTITY/iu;

const rootNames: Record<MessageType, string> = {
  A0101: "Invoice",
  A0102: "InvoiceConfirm",
  A0201: "CancelInvoice",
  A0202: "CancelInvoiceConfirm",
  A0301: "RejectInvoice",
  A0302: "RejectInvoiceConfirm",
  B0101: "Allowance",
  B0102: "AllowanceConfirm",
  B0201: "CancelAllowance",
  B0202: "CancelAllowanceConfirm",
  E0401: "BranchTrack",
  E0402: "BranchTrackBlank",
  E0501: "InvoiceAssignNo",
  E0502: "InputInvoice",
  E0503: "InputAllowance",
  E0504: "Award",
  F0401: "Invoice",
  F0501: "CancelInvoice",
  F0701: "VoidInvoice",
  G0401: "Allowance",
  G0501: "CancelAllowance",
  G0701: "VoidAllowance",
};

const namespaces: Record<MessageType, string> = Object.fromEntries(
  Object.keys(rootNames).map((messageType) => [
    messageType,
    messageType === "E0501"
      ? "urn:GEINV:E0501:4.1"
      : `urn:GEINV:eInvoiceMessage:${messageType}:4.1`,
  ]),
) as Record<MessageType, string>;

export interface XmlInspection {
  rootName: string;
  namespace: string;
  invoiceIdentifier: string | null;
}

export function stripXmlDeclaration(xml: string): string {
  return xml.replace(XML_DECLARATION, "").trim();
}

export function inspectMigDocument(xml: string, messageType: MessageType): XmlInspection {
  if (UNSAFE_XML.test(xml)) {
    throw new AdapterError("TW_XML_UNSAFE_DECLARATION", "DOCTYPE and ENTITY declarations are not accepted");
  }

  const parserErrors: string[] = [];
  const document = new DOMParser({
    onError: (level, message) => {
      if (level === "error" || level === "fatalError") {
        parserErrors.push(message);
      }
    },
  }).parseFromString(xml, "application/xml");

  if (parserErrors.length > 0 || document.documentElement === null) {
    throw new AdapterError("TW_XML_NOT_WELL_FORMED", parserErrors.join("; ") || "XML has no document element");
  }

  const root = document.documentElement;
  const rootName = root.localName || root.nodeName.replace(/^.*:/u, "");
  const expectedRoot = rootNames[messageType];
  if (rootName !== expectedRoot) {
    throw new AdapterError(
      "TW_XML_MESSAGE_TYPE_MISMATCH",
      `Expected root ${expectedRoot} for ${messageType}, received ${rootName}`,
    );
  }

  const namespace = root.namespaceURI ?? "";
  const expectedNamespace = namespaces[messageType];
  if (namespace !== expectedNamespace) {
    throw new AdapterError(
      "TW_XML_NAMESPACE_MISMATCH",
      `Expected MIG 4.1 namespace for ${messageType}, received ${namespace || "(empty)"}`,
    );
  }

  const invoiceIdentifier = extractInvoiceIdentifier(document, messageType);
  return { rootName, namespace, invoiceIdentifier };
}

function extractInvoiceIdentifier(document: XmlDocument, messageType: MessageType): string | null {
  const fields: Partial<Record<MessageType, [string, string]>> = {
    A0101: ["InvoiceNumber", "InvoiceDate"],
    A0102: ["InvoiceNumber", "InvoiceDate"],
    A0201: ["CancelInvoiceNumber", "CancelDate"],
    A0202: ["CancelInvoiceNumber", "CancelDate"],
    A0301: ["RejectInvoiceNumber", "RejectDate"],
    A0302: ["RejectInvoiceNumber", "RejectDate"],
    B0101: ["AllowanceNumber", "AllowanceDate"],
    B0102: ["AllowanceNumber", "AllowanceDate"],
    B0201: ["CancelAllowanceNumber", "CancelDate"],
    B0202: ["CancelAllowanceNumber", "CancelDate"],
    E0502: ["InvoiceNumber", "InvoiceDate"],
    E0503: ["AllowanceNumber", "AllowanceDate"],
    F0401: ["InvoiceNumber", "InvoiceDate"],
    F0501: ["CancelInvoiceNumber", "CancelDate"],
    F0701: ["VoidInvoiceNumber", "VoidDate"],
    G0401: ["AllowanceNumber", "AllowanceDate"],
    G0501: ["CancelAllowanceNumber", "CancelDate"],
    G0701: ["VoidAllowanceNumber", "VoidDate"],
  };
  const pair = fields[messageType];
  if (pair) {
    const reference = firstText(document, [pair[0]]);
    const date = firstText(document, [pair[1]]);
    return reference && date ? `${messageType}${reference}${date}` : null;
  }
  if (messageType === "E0401") {
    const branch = firstText(document, ["BranchBan"]);
    const track = firstText(document, ["InvoiceTrack"]);
    const begin = firstText(document, ["InvoiceBeginNo"]);
    const end = firstText(document, ["InvoiceEndNo"]);
    return branch && track && begin && end ? `${branch}-${track}${begin}-${end}` : null;
  }
  if (messageType === "E0402") {
    const branch = firstText(document, ["BranchBan"]);
    const track = firstText(document, ["InvoiceTrack"]);
    const invoiceType = firstText(document, ["InvoiceType"]);
    return branch && track && invoiceType ? `${branch}-${track}${invoiceType}` : null;
  }
  if (messageType === "E0501") {
    const ban = firstText(document, ["Ban"]);
    const track = firstText(document, ["InvoiceTrack"]);
    const begin = firstText(document, ["InvoiceBeginNo"]);
    const end = firstText(document, ["InvoiceEndNo"]);
    return ban && track && begin && end ? `${ban}:${track}-${begin}-${end}` : null;
  }
  return null;
}

function firstText(document: XmlDocument, names: string[]): string | null {
  for (const name of names) {
    const nodes = document.getElementsByTagNameNS("*", name);
    const value = nodes.item(0)?.textContent?.trim();
    if (value) {
      return value;
    }
  }
  return null;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function partyXml(tag: "From" | "To", party: PartyInfo): string {
  const description = party.description ? `<Description>${escapeXml(party.description)}</Description>` : "";
  return `<${tag}><PartyId>${escapeXml(party.partyId)}</PartyId>${description}</${tag}>`;
}

function routeXml(tag: "FromVAC" | "ToVAC", party: PartyInfo): string {
  const description = party.routingDescription
    ? `<Description>${escapeXml(party.routingDescription)}</Description>`
    : "";
  return `<${tag}><RoutingId>${escapeXml(party.routingId)}</RoutingId>${description}</${tag}>`;
}

export function buildInvoiceEnvelope(input: {
  messageType: OutboundMessageType;
  from: PartyInfo;
  to: PartyInfo;
  documents: StoredDocument[];
}): string {
  if (input.documents.length < 1 || input.documents.length > 1000) {
    throw new AdapterError("TW_ENVELOPE_COUNT_INVALID", "An InvoiceEnvelope must contain 1 to 1000 documents");
  }

  const payload = input.documents.map((document) => stripXmlDeclaration(document.xml)).join("\n");
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<InvoiceEnvelope xmlns="urn:GEINV:InvoiceEnvelope:4.1">',
    partyXml("From", input.from),
    routeXml("FromVAC", input.from),
    partyXml("To", input.to),
    routeXml("ToVAC", input.to),
    `<InvoicePack messageType="${input.messageType}" count="${input.documents.length}" version="v41">`,
    payload,
    "</InvoicePack>",
    "</InvoiceEnvelope>",
  ].join("\n");
}

export interface ProcessResultInfo {
  code: string;
  description: string;
  parameter0: string;
  parameter1: string;
  parameters: string[];
}

export interface ParsedProcessResult {
  messageId: string;
  messageType: string;
  service: string;
  action: string;
  infos: ProcessResultInfo[];
  confirmed: boolean;
}

export function parseProcessResult(xml: string): ParsedProcessResult {
  if (UNSAFE_XML.test(xml)) {
    throw new AdapterError("TW_RESULT_UNSAFE_XML", "Result contains an unsafe XML declaration");
  }
  const document = parseXml(xml, "TW_RESULT_NOT_WELL_FORMED");
  const root = document.documentElement;
  const rootName = root?.localName;
  if (rootName !== "ProcessResult") {
    throw new AdapterError("TW_RESULT_UNSUPPORTED", `Expected ProcessResult, received ${rootName ?? "empty XML"}`);
  }
  if (root?.namespaceURI !== "urn:GEINV:ProcessResult:4.1") {
    throw new AdapterError("TW_RESULT_VERSION_UNSUPPORTED", "Only ProcessResult 4.1 is supported");
  }

  const messageInfo = firstElement(document, "MessageInfo");
  const result = firstElement(document, "Result");
  const infos = elements(result, "Info").map((info) => {
    const parameters = [0, 1, 2, 3, 4].map((index) => childText(info, `Parameter${index}`));
    return {
      code: childText(info, "Code"),
      description: childText(info, "Description"),
      parameter0: parameters[0] ?? "",
      parameter1: parameters[1] ?? "",
      parameters: parameters.filter((value) => value.length > 0),
    };
  });

  if (infos.length === 0) {
    throw new AdapterError("TW_RESULT_MISSING_INFO", "ProcessResult does not contain Result/Info");
  }

  return {
    messageId: childText(messageInfo, "Id"),
    messageType: childText(messageInfo, "MessageType"),
    service: childText(messageInfo, "Service"),
    action: childText(messageInfo, "Action"),
    infos,
    confirmed: infos[0]?.code === "00000",
  };
}

export interface ProcessResultDocument {
  documentIndex: number;
  invoiceIdentifier: string | null;
}

export interface ProcessResultDocumentOutcome extends ProcessResultDocument {
  status: "CONFIRMED" | "REJECTED";
  errorCode: string | null;
  errorMessage: string | null;
}

export interface ResolvedProcessResult {
  status: "CONFIRMED" | "PARTIALLY_REJECTED" | "REJECTED";
  outcomes: ProcessResultDocumentOutcome[];
  unresolvedErrors: ProcessResultInfo[];
}

const RECORD_NUMBER_PATTERN = /^No\. (\d+)/u;

export function resolveProcessResult(
  result: ParsedProcessResult,
  documents: ProcessResultDocument[],
): ResolvedProcessResult {
  const outcomes: ProcessResultDocumentOutcome[] = documents.map((document) => ({
    ...document,
    status: "CONFIRMED",
    errorCode: null,
    errorMessage: null,
  }));
  if (result.confirmed) {
    return { status: "CONFIRMED", outcomes, unresolvedErrors: [] };
  }

  const errors = result.infos.filter((info) => info.code !== "00000");
  const firstHasRecord = RECORD_NUMBER_PATTERN.test(errors[0]?.description ?? "");
  const allFailed =
    result.service === "E" ||
    errors.length === documents.length ||
    (errors.length === 1 && !firstHasRecord && !resultInvoiceIdentifier(result, errors[0]));
  if (allFailed) {
    const first = errors[0];
    return {
      status: "REJECTED",
      outcomes: outcomes.map((outcome, index) => {
        const error = errors[index] ?? first;
        return {
          ...outcome,
          status: "REJECTED",
          errorCode: error?.code ?? "TW_RESULT_REJECTED",
          errorMessage: error?.description ?? "Turnkey rejected the transmission",
        };
      }),
      unresolvedErrors: [],
    };
  }

  const unresolvedErrors: ProcessResultInfo[] = [];
  for (const error of errors) {
    const record = RECORD_NUMBER_PATTERN.exec(error.description)?.[1];
    const identifier = resultInvoiceIdentifier(result, error);
    const outcome = record
      ? outcomes.find((candidate) => candidate.documentIndex === Number(record) - 1)
      : identifier
        ? outcomes.find((candidate) => candidate.invoiceIdentifier === identifier)
        : outcomes.length === 1
          ? outcomes[0]
          : undefined;
    if (!outcome) {
      unresolvedErrors.push(error);
      continue;
    }
    outcome.status = "REJECTED";
    outcome.errorCode = error.code;
    outcome.errorMessage = error.description;
  }

  if (unresolvedErrors.length > 0) {
    const first = unresolvedErrors[0];
    for (const outcome of outcomes.filter((value) => value.status === "CONFIRMED")) {
      outcome.status = "REJECTED";
      outcome.errorCode = first?.code ?? "TW_RESULT_DOCUMENT_MAPPING_FAILED";
      outcome.errorMessage = first?.description ?? "Turnkey error could not be mapped to a document";
    }
  }
  const rejectedCount = outcomes.filter((outcome) => outcome.status === "REJECTED").length;
  return {
    status: rejectedCount === outcomes.length ? "REJECTED" : "PARTIALLY_REJECTED",
    outcomes,
    unresolvedErrors,
  };
}

function resultInvoiceIdentifier(result: ParsedProcessResult, info: ProcessResultInfo | undefined): string | null {
  if (!info?.parameter0 || !info.parameter1) {
    return null;
  }
  const value = `${result.messageType}${info.parameter0}${info.parameter1}`;
  return /^[A-Z]\d{4}.+\d{8}$/u.test(value) ? value : null;
}

export interface SummaryResultInvoice {
  referenceNumber: string;
  invoiceDate: string;
}

export interface SummaryResultCount {
  count: number;
  invoices: SummaryResultInvoice[];
}

export interface SummaryResultMessage {
  id: string;
  size: number;
  messageType: string;
  service: string;
  action: string;
  total: SummaryResultCount;
  good: SummaryResultCount;
  failed: SummaryResultCount;
}

export interface ParsedSummaryResult {
  from: PartyInfo;
  to: PartyInfo;
  messages: SummaryResultMessage[];
}

export function parseSummaryResult(xml: string): ParsedSummaryResult {
  if (UNSAFE_XML.test(xml)) {
    throw new AdapterError("TW_SUMMARY_UNSAFE_XML", "SummaryResult contains DOCTYPE or ENTITY");
  }
  const document = parseXml(xml, "TW_SUMMARY_NOT_WELL_FORMED");
  const root = document.documentElement;
  if (!root || root.localName !== "SummaryResult") {
    throw new AdapterError("TW_SUMMARY_UNSUPPORTED", `Expected SummaryResult, received ${root?.localName ?? "empty XML"}`);
  }
  if (root.namespaceURI !== "urn:GEINV:SummaryResult:4.1") {
    throw new AdapterError("TW_SUMMARY_VERSION_UNSUPPORTED", "Only SummaryResult 4.1 is supported");
  }
  const routing = firstElement(root, "RoutingInfo");
  const detailList = firstElement(root, "DetailList");
  const messages = elements(detailList, "Message").map((message) => {
    const info = firstDirectElement(message, "Info");
    const result = firstDirectElement(message, "ResultType");
    return {
      id: childText(info, "Id"),
      size: Number(childText(info, "Size")),
      messageType: childText(info, "MessageType"),
      service: childText(info, "Service"),
      action: childText(info, "Action"),
      total: parseSummaryCount(firstDirectElement(result, "Total")),
      good: parseSummaryCount(firstDirectElement(result, "Good")),
      failed: parseSummaryCount(firstDirectElement(result, "Failed")),
    };
  });
  if (messages.length === 0) {
    throw new AdapterError("TW_SUMMARY_EMPTY", "SummaryResult does not contain DetailList/Message");
  }
  return {
    from: envelopeParty(routing, "From", "FromVAC"),
    to: envelopeParty(routing, "To", "ToVAC"),
    messages,
  };
}

function parseSummaryCount(container: XmlElement): SummaryResultCount {
  const detail = firstDirectElement(container, "ResultDetailType");
  return {
    count: Number(childText(detail, "Count")),
    invoices: elements(detail, "Invoice").map((invoice) => ({
      referenceNumber: childText(invoice, "ReferenceNumber"),
      invoiceDate: childText(invoice, "InvoiceDate"),
    })),
  };
}

export interface ParsedInvoiceEnvelope {
  messageType: MessageType;
  count: number;
  from: PartyInfo;
  to: PartyInfo;
  documents: string[];
}

export function tryParseInvoiceEnvelope(xml: string): ParsedInvoiceEnvelope | null {
  if (UNSAFE_XML.test(xml)) {
    throw new AdapterError("TW_INBOUND_UNSAFE_XML", "Inbound envelope contains DOCTYPE or ENTITY");
  }
  const document = parseXml(xml, "TW_INBOUND_NOT_WELL_FORMED");
  const root = document.documentElement;
  if (!root || (root.localName || root.nodeName) !== "InvoiceEnvelope") {
    return null;
  }
  if (root.namespaceURI !== "urn:GEINV:InvoiceEnvelope:4.1") {
    throw new AdapterError("TW_INBOUND_ENVELOPE_VERSION_UNSUPPORTED", "Only InvoiceEnvelope 4.1 is supported");
  }
  const pack = firstElement(root, "InvoicePack");
  if (pack.getAttribute("version") !== "v41") {
    throw new AdapterError("TW_INBOUND_ENVELOPE_VERSION_UNSUPPORTED", "InvoicePack version must be v41");
  }
  const messageType = pack.getAttribute("messageType");
  if (!messageTypes.includes(messageType as MessageType)) {
    throw new AdapterError("TW_INBOUND_MESSAGE_TYPE_UNSUPPORTED", `Unsupported inbound message type ${messageType}`);
  }
  const documents = Array.from({ length: pack.childNodes.length }, (_, index) => pack.childNodes.item(index))
    .filter((node): node is XmlElement => node?.nodeType === 1)
    .map((node) => new XMLSerializer().serializeToString(node));
  const declaredCount = Number(pack.getAttribute("count"));
  if (!Number.isInteger(declaredCount) || declaredCount !== documents.length || documents.length === 0) {
    throw new AdapterError(
      "TW_INBOUND_ENVELOPE_COUNT_INVALID",
      `InvoiceEnvelope declares ${pack.getAttribute("count")} documents but contains ${documents.length}`,
    );
  }
  return {
    messageType: messageType as MessageType,
    count: documents.length,
    from: envelopeParty(root, "From", "FromVAC"),
    to: envelopeParty(root, "To", "ToVAC"),
    documents,
  };
}

function envelopeParty(root: XmlElement, partyName: string, routingName: string): PartyInfo {
  const party = firstElement(root, partyName);
  const routing = firstElement(root, routingName);
  return {
    partyId: childText(party, "PartyId"),
    description: childText(party, "Description"),
    routingId: childText(routing, "RoutingId"),
    routingDescription: childText(routing, "Description"),
  };
}

function firstElement(parent: XmlDocument | XmlElement, localName: string): XmlElement {
  const element = parent.getElementsByTagNameNS("*", localName).item(0);
  if (!element) {
    throw new AdapterError("TW_RESULT_MISSING_ELEMENT", `Missing ${localName}`);
  }
  return element;
}

function firstDirectElement(parent: XmlElement, localName: string): XmlElement {
  const element = Array.from({ length: parent.childNodes.length }, (_, index) => parent.childNodes.item(index)).find(
    (node): node is XmlElement => node?.nodeType === 1 && (node.localName || node.nodeName.replace(/^.*:/u, "")) === localName,
  );
  if (!element) {
    throw new AdapterError("TW_RESULT_MISSING_ELEMENT", `Missing ${localName}`);
  }
  return element;
}

function elements(parent: XmlDocument | XmlElement, localName: string): XmlElement[] {
  const nodes = parent.getElementsByTagNameNS("*", localName);
  return Array.from({ length: nodes.length }, (_, index) => nodes.item(index)).filter(
    (node): node is XmlElement => node !== null,
  );
}

function childText(parent: XmlElement, localName: string): string {
  return parent.getElementsByTagNameNS("*", localName).item(0)?.textContent?.trim() ?? "";
}

function parseXml(xml: string, code: string): XmlDocument {
  const parserErrors: string[] = [];
  const document = new DOMParser({
    onError: (level, message) => {
      if (level === "error" || level === "fatalError") {
        parserErrors.push(message);
      }
    },
  }).parseFromString(xml, "application/xml");
  if (parserErrors.length > 0 || !document.documentElement) {
    throw new AdapterError(code, parserErrors.join("; ") || "XML has no document element");
  }
  return document;
}
