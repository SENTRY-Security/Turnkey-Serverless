import { describe, expect, it } from "vitest";
import { validateBusinessRules } from "../src/egress/business-rules.js";
import { schemaPath } from "../src/egress/xml-validator.js";
import { gatewayUrl, selectTradingPartnerRoute } from "../src/egress/gateway.js";

describe("Gateway 3.1.3 program-rule parity", () => {
  it("enforces the date pairs used by confirmation and cancellation messages", () => {
    const a0102 = `
      <InvoiceConfirm xmlns="urn:GEINV:eInvoiceMessage:A0102:4.1">
        <InvoiceNumber>AB12345678</InvoiceNumber><InvoiceDate>20260810</InvoiceDate>
      </InvoiceConfirm>`;
    expect(validateBusinessRules("A0102", a0102, [])).toEqual({
      code: "7001",
      message: "ReceiveDate is required",
    });
    const f0501 = `
      <CancelInvoice xmlns="urn:GEINV:eInvoiceMessage:F0501:4.1">
        <CancelInvoiceNumber>AB12345678</CancelInvoiceNumber><InvoiceDate>20260810</InvoiceDate>
      </CancelInvoice>`;
    expect(validateBusinessRules("F0501", f0501, [])).toEqual({
      code: "7001",
      message: "CancelDate is required",
    });
  });

  it("does not apply a cross-border sender rejection to A0102, matching the official validator", () => {
    const xml = `
      <InvoiceConfirm xmlns="urn:GEINV:eInvoiceMessage:A0102:4.1">
        <InvoiceNumber>AB12345678</InvoiceNumber><InvoiceDate>20260810</InvoiceDate>
        <BuyerId>87654321</BuyerId><SellerId>12345678</SellerId><ReceiveDate>20260810</ReceiveDate>
      </InvoiceConfirm>`;
    expect(validateBusinessRules("A0102", xml, ["12345678"])).toBeNull();
  });

  it("matches the official cross-border checks for unconditional and consumer-only message families", () => {
    const a0201 = `
      <CancelInvoice xmlns="urn:GEINV:eInvoiceMessage:A0201:4.1">
        <CancelInvoiceNumber>AB12345678</CancelInvoiceNumber><InvoiceDate>20260810</InvoiceDate>
        <BuyerId>0000000000</BuyerId><SellerId>12345678</SellerId><CancelDate>20260810</CancelDate>
      </CancelInvoice>`;
    expect(validateBusinessRules("A0201", a0201, ["12345678"])?.message).toContain("Cross-border");

    const f0501 = `
      <CancelInvoice xmlns="urn:GEINV:eInvoiceMessage:F0501:4.1">
        <CancelInvoiceNumber>AB12345678</CancelInvoiceNumber><InvoiceDate>20260810</InvoiceDate>
        <BuyerId>0000000000</BuyerId><SellerId>12345678</SellerId><CancelDate>20260810</CancelDate>
      </CancelInvoice>`;
    expect(validateBusinessRules("F0501", f0501, ["12345678"])).toBeNull();
  });

  it("checks integer F0401 amounts only for consumer invoices, as Gateway 3.1.3 does", () => {
    const xml = `
      <Invoice xmlns="urn:GEINV:eInvoiceMessage:F0401:4.1">
        <Main>
          <InvoiceDate>20260810</InvoiceDate><PrintMark>Y</PrintMark><DonateMark>0</DonateMark>
          <Seller><Identifier>12345678</Identifier><Address>台北市</Address></Seller>
          <Buyer><Identifier>87654321</Identifier><Name>買方</Name></Buyer>
        </Main>
        <Details><ProductItem><TaxType>1</TaxType></ProductItem></Details>
        <Amount><SalesAmount>1.5</SalesAmount><FreeTaxSalesAmount>0</FreeTaxSalesAmount><ZeroTaxSalesAmount>0</ZeroTaxSalesAmount><TaxAmount>0</TaxAmount><TotalAmount>1.5</TotalAmount><TaxType>1</TaxType></Amount>
      </Invoice>`;
    expect(validateBusinessRules("F0401", xml, [])).toBeNull();
  });

  it("allows every signed inbound common schema through the fixed allowlist", () => {
    expect(schemaPath("/xsd", "common/v41/ProcessResult")).toBe("/xsd/common/v41/ProcessResult.xsd");
    expect(schemaPath("/xsd", "common/v41/SummaryResult")).toBe("/xsd/common/v41/SummaryResult.xsd");
    expect(schemaPath("/xsd", "common/v41/E0504")).toBe("/xsd/common/v41/E0504.xsd");
  });

  it("keeps the configured /gateway/api base path for all pfs endpoints", () => {
    expect(
      gatewayUrl("https://tgw.einvoice.nat.gov.tw/gateway/api", "/pfs001i/uploadInvoiceMessage").toString(),
    ).toBe("https://tgw.einvoice.nat.gov.tw/gateway/api/pfs001i/uploadInvoiceMessage");
  });

  it("selects only the pfs002 default receiving route", () => {
    expect(
      selectTradingPartnerRoute({
        defaultRoutingId: "EINVCT02",
        dtpData: [
          { id: "EINVCT01", description: "not default" },
          { id: "EINVCT02", description: "default route" },
        ],
      }),
    ).toEqual({ routingId: "EINVCT02", description: "default route" });
    expect(selectTradingPartnerRoute({ defaultRoutingId: "EINVCT99A", dtpData: [] })).toBeNull();
  });
});
