# Turnkey 3.2.1 軟體憑證工具：KEY、CSR、CER、PFX 完整操作手冊

這份文件是 `tools/pfx` 的完整離線操作手冊。第一次申請、換發憑證、交接給另一位工程師，或在無網路環境整合 Finance adapter 時，都必須完整閱讀，不能只複製其中一條命令。

工具以本專案取得的 Turnkey 3.2.1 production JAR 行為為規格，重製下列原廠流程：

```text
Step 1 產生 <統編>_<時間>.key
  ↓
Step 2 由同一把 private key 產生 <統編>_<時間>.csr
  ↓
人工向 CA 申請、付款、審核，取得 issued.cer
  ↓
Step 3 以原 .key + issued.cer + 原密碼組成正式 .pfx
  ↓
把 PFX 安全交給 Finance，在 Cloudflare Worker 內做發票 CMS 簽章
```

## 1. 最重要的結論

1. 申請時只交 `.csr`，絕對不要交 `.key`。
2. `.key` 遺失或密碼遺失，CER 核發後也無法製作 PFX；只能重新產生 KEY／CSR 並重新申請。
3. `.key` 不是文字 PEM。它是有密碼的 binary PKCS#12 KeyStore，只是依 Turnkey 慣例使用 `.key` 副檔名。
4. PFX 密碼是在產生 KEY 時自行設定的八碼英數字，不是財政部寄來的「傳送密碼」。
5. CA 核發的 `.cer` 是 public certificate；正式 `.pfx` 才是「CA 憑證 + private key」的可簽章容器。
6. 這個工具只能在受控本機執行，不是 Cloudflare Worker API。它不會呼叫財政部、CA、Cloudflare、Linode 或 Finance。
7. Worker 日常傳送只使用正式 PFX；不需要讀卡機，也不使用 Step 1 的暫時自簽憑證。

## 2. 已驗證的 Turnkey 3.2.1 格式

本工具不是一般化的 OpenSSL CSR generator，而是對齊 Turnkey 3.2.1：

| 項目 | Turnkey 3.2.1 與本工具的固定行為 |
|---|---|
| RSA key size | 2048 bits |
| RSA public exponent | 65537 |
| KEY 檔 | 密碼保護的 PKCS#12 KeyStore，副檔名 `.key` |
| KeyStore alias | 八位統編 |
| KEY 內暫時憑證 | Subject/Issuer 都是 `CN=<統編>`，有效期一年，SHA256withRSA 自簽 |
| CSR 格式 | PEM PKCS#10，副檔名 `.csr` |
| CSR Subject | 只有 `CN=<統編>` |
| CSR requested extension | `extensionRequest` → `keyUsage` → `Digital Signature` |
| CSR signature | SHA256withRSA |
| 正式 PFX | 從原 `.key` 取回 private key，以 CA CER 取代暫時憑證 |

暫時憑證存在是因為 PKCS#12 PrivateKeyEntry 需要 certificate 與 private key 配對；它不是 CA 核發憑證，不能拿去登錄、報稅或正式簽章。

相容性驗證已完成：

- TypeScript 產生的 `.key` 可由 Java `keytool` 開啟，alias、CN、RSA-2048 與 SHA256withRSA 正確。
- 原廠 `cht-kms-core-0.1.0.jar` 的 `PFXKeyStore.load()` 可以直接開啟 TypeScript 產生的 `.key`。
- 原廠函式再從該 `.key` 產生的 CSR，與 TypeScript CSR 的 DER bytes 完全相同；文字檔只可能有 LF／CRLF 換行差異。
- OpenSSL 可驗證 CSR self-signature，並能看到 `Digital Signature` requested key usage。
- PFX 單元測試會再交給 Worker 的 PFX parser 開啟，確認同一把 private key 與 CER 相符。

## 3. 四組完全不同的帳密／識別資料

| 資料 | 來源 | 用途 | 是否交給這個工具 |
|---|---|---|---|
| Turnkey GUI `ADMIN/ADMIN` | 桌面程式預設 | 原 Turnkey 本機管理介面 | 否；serverless adapter 不使用 |
| 傳送帳號／傳送密碼 | 財政部開通信件 | SFTP 與 Gateway 認證 | 否；由 Finance 在 Worker request 提供 |
| 傳送繞送代碼 | 財政部開通信件 | 送方 routing identity | 否；設定為 Finance account 的 `routingId` |
| KEY/PFX 密碼 | 產生 KEY 時由申請人設定 | 開啟 `.key` 和日後正式 `.pfx` | 是；固定八碼 ASCII 英數字 |

務必做到：

- 傳送密碼與 PFX 密碼分開保存，不要當成同一個欄位。
- `ADMIN/ADMIN` 不是財政部傳送帳密。
- 傳送繞送代碼不是密碼，也不是統編；必須原樣保存。

## 4. 執行環境與安裝

需求：

- macOS、Linux 或可執行 Node.js 的受控離線電腦。
- Node.js 22 或以上。
- repository dependencies 已安裝。
- 互動式終端。CLI 不接受無 TTY 的 CI、pipe 或 cron。

在 repository 根目錄執行：

```bash
npm ci
npm run pfx -- help
```

若部署環境只保留編譯結果：

```bash
npm run build:pfx
npm run pfx:built -- help
```

密碼只能在 TTY 隱藏輸入。工具刻意不提供 `--password`、password 環境變數或 pipe input，避免密碼進入 shell history、process list、CI log 或自動化平台紀錄。

## 5. Step 1＋2：產生 Turnkey KEY 與 CSR

將範例統編換成實際八位統編：

```bash
npm run pfx -- request --ban 12345678
```

程式會要求：

```text
設定 KEY/PFX 密碼（恰好 8 碼 ASCII 英數，不顯示）：
再次輸入相同密碼（不顯示）：
```

畫面不會顯示星號，這是正常行為。可使用 `A-Z`、`a-z`、`0-9`，總長必須剛好八碼；不可使用空白、標點、全形英數或中文字。

預設輸出使用本機時間，檔名與原 Turnkey 形式一致：

```text
private/pfx/12345678-20241231115134/
├── 12345678_20241231115134.key
├── 12345678_20241231115134.csr
└── 12345678_20241231115134.request.json
```

三個檔案的用途：

- `.key`：最高敏感資料。內含 RSA private key；保留在本機，不能上傳 CA、寄信或提交 Git。
- `.csr`：公開申請檔。只把這個檔案提交 CA。
- `.request.json`：不含密碼與 private key 的稽核資料，記錄格式、檔名與 SHA-256，方便日後確認配對。

預設輸出目錄位於 `.gitignore` 排除的 `private/`，目錄權限設為 `0700`、檔案設為 `0600`。工具使用 exclusive create，若目標檔案已存在會拒絕覆寫。

正式維運建議指定 repository 外的加密磁碟：

```bash
npm run pfx -- request \
  --ban 12345678 \
  --out-dir /secure/offline-volume/turnkey-12345678
```

### 5.1 立即備份

產生完成後，在離線或嚴格控管的儲存空間保留：

- `.key`
- `.csr`
- `.request.json`
- 八碼 KEY/PFX 密碼（放企業 password manager，不要寫在同一目錄文字檔）
- CA 申請案件編號與付款紀錄

至少建立一份加密備份並實際驗證可讀。不要把 `.key` 放到 Google Drive、一般 Email、Slack、issue attachment 或公開 GitHub repository。若 private key 疑似外洩，應停止流程並重新產生，不要繼續使用。

### 5.2 使用內建功能檢查 KEY

```bash
npm run pfx -- inspect-key \
  --key ./12345678_20241231115134.key
```

輸入同一組八碼密碼後，預期看到：

```json
{
  "alias": "12345678",
  "rsaBits": 2048,
  "placeholderCertificate": {
    "subject": "CN=12345678",
    "issuer": "CN=12345678"
  },
  "privateKeyMatchesCertificate": true
}
```

這個輸出不會顯示 private key 或密碼。

### 5.3 使用 OpenSSL 檢查 CSR

OpenSSL 不是必要依賴，但可獨立交叉驗證：

```bash
openssl req \
  -in ./12345678_20241231115134.csr \
  -noout -subject -text -verify
```

必須看到：

```text
Certificate request self-signature verify OK
Subject: CN=12345678
Public-Key: (2048 bit)
Requested Extensions:
    X509v3 Key Usage:
        Digital Signature
Signature Algorithm: sha256WithRSAEncryption
```

如果 Subject 多出 `C=TW`、`O=`、`OU=`，或沒有 `Digital Signature`，那不是本工具目前的 Turnkey 3.2.1 相容輸出，不應提交。

## 6. CA 申請、付款與審核

外部申請頁可能改版，但檔案原則不變：

1. 進入財政部／Turnkey 當期指定的非 IC 卡軟體憑證 CA 申請入口。
2. 選擇公司非 IC 卡憑證申請。
3. 只上傳 `12345678_<時間>.csr`。
4. 依頁面要求使用負責人自然人憑證、工商憑證或其他核准方式完成身分簽章。
5. 取得繳費資訊並完成繳費。
6. 保存案件流水號、繳費結果與承辦聯絡資料。
7. 等待 CA 審核；非 IC 卡沒有實體卡片，核發通知與取得方式依 CA 通知辦理。
8. 核發後下載 X.509 CER，原檔保存，不要用文字編輯器重新存檔。

CA 頁面若同時顯示「IC 卡掛號寄送」與「非 IC 卡以 Email 通知」，那是共用說明模板。應以申請頁標題、申請項目與案件內容是否標示「非 IC 卡」判斷；非 IC 卡不會因共用文字而變成實體 IC 卡申請。

工具接受兩種 CER：

- PEM/Base-64 X.509：包含 `-----BEGIN CERTIFICATE-----`。
- binary DER X.509。

CER 不含 private key，且必須使用本次 CSR 的 public key 核發。CA 審核期間不要重新執行 `request` 取代舊 `.key`；新 KEY 與已提交 CSR 不相符。

## 7. Step 3：以原 KEY 與 CA CER 組成正式 PFX

收到 CER 後，使用**當初提交 CSR 時同一個 `.key` 與同一組密碼**：

```bash
npm run pfx -- assemble \
  --key /secure/offline-volume/turnkey-12345678/12345678_20241231115134.key \
  --cer /secure/offline-volume/turnkey-12345678/issued.cer \
  --out /secure/offline-volume/turnkey-12345678/signing.pfx
```

工具會：

1. 用密碼開啟 binary PKCS#12 `.key`。
2. 尋找 alias 與 RSA PrivateKeyEntry。
3. 解析 PEM 或 DER CER。
4. 比對 RSA modulus 與 public exponent，確認 CER 與 private key 相符。
5. 移除 `.key` 中只供暫存的自簽憑證。
6. 放入 CA 核發 leaf certificate 與選用的 chain。
7. 產生含 MAC、friendlyName 和 localKeyId 的正式 PKCS#12/PFX。
8. 立即重新開啟產出的 PFX，確認 private key 與 certificate 相符。
9. 以 `0600` 建立新檔，不覆寫任何既有 PFX。

若 CA 另提供 intermediate/root certificate，可重複傳入 `--chain`。`--cer` 必須是本公司 leaf certificate：

```bash
npm run pfx -- assemble \
  --key ./12345678_20241231115134.key \
  --cer ./issued-leaf.cer \
  --chain ./intermediate-1.cer \
  --chain ./intermediate-2.cer \
  --out ./signing.pfx
```

這些是本機結構與 key-pair 檢查，不等於完整 PKI trust validation。工具不會連線查 CRL/OCSP，也不能離線證明 CA 當下仍獲財政部接受；憑證信任、撤銷狀態與帳戶登錄要靠 CA／財政部流程及 TEST UAT 驗證。

## 8. 檢查正式 PFX

### 8.1 內建檢查

```bash
npm run pfx -- inspect --pfx ./signing.pfx
```

輸出只含 alias、RSA bits、subject、issuer、serial、有效期間、SHA-256 fingerprint、certificate 數量與 key match 結果，不會輸出 private key、PFX Base64 或密碼。

請記錄下列非秘密 metadata，供平台登錄與輪替核對：

- Subject
- Issuer
- Serial number
- Not Before／Not After
- SHA-256 fingerprint

### 8.2 OpenSSL 交叉檢查

```bash
openssl pkcs12 -info -in ./signing.pfx -noout

openssl pkcs12 -in ./signing.pfx -clcerts -nokeys \
  | openssl x509 -noout \
      -subject -issuer -serial -dates -fingerprint -sha256
```

讓 OpenSSL 互動提示密碼。不要改成 `-passin pass:實際密碼`，否則密碼可能進入 shell history 或 process list。

## 9. 財政部平台登錄與 TEST UAT

PFX 產生成功不代表財政部已認得它。正式上線前至少完成：

1. 依電子發票平台當期流程，將 CA 核發的軟體憑證登錄／授權到正確營業人與正確環境。
2. 核對平台顯示的 serial/fingerprint 與本工具 `inspect` 結果。
3. 確認 certificate 仍在有效期且沒有撤銷。
4. 使用 TEST 傳送帳號、傳送密碼、傳送繞送代碼與已白名單 Linode 完成官方 UAT。
5. TEST 成功後才建立 production account 設定並切正式環境。

登錄操作屬外部狀態，本機工具不能自動宣稱成功。沒有完成 UAT 時，不得因單元測試通過就宣稱已取得財政部認證。

## 10. 交給 Global Finance／Cloudflare Worker

本工具是憑證生命週期的本機工具；發票傳送時，Finance 將正式 PFX 交給台灣 adapter：

```json
{
  "credentials": {
    "transport": {
      "loginId": "財政部傳送帳號",
      "loginPassword": "財政部傳送密碼"
    },
    "signing": {
      "format": "PFX",
      "pfxBase64": "正式PFX的標準Base64且不得換行",
      "password": "產生KEY時設定的8碼密碼"
    },
    "leaseSeconds": 604800
  }
}
```

傳送繞送代碼設定在 account，不放進 PFX credentials：

```json
{
  "companyBan": "12345678",
  "routingId": "財政部傳送繞送代碼"
}
```

安全資料流：

```text
Finance 讀取受保護 PFX
  → 只在記憶體轉成 Base64
  → TLS 呼叫 Worker
  → Worker 驗證 PFX 後以 AES-256-GCM 密封至 private R2 lease
  → Queue／Workflow 只持有 opaque reference
  → Worker 內完成 attached CMS 簽章
  → PFX 永不送往 Linode
  → lease 到期由 Cron 清除
```

不要先把 PFX Base64 寫入 repository、JSON fixture、D1、Queue message 或 log。若只在隔離終端做一次性人工診斷，可以：

```bash
base64 < signing.pfx | tr -d '\n'
```

這條命令會把完整敏感 PFX 印到終端，日常維運不應採用。

## 11. 換發、輪替與撤銷

每次換發都視為一組不可拆散的新材料：

```text
NEW.key + NEW.csr + NEW.cer + NEW.pfx + NEW password
```

建議流程：

1. 舊 PFX 還有效時建立新 KEY／CSR。
2. 完成 CA 核發與平台登錄。
3. 在 TEST 驗證新 PFX。
4. Finance 建立新 secret version／credential lease。
5. 小流量切換並監控簽章、上傳與回覆。
6. 確認沒有使用舊 PFX 的待處理 Workflow。
7. 依 retention policy 封存或安全清除舊材料。

以下情形應立即停止使用、依 CA 程序撤銷並換發：

- `.key`、PFX 或密碼疑似外洩。
- certificate 被撤銷或到期。
- 公司統編／主體變更使原憑證不再適用。
- 平台通知 certificate 不再獲授權。

## 12. 常見錯誤與處理

| 症狀／錯誤 | 常見原因 | 正確處理 |
|---|---|---|
| `KEY/PFX 密碼必須恰好為 8...` | 長度或字元不符 | 使用剛好八個 ASCII A-Z/a-z/0-9 |
| `兩次輸入的密碼不同` | confirmation 不一致 | 重新執行；工具尚未產生檔案 |
| `無法用提供的密碼開啟 KEY` | 密碼錯、檔案損壞、拿到 PEM 或其他格式 | 找回原密碼與 Turnkey `.key`；不要改副檔名假裝相容 |
| CSR Subject 多出 C/O/OU | 使用過去的通用 CSR generator | 重新使用目前 `request`；必須只有 `CN=統編` |
| CSR 沒有 Digital Signature | CSR 非 Turnkey 3.2.1 結構 | 重新使用目前 `request` |
| `CER ... 與 KEY ... 不相符` | CER 屬於另一把 key／另一份 CSR | 找回送件時的原 `.key`；無法合併就重新申請 |
| `拒絕覆寫既有檔案` | 路徑已存在 | 改新路徑並人工核對舊檔；工具不自動刪除 |
| `只能從互動式 TTY...` | CI、pipe、cron 或 IDE 無互動終端 | 在受控 Terminal 執行；不要把密碼塞進 command line |
| OpenSSL 無法讀舊 Turnkey KEY 的 RC2 | OpenSSL 3 預設停用 legacy RC2 | 優先用 `inspect-key`／Java keytool；不要為此轉出無密碼私鑰 |
| Worker `TW_PFX_INVALID` | PFX Base64、密碼、container、key/cert 錯誤 | 先執行 `inspect`，再檢查傳輸過程是否改動 bytes |
| Worker `TW_PFX_CERTIFICATE_EXPIRED` | CA certificate 未生效或已到期 | 核對系統時間、換發、重新登錄並完成 UAT |

## 13. 不可破壞的安全規則

- 不得提交 `.key`、PFX、P12、密碼或 PFX Base64 到 Git。
- 不得把 `.key` 傳給 CA；CA 只需要 CSR。
- 不得把 Step 1 暫時自簽憑證當成正式 certificate。
- 不得使用測試自簽 CER 進入 TEST 或 PRODUCTION。
- 不得把 PFX 或 PFX 密碼送到 Linode；本架構在 Worker 內完成 CMS 簽章。
- 不得把傳送密碼當 PFX 密碼，也不得把 `ADMIN/ADMIN` 當傳送帳密。
- 不得在 log、telemetry、Queue payload、Workflow params、D1 metadata 或 Finance event 保存明文秘密。
- 不得提供公開的 Worker endpoint 讓任意呼叫者產生 private key；KEY generation 永遠是本機維運工作。
- `.gitignore` 只是最後一道防線，不是 secrets manager，也不是備份策略。

## 14. 程式與測試位置

- `tools/pfx/lib.ts`：Turnkey 3.2.1 KEY／CSR／PFX 核心實作。
- `tools/pfx/cli.ts`：互動 CLI、權限、拒絕覆寫與輸出 metadata。
- `test/pfx-tool.test.ts`：CSR 結構、PKCS#12、CER key match 與 Worker parser 測試。
- `src/worker/pfx-signer.ts`：正式執行時 Worker 的 PFX 解析與 attached CMS 簽章。
- `README.md`：專案入口與安全架構摘要。
- `docs/offline-integration-guide.md`：Global Finance、Cloudflare、Linode 與財政部端到端整合。

修改這套工具時，不可只確認 CSR `verify()` 成功；至少必須保留以下 assertions：RSA-2048、Subject 只有 CN、extensionRequest/Digital Signature、SHA256withRSA、PKCS#12 alias=統編、原 KEY 與 CER public key match、產出 PFX 能被 Worker parser 開啟。
