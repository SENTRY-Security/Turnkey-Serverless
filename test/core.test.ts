import { describe, expect, it } from "vitest";
import {
  buildInvoiceEnvelope,
  classifyInboundFilename,
  createTurnkeyFilename,
  financeSubmissionSchema,
  parseProcessResult,
  parseResultFilename,
  parseSummaryResult,
  resolveProcessResult,
  tryParseInvoiceEnvelope,
} from "../src/core/index.js";

describe("Turnkey core contract", () => {
  it("uses the exact remote common-name format expected by Turnkey", () => {
    const uuid = "5e3eb9a7-17e7-4ab7-b123-b17e9a40fb89";
    const filename = createTurnkeyFilename({
      messageType: "A0101",
      messageDts: "20260810123456789",
      uuid,
    });
    expect(filename).toBe(`v41-A0101-20260810-123456789-${uuid}`);
    expect(parseResultFilename(`${filename}.ProcessResult`)).toEqual({
      version: "v41",
      messageType: "A0101",
      messageDts: "20260810123456789",
      uuid,
      resultType: "ProcessResult",
    });
    expect(
      classifyInboundFilename(`v41-Z9999-20260810-123456789-${uuid}.ProcessResult`).kind,
    ).toBe("UNKNOWN");
    expect(classifyInboundFilename(`v41-F0401-20260810-123456789-${uuid}`).kind).toBe("UNKNOWN");
  });

  it("classifies every Turnkey inbound filename family", () => {
    const uuid = "5e3eb9a7-17e7-4ab7-b123-b17e9a40fb89";
    expect(classifyInboundFilename(`v41-A0101-20260810-123456789-${uuid}.Ack`).kind).toBe("ACK");
    expect(classifyInboundFilename("v41-12345678-20260810-123456789.E0502")).toMatchObject({
      kind: "E05",
      value: { messageType: "E0502", partyId: "12345678" },
    });
    expect(
      classifyInboundFilename("1_A_12345678_11508_20260810123456_001_001.zip.E0504"),
    ).toMatchObject({ kind: "E0504", value: { sellerPartyId: "12345678", rocYearMonth: "11508" } });
    expect(
      classifyInboundFilename("12345678-EINVCT01-87654321-EINVCT02-20260809-20260810010000000-8.SummaryResult"),
    ).toMatchObject({
      kind: "SUMMARY_RESULT",
      value: { transmissionDate: "20260809", count: 8 },
    });
    expect(
      classifyInboundFilename("12345678_EINVCT01_0000000000_0_20260809_20260810010000000-Final.SummaryResult"),
    ).toMatchObject({
      kind: "SUMMARY_RESULT",
      value: { transmissionDate: "20260809", count: null, final: true },
    });
  });

  it("packs source documents without leaking an XML declaration into the envelope", () => {
    const envelope = buildInvoiceEnvelope({
      messageType: "A0101",
      from: {
        partyId: "12345678",
        description: "賣方",
        routingId: "FROM-ROUTE",
        routingDescription: "送方繞送",
      },
      to: {
        partyId: "87654321",
        description: "買方",
        routingId: "TO-ROUTE",
        routingDescription: "收方繞送",
      },
      documents: [
        {
          externalDocumentId: "INV-1",
          sourceFilename: "invoice.xml",
          invoiceIdentifier: "AB12345678",
          xml: '<?xml version="1.0"?><Invoice xmlns="urn:GEINV:eInvoiceMessage:A0101:4.1"><Main/></Invoice>',
        },
      ],
    });
    expect(envelope.match(/<\?xml/gu)).toHaveLength(1);
    expect(envelope).toContain('<InvoicePack messageType="A0101" count="1" version="v41">');
    expect(envelope).toContain("<PartyId>12345678</PartyId>");
  });

  it("requires platform credentials and a PFX in every submission", () => {
    const result = financeSubmissionSchema.safeParse({
      contractVersion: "1",
      country: "TW",
      tenantId: "tenant",
      legalEntityId: "entity",
      externalBatchId: "batch",
      idempotencyKey: "idem-key-123",
      messageType: "A0101",
      categoryType: "B2B",
      processType: "STORAGE",
      documents: [{ externalDocumentId: "1", xml: "<Invoice>long-enough-placeholder</Invoice>" }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects inbound-only message types and multi-document B2B exchange requests", () => {
    const request = {
      contractVersion: "1",
      country: "TW",
      tenantId: "tenant",
      legalEntityId: "entity",
      externalBatchId: "batch",
      idempotencyKey: "idem-key-123",
      messageType: "E0501",
      categoryType: "B2B",
      processType: "EXCHANGE",
      toPartyId: "87654321",
      credentials: {
        transport: { loginId: "account", loginPassword: "password" },
        signing: { format: "PFX", pfxBase64: "QUFBQUFBQUFBQUFBQUFBQUFB", password: "pfx" },
      },
      documents: [
        { externalDocumentId: "1", xml: "<Invoice>long-enough-placeholder</Invoice>" },
        { externalDocumentId: "2", xml: "<Invoice>long-enough-placeholder</Invoice>" },
      ],
    };
    const inboundType = financeSubmissionSchema.safeParse(request);
    expect(inboundType.success).toBe(false);
    const multiple = financeSubmissionSchema.safeParse({ ...request, messageType: "A0101" });
    expect(multiple.success).toBe(false);
  });

  it("enforces the MIG 4.1 message/category/process matrix", () => {
    const base = {
      contractVersion: "1",
      country: "TW",
      tenantId: "tenant",
      legalEntityId: "entity",
      externalBatchId: "batch",
      idempotencyKey: "idem-key-123",
      credentials: {
        transport: { loginId: "account", loginPassword: "password" },
        signing: { format: "PFX", pfxBase64: "QUFBQUFBQUFBQUFBQUFBQUFB", password: "pfx" },
      },
      documents: [{ externalDocumentId: "1", xml: "<Invoice>long-enough-placeholder</Invoice>" }],
    };
    expect(
      financeSubmissionSchema.safeParse({
        ...base,
        messageType: "A0101",
        categoryType: "B2B",
        processType: "EXCHANGE",
        toPartyId: "87654321",
      }).success,
    ).toBe(true);
    expect(
      financeSubmissionSchema.safeParse({
        ...base,
        messageType: "E0401",
        categoryType: "B2P",
        processType: "MESSAGE",
      }).success,
    ).toBe(true);
    expect(
      financeSubmissionSchema.safeParse({
        ...base,
        messageType: "G0701",
        categoryType: "B2S",
        processType: "STORAGE",
      }).success,
    ).toBe(true);
    expect(
      financeSubmissionSchema.safeParse({
        ...base,
        messageType: "F0401",
        categoryType: "B2C",
        processType: "STORAGE",
      }).success,
    ).toBe(false);
    expect(
      financeSubmissionSchema.safeParse({
        ...base,
        messageType: "E0402",
        categoryType: "B2P",
        processType: "MESSAGE",
        toPartyId: "87654321",
      }).success,
    ).toBe(false);
  });

  it("recognizes a verified inbound InvoiceEnvelope for the Finance event boundary", () => {
    const xml = `<?xml version="1.0"?>
      <InvoiceEnvelope xmlns="urn:GEINV:InvoiceEnvelope:4.1">
        <From><PartyId>87654321</PartyId><Description>供應商</Description></From>
        <FromVAC><RoutingId>FROM</RoutingId></FromVAC>
        <To><PartyId>12345678</PartyId><Description>本公司</Description></To>
        <ToVAC><RoutingId>TO</RoutingId></ToVAC>
        <InvoicePack messageType="A0101" count="1" version="v41">
          <Invoice xmlns="urn:GEINV:eInvoiceMessage:A0101:4.1"><Main/></Invoice>
        </InvoicePack>
      </InvoiceEnvelope>`;
    const parsed = tryParseInvoiceEnvelope(xml);
    expect(parsed).toMatchObject({
      messageType: "A0101",
      count: 1,
      from: { partyId: "87654321", routingId: "FROM" },
      to: { partyId: "12345678", routingId: "TO" },
    });
    expect(parsed?.documents[0]).toContain("urn:GEINV:eInvoiceMessage:A0101:4.1");
  });

  it("maps partial ProcessResult errors to the original document record", () => {
    const xml = `
      <ProcessResult xmlns="urn:GEINV:ProcessResult:4.1">
        <RoutingInfo><From><PartyId>0</PartyId></From><FromVAC><RoutingId>0</RoutingId></FromVAC><To><PartyId>0</PartyId></To><ToVAC><RoutingId>0</RoutingId></ToVAC></RoutingInfo>
        <MessageInfo><Id>id</Id><Size>1</Size><MessageType>F0401</MessageType><Service>S</Service><Action>B2C</Action></MessageInfo>
        <Result><Info><Code>E0102</Code><Description>No. 2 invoice invalid</Description><Parameter0>AB12345678</Parameter0><Parameter1>20260810</Parameter1></Info></Result>
      </ProcessResult>`;
    const result = parseProcessResult(xml);
    const resolved = resolveProcessResult(result, [
      { documentIndex: 0, invoiceIdentifier: "F0401AA1234567820260810" },
      { documentIndex: 1, invoiceIdentifier: "F0401AB1234567820260810" },
      { documentIndex: 2, invoiceIdentifier: "F0401AC1234567820260810" },
    ]);
    expect(resolved.status).toBe("PARTIALLY_REJECTED");
    expect(resolved.outcomes.map((outcome) => outcome.status)).toEqual(["CONFIRMED", "REJECTED", "CONFIRMED"]);
  });

  it("parses the signed daily SummaryResult detail document", () => {
    const xml = `
      <SummaryResult xmlns="urn:GEINV:SummaryResult:4.1">
        <RoutingInfo><From><PartyId>12345678</PartyId></From><FromVAC><RoutingId>FROM</RoutingId></FromVAC><To><PartyId>0000000000</PartyId></To><ToVAC><RoutingId>0</RoutingId></ToVAC></RoutingInfo>
        <DetailList><Message>
          <Info><Id>batch</Id><Size>99</Size><MessageType>F0401</MessageType><Service>S</Service><Action>B2C</Action></Info>
          <ResultType>
            <Total><ResultDetailType><Count>2</Count></ResultDetailType></Total>
            <Good><ResultDetailType><Count>1</Count><Invoices><Invoice><ReferenceNumber>AB12345678</ReferenceNumber><InvoiceDate>20260809</InvoiceDate></Invoice></Invoices></ResultDetailType></Good>
            <Failed><ResultDetailType><Count>1</Count><Invoices><Invoice><ReferenceNumber>AC12345678</ReferenceNumber><InvoiceDate>20260809</InvoiceDate></Invoice></Invoices></ResultDetailType></Failed>
          </ResultType>
        </Message></DetailList>
      </SummaryResult>`;
    expect(parseSummaryResult(xml)).toMatchObject({
      from: { partyId: "12345678", routingId: "FROM" },
      messages: [{ messageType: "F0401", total: { count: 2 }, good: { count: 1 }, failed: { count: 1 } }],
    });
  });
});
