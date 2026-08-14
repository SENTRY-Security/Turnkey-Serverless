# Architecture and security boundary

## Component mapping

| Original Turnkey responsibility | Replacement |
|---|---|
| Local relational database | D1 metadata, idempotency, status and routing cache |
| Inbox/process/backup/error folders | Private R2 versioned artifacts |
| Quartz/background schedules | Cron Trigger + Queue + Workflow |
| Pack InvoiceEnvelope | TypeScript Worker core |
| PFX signing | TypeScript Worker using attached PKCS#7/CMS + SHA-256 |
| Filename/UUID/message timestamp | Worker + per-account Durable Object coordination |
| SFTP send/receive | Stateless Linode egress agent |
| Gateway Web API | Stateless Linode egress agent |
| Result unpack and status reconciliation | Inbound Workflow + D1 + Finance event Queue |
| GUI/config database | Finance API + deployment configuration |

## Why Linode remains

Workers normally do not provide a tenant-owned, stable outbound source IP that can be placed on the Ministry of Finance allowlist. A small Linode instance supplies only that network identity. The egress agent does not schedule jobs, own business state, pack XML, sign with PFX, or store credentials.

If the Cloudflare account later has an appropriate dedicated egress/static IP product accepted by the Ministry, the `egress-client` boundary can point to that implementation without changing the Finance contract or workflows.

## Credential path

1. Finance calls Worker over TLS using adapter bearer authentication.
2. Worker validates that the PFX opens with the supplied password and that the signing certificate is currently valid.
3. Worker removes credentials from the business manifest and seals `{MOF transport account/password, PFX/password}` with AES-256-GCM. The original Turnkey GUI `ADMIN/ADMIN` credentials are not part of this service. Account ID and expiry are authenticated additional data.
4. Encrypted JSON is written to a private R2 object. D1 stores only object key and expiry. Queue and Workflow payloads contain IDs only.
5. A Workflow decrypts the lease only inside the step that needs it. PFX signing runs inside Worker.
6. Before each SFTP/Gateway operation, Worker HMAC-authenticates a `/v1/sessions` request to Linode. Linode retains platform account/password only in an in-memory map for at most 5 minutes.
7. The opaque 256-bit token is profile-bound and consumed by exactly one operation. PFX material is never sent to Linode.
8. The scheduled handler deletes expired credential-lease objects from R2 in bounded batches; D1 retains only audit metadata and expired object keys.

`EGRESS_HMAC_SECRET` protects authenticity and replay (timestamp + nonce + body hash + profile + session token). TLS still remains mandatory for confidentiality. SFTP server identity is pinned by SHA-256 host-key fingerprint.

## Failure and retry model

- Finance idempotency is `(tenant_id, legal_entity_id, idempotency_key)`.
- Repeating an idempotent request whose row is still `RECEIVED` re-enqueues the same submission ID, closing the failure window where D1 committed but the first Queue send did not.
- Queue only starts a Workflow; Workflow steps provide durable retry boundaries.
- SFTP upload checks an existing same-name object and size before treating retry as successful.
- Gateway is called only after confirmed SFTP upload.
- Inbound files are persisted to R2 before verification and remote deletion; ProcessResult correlation includes the adapter account as well as UUID and message timestamp, preventing cross-tenant status mutation.
- Remote result is deleted only after local processing and D1 status update.
- A later poll that sees an already processed inbound filename performs only idempotent remote cleanup; it does not parse or emit the Finance event again. Queue consumers still deduplicate the platform's at-least-once delivery by stable `eventId`.
- A transient inbound failure is retained in R2 and left on SFTP for retry. A permanent signature/decryption/XSD/format failure is retained with SHA-256 in R2, marked `QUARANTINED`, then removed from SFTP so poison files cannot starve the outbox; the poll continues with other files.
- Expired submission credentials fall back to the account’s newest valid lease; otherwise the operation fails closed.
- The pfs003 cross-border supplier cache is accepted for at most 24 hours. Once stale, a failed refresh stops validation instead of silently using an old compliance list.

## Isolation

Every R2 key is prefixed by `tw/{tenant}/{legalEntity}` and every D1 lookup is anchored to account/submission ownership. The public contract requires `country: "TW"`; no other country logic is included. A production deployment should additionally put this Worker behind the Finance platform’s service-to-service authentication and Cloudflare WAF/rate limits.

Account creation performs an authenticated profile inspection against the Linode agent and refuses a `platformEnvironment`/egress profile mismatch, so a TEST account cannot silently point at production endpoints (or vice versa).

## Deliberate exclusions

- Hardware business certificate / PKCS#11 card access.
- GUI and local database compatibility.
- QR-code rendering and consumer invoice presentation, which belong to other Finance/application services.
- Automatic application for Ministry allowlisting, routing IDs, platform accounts, or software certificates.
- Desktop-only self-update/GUI behavior. The underlying pfs004 version query and pfs005 error catalog protocols remain available as adapter diagnostics.
- Outbound ZIP mode (`zip: "1"`); the adapter always uses the valid uncompressed `zip: "0"` path and enforces the original 15 MB grouping threshold. Inbound E0504 encrypted ZIP is supported.
