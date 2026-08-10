import { DOMParser, type Element as XmlElement } from "@xmldom/xmldom";
import type { MessageType } from "../core/index.js";

export interface BusinessRuleFailure {
  code: "7001";
  message: string;
}

export function validateBusinessRules(
  messageType: MessageType,
  xml: string,
  crossBorderSellerIds: string[],
): BusinessRuleFailure | null {
  const document = new DOMParser().parseFromString(xml, "application/xml");
  const crossBorder = new Set(crossBorderSellerIds);
  const root = document.documentElement;
  if (!root) {
    return failure("XML document has no root element");
  }

  const party = partyIds(messageType, root);
  if (
    party.sellerId &&
    crossBorder.has(party.sellerId) &&
    (crossBorderAlwaysRejectedTypes.has(messageType) ||
      (crossBorderBusinessBuyerRejectedTypes.has(messageType) && !isConsumer(party.buyerId)))
  ) {
    return failure("Cross-border e-commerce suppliers cannot upload B2B electronic invoices");
  }

  switch (messageType) {
    case "A0101":
      return validateA0101(root);
    case "A0102":
      return requireFields(root, ["InvoiceDate", "ReceiveDate"]);
    case "A0201":
    case "A0202":
      return requireFields(root, ["InvoiceDate", "CancelDate"]);
    case "A0301":
    case "A0302":
      return requireFields(root, ["InvoiceDate", "RejectDate"]);
    case "B0101":
      return validateB0101(root);
    case "B0102":
      return requireFields(root, ["AllowanceDate", "ReceiveDate"]);
    case "B0201":
    case "B0202":
      return requireFields(root, ["AllowanceDate", "CancelDate"]);
    case "E0401":
      return requireList(root, "BranchTrackItem");
    case "E0402":
      return requireList(root, "BranchTrackBlankItem");
    case "F0401":
      return validateF0401(root, crossBorder);
    case "F0501":
      return requireFields(root, ["InvoiceDate", "CancelDate"]);
    case "F0701":
      return requireFields(root, ["InvoiceDate", "VoidDate"]);
    case "G0401":
      return validateG0401(root, crossBorder);
    case "G0501":
      return requireFields(root, ["AllowanceDate", "CancelDate"]);
    default:
      return null;
  }
}

const crossBorderAlwaysRejectedTypes = new Set<MessageType>([
  "A0101",
  "A0201",
  "A0202",
  "A0301",
  "A0302",
  "B0102",
  "B0201",
  "B0202",
]);

const crossBorderBusinessBuyerRejectedTypes = new Set<MessageType>([
  "B0101",
  "F0401",
  "F0501",
  "F0701",
  "G0401",
  "G0501",
]);

function validateA0101(root: XmlElement): BusinessRuleFailure | null {
  const main = directElement(root, "Main");
  const amount = directElement(root, "Amount");
  const seller = directElement(main, "Seller");
  const structural = requireAmountAndProducts(root, "InvoiceDate");
  if (structural) {
    return structural;
  }
  if (!text(seller, "Address")) {
    return failure("Seller.Address is required");
  }
  if (text(amount, "TaxType") === "2" && (!text(main, "CustomsClearanceMark") || !text(main, "ZeroTaxRateReason"))) {
    return failure("CustomsClearanceMark and ZeroTaxRateReason are required when TaxType is 2");
  }
  if (text(amount, "TaxType") === "9" || allText(root, "ProductItem", "TaxType").includes("9")) {
    return failure("TaxType 9 is not accepted for A0101");
  }
  return null;
}

function validateB0101(root: XmlElement): BusinessRuleFailure | null {
  const main = directElement(root, "Main");
  const structural = requireAmountAndProducts(root, "AllowanceDate");
  if (structural) {
    return structural;
  }
  if (text(main, "AllowanceType") !== "2") {
    return failure("MIG 4.1 B0101 can only be sent by the seller (AllowanceType must be 2)");
  }
  return requireOriginalInvoiceDates(root);
}

function validateG0401(root: XmlElement, crossBorder: Set<string>): BusinessRuleFailure | null {
  const main = directElement(root, "Main");
  const buyer = directElement(main, "Buyer");
  const structural = requireAmountAndProducts(root, "AllowanceDate");
  if (structural) {
    return structural;
  }
  if (text(main, "AllowanceType") === "1") {
    const buyerId = text(buyer, "Identifier");
    if (isConsumer(buyerId)) {
      return failure("Buyer.Identifier must be a company BAN when AllowanceType is 1");
    }
    if (crossBorder.has(buyerId)) {
      return failure("Cross-border e-commerce suppliers cannot be the buyer for AllowanceType 1");
    }
  }
  return requireOriginalInvoiceDates(root);
}

function validateF0401(root: XmlElement, crossBorder: Set<string>): BusinessRuleFailure | null {
  const main = directElement(root, "Main");
  const seller = directElement(main, "Seller");
  const buyer = directElement(main, "Buyer");
  const amount = directElement(root, "Amount");
  const sellerId = text(seller, "Identifier");
  const buyerId = text(buyer, "Identifier");
  const printMark = text(main, "PrintMark").toUpperCase();
  const donateMark = text(main, "DonateMark");
  const carrierType = text(main, "CarrierType");
  const carrierId1 = text(main, "CarrierId1");
  const carrierId2 = text(main, "CarrierId2");
  const npoBan = text(main, "NPOBAN");

  const structural = requireAmountAndProducts(root, "InvoiceDate");
  if (structural) {
    return structural;
  }

  if (!text(seller, "Address")) {
    return failure("Seller.Address is required");
  }
  if (buyerId && !/^\d*$/u.test(buyerId)) {
    return failure("Buyer.Identifier must contain only digits");
  }
  if (isConsumer(buyerId)) {
    const buyerName = text(buyer, "Name");
    if (/^0{1,4}$/u.test(buyerName)) {
      return failure("Buyer.Name cannot contain only zeroes");
    }
    const randomNumber = text(main, "RandomNumber");
    if (randomNumber && (/^\D+$/u.test(randomNumber) || /^\d{5,}$/u.test(randomNumber))) {
      return failure("RandomNumber must contain at most four digits");
    }
  }

  if (crossBorder.has(sellerId)) {
    if (!text(amount, "Currency")) {
      return failure("Currency is required for a cross-border seller");
    }
    if (printMark !== "N") {
      return failure("PrintMark must be N for a cross-border seller");
    }
  }

  if (isConsumer(buyerId) && (!crossBorder.has(sellerId) || text(amount, "Currency") === "TWD")) {
    for (const field of ["SalesAmount", "FreeTaxSalesAmount", "ZeroTaxSalesAmount", "TaxAmount", "TotalAmount"] as const) {
      if (!isIntegerDecimal(text(amount, field))) {
        return failure(`${field} must be an integer for a TWD invoice`);
      }
    }
  }

  if (printMark === "Y") {
    if (carrierType === "3J0002") {
      if (!isCompanyBan(buyerId)) {
        return failure("Buyer.Identifier must be a company BAN for printed 3J0002 carrier invoices");
      }
      if (!carrierId1 || !carrierId2) {
        return failure("CarrierId1 and CarrierId2 are required for CarrierType 3J0002");
      }
    } else if (carrierId1 || carrierId2) {
      return failure("CarrierId1 and CarrierId2 must be empty when PrintMark is Y");
    }
    if (donateMark !== "0") {
      return failure("DonateMark must be 0 when PrintMark is Y");
    }
  }
  if (printMark === "N") {
    if (donateMark !== "1" && (!carrierType || !carrierId1 || !carrierId2)) {
      return failure("CarrierType, CarrierId1 and CarrierId2 are required when PrintMark is N and the invoice is not donated");
    }
    if (hasEdgeWhitespace(carrierId1) || hasEdgeWhitespace(carrierId2)) {
      return failure("CarrierId1 and CarrierId2 cannot have leading or trailing spaces");
    }
  }
  if (carrierType === "3J0002" && (!carrierId1 || !carrierId2)) {
    return failure("CarrierId1 and CarrierId2 are both required for CarrierType 3J0002");
  }
  if (donateMark === "1" && !npoBan) {
    return failure("NPOBAN is required when DonateMark is 1");
  }
  if (donateMark === "0" && npoBan) {
    return failure("NPOBAN must be empty when DonateMark is 0");
  }
  if (text(amount, "TaxType") === "2" && (!text(main, "CustomsClearanceMark") || !text(main, "ZeroTaxRateReason"))) {
    return failure("CustomsClearanceMark and ZeroTaxRateReason are required when TaxType is 2");
  }
  if (allText(root, "ProductItem", "TaxType").includes("9")) {
    return failure("TaxType 9 is not accepted in F0401 ProductItem");
  }
  return null;
}

function partyIds(messageType: MessageType, root: XmlElement): { sellerId: string; buyerId: string } {
  if (["A0101", "B0101", "F0401", "G0401"].includes(messageType)) {
    const main = directElement(root, "Main");
    return {
      sellerId: text(directElement(main, "Seller"), "Identifier"),
      buyerId: text(directElement(main, "Buyer"), "Identifier"),
    };
  }
  return {
    sellerId: text(root, "SellerId"),
    buyerId: text(root, "BuyerId"),
  };
}

function requireOriginalInvoiceDates(root: XmlElement): BusinessRuleFailure | null {
  const products = elements(root, "ProductItem");
  const missing = products.find((product) => !text(product, "OriginalInvoiceDate"));
  return missing
    ? failure(`OriginalInvoiceDate is required for ${text(missing, "OriginalInvoiceNumber") || "each product item"}`)
    : null;
}

function requireList(root: XmlElement, itemName: string): BusinessRuleFailure | null {
  return elements(root, itemName).length > 0 ? null : failure(`${itemName} list cannot be empty`);
}

function requireAmountAndProducts(root: XmlElement, dateField: string): BusinessRuleFailure | null {
  if (elements(root, "Amount").length === 0) {
    return failure("AmountType is null");
  }
  if (!text(root, dateField)) {
    return failure(`${dateField} is required`);
  }
  if (elements(root, "Details").length === 0) {
    return failure("Details is null");
  }
  return elements(root, "ProductItem").length > 0 ? null : failure("ProductItemList is empty");
}

function requireFields(root: XmlElement, fields: string[]): BusinessRuleFailure | null {
  const missing = fields.find((field) => !text(root, field));
  return missing ? failure(`${missing} is required`) : null;
}

function directElement(parent: XmlElement, localName: string): XmlElement {
  const element = Array.from({ length: parent.childNodes.length }, (_, index) => parent.childNodes.item(index)).find(
    (node): node is XmlElement => node?.nodeType === 1 && (node.localName || node.nodeName) === localName,
  );
  return element ?? parent;
}

function elements(parent: XmlElement, localName: string): XmlElement[] {
  const nodes = parent.getElementsByTagNameNS("*", localName);
  return Array.from({ length: nodes.length }, (_, index) => nodes.item(index)).filter(
    (node): node is XmlElement => node !== null,
  );
}

function text(parent: XmlElement, localName: string): string {
  return parent.getElementsByTagNameNS("*", localName).item(0)?.textContent?.trim() ?? "";
}

function allText(root: XmlElement, parentName: string, childName: string): string[] {
  return elements(root, parentName).map((parent) => text(parent, childName));
}

function isConsumer(value: string): boolean {
  return value.replaceAll("0", "").replaceAll(/\s/gu, "").length === 0;
}

function isCompanyBan(value: string): boolean {
  return !isConsumer(value) && /^\d{8}$/u.test(value);
}

function isIntegerDecimal(value: string): boolean {
  return /^-?\d+(?:\.0+)?$/u.test(value);
}

function hasEdgeWhitespace(value: string): boolean {
  return value.length > 0 && /^[\s\u3000]|[\s\u3000]$/u.test(value);
}

function failure(message: string): BusinessRuleFailure {
  return { code: "7001", message };
}
