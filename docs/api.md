# Finance → Taiwan adapter API

所有 `/v1/*` 路由使用：

```http
Authorization: Bearer <ADAPTER_API_KEY>
Content-Type: application/json
```

回應不會回傳平台帳密、PFX、PFX 密碼或 R2 credential object key。

## 1. 設定台灣營業人 adapter account

```http
PUT /v1/accounts
```

```json
{
  "id": "tenant-a-tw-12345678",
  "tenantId": "tenant-a",
  "legalEntityId": "tw-company-a",
  "companyBan": "12345678",
  "companyName": "範例股份有限公司",
  "routingId": "REPLACE_WITH_FROM_ROUTING_ID",
  "routingDescription": "範例送方",
  "egressProfile": "tw-test-company",
  "platformEnvironment": "TEST",
  "active": true
}
```

建立或更新 account 時，Worker 會向 Linode egress 驗證該 profile 宣告的 `environment`；若與 `platformEnvironment` 不一致，請求會被拒絕。

## 2. 提交批次

```http
POST /v1/submissions
```

PFX 必須先轉成不含換行的標準 Base64：

```bash
base64 < signing.pfx | tr -d '\n'
```

```json
{
  "contractVersion": "1",
  "country": "TW",
  "tenantId": "tenant-a",
  "legalEntityId": "tw-company-a",
  "externalBatchId": "finance-batch-20260810-001",
  "idempotencyKey": "tenant-a:finance-batch-20260810-001",
  "messageType": "A0101",
  "categoryType": "B2B",
  "processType": "EXCHANGE",
  "toPartyId": "87654321",
  "credentials": {
    "transport": {
      "loginId": "MOF_PLATFORM_ACCOUNT",
      "loginPassword": "MOF_PLATFORM_PASSWORD"
    },
    "signing": {
      "format": "PFX",
      "pfxBase64": "BASE64_OF_PFX_FILE",
      "password": "PFX_PASSWORD"
    },
    "leaseSeconds": 604800
  },
  "documents": [
    {
      "externalDocumentId": "invoice-001",
      "sourceFilename": "A0101-001.xml",
      "xml": "<?xml version=\"1.0\" encoding=\"UTF-8\"?><Invoice xmlns=\"urn:GEINV:eInvoiceMessage:A0101:4.1\">...</Invoice>"
    }
  ],
  "metadata": {
    "financeJournalId": "journal-001"
  }
}
```

`leaseSeconds` 範圍為 300 秒至 30 天，預設 7 天。提交回傳 `202`；同一 legal entity + `idempotencyKey` 會回傳原提交，不會重送。

`EXCHANGE` 僅允許 `categoryType: "B2B"` 且只能包含一張文件。所有 submission 的來源 XML 合計不得超過 15,000,000 bytes、文件數不得超過 1000；`E0501`～`E0504` 是 inbound-only，提交會被拒絕。

MIG 4.1 的合法組合會在 API 邊界強制驗證：

- `A0101`～`B0202` 十種 B2B 交換訊息：`categoryType: "B2B"`、`processType: "EXCHANGE"`，且必須提供 `toPartyId`；
- `E0401/E0402` 配號訊息：`categoryType: "B2P"`、`processType: "MESSAGE"`；
- `F0401/F0501/F0701/G0401/G0501/G0701` 存證訊息：`categoryType: "B2S"`、`processType: "STORAGE"`。

非 EXCHANGE 請求不得提供 `toPartyId`，其平台收方固定封裝為 `00000000`／routing `0`。

## 3. 更新 credential lease

即使沒有新發票，也可延長收件輪詢所需的憑證租約：

```http
POST /v1/accounts/{accountId}/credential-lease
```

Body 就是提交中的 `credentials` 物件。這會更新 account 的最新租約；若舊 submission 的租約已到期，重試時也會改用該 account 最新有效租約。

## 4. 查詢與重試

```http
GET  /v1/submissions/{submissionId}
GET  /v1/submissions/{submissionId}/documents
POST /v1/submissions/{submissionId}/retry
GET  /v1/submissions/{submissionId}/artifacts/source
GET  /v1/submissions/{submissionId}/artifacts/envelope
GET  /v1/submissions/{submissionId}/artifacts/signed
GET  /v1/submissions/{submissionId}/artifacts/result
GET  /v1/inbound-files/{inboundFileId}/artifact
POST /v1/accounts/{accountId}/gateway/version-info
POST /v1/accounts/{accountId}/gateway/error-messages
```

`documents` 路由回傳每張原始 Finance `externalDocumentId` 對應的 `CONFIRMED`／`REJECTED`、財政部錯誤碼與說明；Finance 不需要自行解析台灣 ProcessResult XML。

後兩個診斷路由分別轉送 Gateway `pfs004` 與 `pfs005`，也使用 account 最新有效 credential lease。

主要狀態：`RECEIVED → VALIDATING → VALIDATED → PACKED → SIGNED → SFTP_UPLOADED → API_ACCEPTED → WAITING_RESULT → CONFIRMED`。錯誤終態為 `PARTIALLY_REJECTED`、`REJECTED` 或 `FAILED`。收到交換發票或 E050x 時會發布 `INBOUND_DOCUMENTS_RECEIVED`；收到 `.Ack` 發布 `INBOUND_ACK_RECEIVED`；收到每日對帳檔發布 `SUMMARY_RESULT_RECEIVED`。Finance 可用 `inboundFileId` 取得驗簽後的 InvoiceEnvelope／XML；E0504 artifact 是含解密 ZIP entries 的 JSON。

暫時性 inbound 錯誤會保留 R2 原檔、標記 `FAILED` 並留在財政部 SFTP 等待重試；已確認為永久性的驗簽、解密、XSD 或格式錯誤，則在 R2 保存原始 bytes 與 SHA-256 後標記 `QUARANTINED` 並刪除 SFTP 原檔，避免 poison file 阻塞後續檔案。兩種情況都不阻塞同批其他檔案。

## Finance event queue

Adapter 發送與全球 Finance 無關的台灣實作細節不會進入核心模型；只發布標準 country adapter event：

```json
{
  "contractVersion": "1",
  "eventType": "SUBMISSION_STATUS_CHANGED",
  "adapter": "tw-mof-einvoice",
  "country": "TW",
  "tenantId": "tenant-a",
  "legalEntityId": "tw-company-a",
  "submissionId": "...",
  "externalBatchId": "finance-batch-20260810-001",
  "status": "CONFIRMED",
  "occurredAt": "2026-08-10T12:00:00.000Z",
  "data": {}
}
```

Cloudflare Queue 為 at-least-once delivery；consumer 必須以 `eventId` 去重。Submission event ID 由 submission、status 與該狀態的 `updatedAt` 組成；inbound event ID 由 `inboundFileId + eventType` 組成，因此同一步驟重送仍具有相同 ID。
