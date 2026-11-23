# tally-ingest
 
A small backend service that ingests Tally XML and exposes normalized vouchers
**without losing parent-child relationships**, source order, or exact financial values.
 
Stack: Node.js 20+, TypeScript, Express, SQLite (`better-sqlite3`), `saxes` (strict XML parser), Vitest + Supertest.
 
---
 
## Table of contents
 
1. [Quick start](#1-quick-start)
2. [Scripts and configuration](#2-scripts-and-configuration)
3. [API reference](#3-api-reference)
4. [Trying it: curl](#4-trying-it-curl)
5. [Trying it: Postman](#5-trying-it-postman)
6. [Sample fixtures and what each proves](#6-sample-fixtures-and-what-each-proves)
7. [Tests](#7-tests)
8. [How it works](#8-how-it-works)
9. [Database design](#9-database-design)
10. [Assumptions and interpretations](#10-assumptions-and-interpretations)
11. [Security](#11-security)
12. [Large-file design note (500 MB export)](#12-large-file-design-note-500-mb-export)
13. [Status, time, and honest limitations](#13-status-time-and-honest-limitations)
14. [AI usage disclosure](#14-ai-usage-disclosure)
15. [Submission checklist mapping](#15-submission-checklist-mapping)
16. [Project layout](#16-project-layout)
17. [Troubleshooting](#17-troubleshooting)
---
 
## 1. Quick start
 
Requirements: **Node.js 20.6 or newer** (the scripts use Node's built-in `--env-file`), and a normal
build toolchain or a prebuilt binary for `better-sqlite3`.
 
```bash
npm install
npm run dev
```
 
That is all. On startup the service creates the `data/` folder, opens the SQLite file, **applies
any pending migrations automatically**, and listens on `http://localhost:3000`.
 
Check it:
 
```bash
curl http://localhost:3000/health
```
 
Run the tests (one command, in-memory database, no setup):
 
```bash
npm test
```
 
Production-style run:
 
```bash
npm run build
npm start
```
 
There is no Docker setup. It was not required and the service is a single process with a single
SQLite file.
 
---
 
## 2. Scripts and configuration
 
| Script | What it does |
| --- | --- |
| `npm run dev` | Start with auto-reload (`tsx watch`), loading `.env` |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run the compiled server, loading `.env` |
| `npm run migrate` | Apply pending database migrations and exit |
| `npm run typecheck` | Type-check without emitting files |
| `npm test` | Run all tests once |
 
### Environment variables (`.env`)
 
The committed `.env` contains **non-secret defaults only**. In production, inject real environment
variables instead of shipping a file. Every value has a default, and invalid values stop the
process at startup with a clear message.
 
| Variable | Default | Meaning |
| --- | --- | --- |
| `NODE_ENV` | `development` | `development`, `test` or `production` (production hides stack traces in logs) |
| `PORT` | `3000` | HTTP port |
| `DATABASE_PATH` | `./data/tally.db` | SQLite file (created if missing) |
| `MAX_UPLOAD_BYTES` | `10485760` (10 MiB) | Upload size limit |
| `LOG_LEVEL` | `info` | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |
 
### Migrations
 
Migrations live in `src/db/migrations.ts` as numbered SQL, applied in order and recorded in a
`schema_migrations` table. They run automatically at server startup and can be run on their own:
 
```bash
npm run migrate
```
 
Each migration runs in its own `BEGIN IMMEDIATE` transaction with the "already applied?" check
inside it, so two processes starting together cannot apply the same migration twice.
 
---
 
## 3. API reference
 
Base path: `/api/tally/imports`. All import responses carry `Cache-Control: no-store`.
 
### `GET /health`
 
Returns `200` `{"status":"ok","service":"tally-ingest"}` when the process is up **and** the
database answers. Returns `503` `{"status":"unavailable",...}` otherwise.
 
### `POST /api/tally/imports`
 
`Content-Type: multipart/form-data`, with exactly one file in the field named **`file`**.
 
| Outcome | Status |
| --- | --- |
| New content accepted | `201` |
| Exact same bytes imported before | `200` (`"duplicate": true`, original `importId`) |
 
```json
{
  "importId": "6f1c0f5e-4c1d-4c53-9d0e-2a3d0f0c1b11",
  "documentType": "voucherExport",
  "status": "completed",
  "duplicate": false,
  "summary": { "vouchers": 1, "ledgerEntries": 2, "inventoryEntries": 0, "warnings": 0, "errors": 0 }
}
```
 
- `documentType` is `voucherExport` for an `ENVELOPE` root and `tallyResponse` for a `RESPONSE` root.
- `status: "completed"` means *decoded, parsed and stored*. It does **not** mean the Tally business
  operation succeeded. See `tallyResponse.businessStatus` on the details endpoint.
- A valid empty collection is `completed` with zero counts.
- A `Location` header points to the new import.
### `GET /api/tally/imports/{importId}`
 
```json
{
  "importId": "…",
  "documentType": "tallyResponse",
  "status": "completed",
  "contentHash": "lowercase-64-char-sha256-hex-of-the-exact-bytes",
  "detectedEncoding": "UTF-8",
  "summary": { "vouchers": 0, "ledgerEntries": 0, "inventoryEntries": 0, "warnings": 0, "errors": 0 },
  "warnings": [],
  "errors": [],
  "tallyResponse": {
    "businessStatus": "failed",
    "counters": { "CREATED": "0", "ALTERED": "0", "DELETED": "0", "IGNORED": "1", "ERRORS": "1" },
    "lineError": "Demo ledger does not exist"
  }
}
```
 
- `tallyResponse` appears only for `RESPONSE` documents. Counters are source strings, trimmed, and
  `null` when the element is absent. `lineError` is `null` when absent.
- `businessStatus` is `failed` when `ERRORS > 0` or `LINEERROR` is non-empty, otherwise `succeeded`.
- `detectedEncoding` is one of `UTF-8`, `UTF-8-BOM`, `UTF-16LE`, `UTF-16BE`.
- Raw XML, the uploaded filename, secrets, stack traces and filesystem paths are **never** returned.
### `GET /api/tally/imports/{importId}/vouchers`
 
Returns `{ "items": [...], "count": n }`, where each item follows `NORMALIZED_DATA_CONTRACT.md`
exactly (`source`, `attributes`, `date`, `voucherType`, `voucherNumber`, `partyLedgerName`,
`narration`, `ledgerEntries`, `inventoryEntries`, `warnings`). A `tallyResponse` import returns
`{"items":[],"count":0}`. Every array is always an array, including with one item or none.
 
### Warning codes
 
| Code | Meaning |
| --- | --- |
| `ILLEGAL_XML_CHARACTER_REFERENCE_REMOVED` | Numeric references such as `&#4;` that XML 1.0 forbids were removed so the document could be parsed |
| `ILLEGAL_XML_CHARACTER_REMOVED` | Literal illegal control characters were removed |
| `UNKNOWN_ELEMENT_NOT_NORMALIZED` | An element outside the contract was found. It is kept only in the raw upload |
| `UNKNOWN_ATTRIBUTE_NOT_NORMALIZED` | Same, for an attribute |
| `ENCODING_DECLARATION_MISMATCH` | The XML declaration names an encoding different from the detected bytes |
| `INVALID_TALLY_COUNTER` | A response counter was not an integer |
 
Warnings carry only element names, counts and code points. **Never text copied from the document.**
Repeated identical warnings are aggregated (one entry per code and path, with a `count`).
 
### Errors
 
Every error uses one shape and our own messages, never library text:
 
```json
{ "error": { "code": "INVALID_XML", "message": "The uploaded document is not well-formed XML.", "details": { "line": 2, "column": 5 } } }
```
 
| HTTP | `code` | When |
| --- | --- | --- |
| 400 | `FILE_REQUIRED` | No file in the `file` field, or not a multipart request |
| 400 | `BAD_REQUEST` | Wrong field name, more than one file, malformed multipart |
| 404 | `NOT_FOUND` | Unknown import, malformed id, or unknown route |
| 413 | `PAYLOAD_TOO_LARGE` | File over `MAX_UPLOAD_BYTES` (`details.maxBytes`) |
| 422 | `INVALID_XML` | Not well-formed XML (details has line/column only) |
| 422 | `UNSUPPORTED_DOCUMENT` | Not an `ENVELOPE` with a `COLLECTION` or a `RESPONSE`, or it contains a `DOCTYPE`, or exceeds depth/element limits |
| 422 | `UNSUPPORTED_ENCODING` | Bytes cannot be decoded as UTF-8, UTF-8 BOM or UTF-16 with BOM |
| 500 | `INTERNAL_ERROR` | Anything unexpected (generic message, details only in server logs) |
| 503 | (health) | Database unavailable |
 
Rejected (4xx) documents are **not stored**, so a corrected file can be re-uploaded.
 
---
 
## 4. Trying it: curl
 
Start the server with `npm run dev`. On **Windows PowerShell use `curl.exe`**, because plain `curl`
is an alias for a different command. On macOS/Linux use `curl`.
 
```bash
# health
curl.exe http://localhost:3000/health
 
# upload a voucher export (expect 201)
curl.exe -i -F "file=@fixtures/01_receipt_with_allocations.xml" http://localhost:3000/api/tally/imports
 
# details and vouchers (replace <importId> with the value returned above)
curl.exe http://localhost:3000/api/tally/imports/<importId>
curl.exe http://localhost:3000/api/tally/imports/<importId>/vouchers
 
# same bytes under a different filename (expect 200 and "duplicate": true, same importId)
curl.exe -i -F "file=@fixtures/06_duplicate_receipt.xml" http://localhost:3000/api/tally/imports
 
# Tally business failure: upload is accepted (201), the business result is "failed"
curl.exe -i -F "file=@fixtures/03_tally_error_response.xml" http://localhost:3000/api/tally/imports
 
# UTF-16 with an illegal control reference: completes with a warning
curl.exe -F "file=@fixtures/04_utf16_invalid_control_ref.xml" http://localhost:3000/api/tally/imports
 
# empty collection (completed, zero counts)
curl.exe -F "file=@fixtures/05_empty_collection.xml" http://localhost:3000/api/tally/imports
 
# error cases
curl.exe -i -F "note=hello" http://localhost:3000/api/tally/imports          # 400 FILE_REQUIRED
curl.exe -i http://localhost:3000/api/tally/imports/not-a-uuid               # 404 NOT_FOUND
```
 
---
 
## 5. Trying it: Postman
 
### One-time setup
 
1. Create a collection named **tally-ingest**.
2. Open the collection's **Variables** tab and add:
   - `baseUrl` = `http://localhost:3000`
   - `importId` = (leave empty, filled automatically below)
3. Start the server (`npm run dev`).
### Requests
 
**1. Health**
 
- `GET {{baseUrl}}/health`
- Expect `200` and `{"status":"ok","service":"tally-ingest"}`.
**2. Upload**
 
- `POST {{baseUrl}}/api/tally/imports`
- Body tab, choose **form-data**.
- Add a key named exactly `file`, then hover the key cell and change its type from *Text* to **File**.
  Select a file from the `fixtures/` folder.
- **Do not set a `Content-Type` header yourself.** Postman adds the multipart boundary automatically.
- Expect `201` on first upload, `200` with `"duplicate": true` for the same bytes.
- On the **Tests** tab, paste this so the next requests use the new id automatically:
```javascript
pm.test("accepted", function () {
  pm.expect([200, 201]).to.include(pm.response.code);
});
const json = pm.response.json();
pm.collectionVariables.set("importId", json.importId);
pm.test("completed", function () {
  pm.expect(json.status).to.eql("completed");
});
```
 
**3. Import details**
 
- `GET {{baseUrl}}/api/tally/imports/{{importId}}`
- For `03_tally_error_response.xml`, expect `tallyResponse.businessStatus` to be `"failed"` even though the upload returned `201`.
- Tests tab example:
```javascript
const json = pm.response.json();
pm.test("hash is lowercase sha-256", function () {
  pm.expect(json.contentHash).to.match(/^[0-9a-f]{64}$/);
});
pm.test("raw xml and filename are not exposed", function () {
  pm.expect(JSON.stringify(json)).to.not.include("<VOUCHER");
});
```
 
**4. Vouchers**
 
- `GET {{baseUrl}}/api/tally/imports/{{importId}}/vouchers`
- Expect `{ items: [...], count: n }`.
### Suggested walkthrough (about five minutes)
 
| Step | Upload | What to confirm |
| --- | --- | --- |
| 1 | `01_receipt_with_allocations.xml` | `201`. Vouchers show two ledger entries, `-1250.00` stays negative, bill and bank allocations sit under their own ledger entry |
| 2 | `06_duplicate_receipt.xml` | `200`, `duplicate: true`, **same** `importId` as step 1, vouchers count still 1 |
| 3 | `02_sales_invoice_nested.xml` | `201`. Five different `AMOUNT` values stay separate. One `UNKNOWN_ELEMENT_NOT_NORMALIZED` warning for `VOUCHER/PERSISTEDVIEW` |
| 4 | `03_tally_error_response.xml` | `201` and `status: completed`, but details show `businessStatus: failed`, `lineError` set. Vouchers is `{"items":[],"count":0}` |
| 5 | `04_utf16_invalid_control_ref.xml` | `201`, `detectedEncoding: UTF-16LE`, one `ILLEGAL_XML_CHARACTER_REFERENCE_REMOVED` warning |
| 6 | `05_empty_collection.xml` | `201`, all counts `0`, no error |
| 7 | `07_utf8_bom_payment.xml` | `201`, `detectedEncoding: UTF-8-BOM` |
| 8 | Any file, wrong key name (e.g. `document`) | `400 BAD_REQUEST` |
| 9 | `GET /api/tally/imports/abc` | `404 NOT_FOUND` |
 
You can also export the collection from Postman and commit it, if you want reviewers to import it.
 
---
 
## 6. Sample fixtures and what each proves
 
All seven supplied fixtures live in `fixtures/`.
 
| File | Proves |
| --- | --- |
| `01_receipt_with_allocations.xml` | Two ledger entries stay separate and ordered. Bill and bank allocations belong to their own ledger entry. Signed amounts are untouched |
| `02_sales_invoice_nested.xml` | `LEDGERENTRIES.LIST` source tag. Inventory, batch and accounting allocations keep their own `AMOUNT`. Rate details belong to their direct parent. Unknown child warning |
| `03_tally_error_response.xml` | `RESPONSE` parsing. Upload accepted but `businessStatus: failed` |
| `04_utf16_invalid_control_ref.xml` | UTF-16 with BOM plus `&#4;` recovery with a warning |
| `05_empty_collection.xml` | Valid empty collection is `completed` with zero counts |
| `06_duplicate_receipt.xml` | Byte-identical to 01 under a different filename. Idempotency |
| `07_utf8_bom_payment.xml` | UTF-8 with BOM |
 
---
 
## 7. Tests
 
```bash
npm test
```
 
Runs every test file once with Vitest against in-memory SQLite (plus a temporary file for the
cross-connection test, which cleans up after itself). `npm run typecheck` checks types.
 
| File | Covers |
| --- | --- |
| `tests/decode.test.ts` | BOM detection, UTF-8/UTF-16LE/UTF-16BE, strict rejection of bad bytes, SHA-256 |
| `tests/sanitize.test.ts` | Illegal reference/character removal, warnings contain no document text |
| `tests/tree.test.ts` | Ordered tree, entity/DOCTYPE/XXE/billion-laughs rejection, depth and element limits |
| `tests/voucher.test.ts` | Direct-parent ownership, ordering, no deduplication, unknown-child warnings |
| `tests/response.test.ts` | `RESPONSE` counters, `businessStatus` rules, lossless large counters |
| `tests/importRepo.test.ts` | Round trip, atomic rollback, DB-level uniqueness (including across two connections), cascades, raw bytes retained |
| `tests/importService.test.ts` | Whole pipeline, rejection paths, logging contains no document content |
| `tests/upload.test.ts` | Size limit (exact boundary), field name, single file, malformed multipart |
| `tests/errorHandler.test.ts` | Structured errors, no leaks, generic 500 |
| `tests/api.test.ts` | End-to-end HTTP for all endpoints and the six scenarios below |
 
The six scenarios the assignment requires, all in `tests/api.test.ts` (and at lower levels elsewhere):
 
1. Repeated ledger entries remain separate and ordered.
2. Ledger, bill, inventory, batch and accounting `AMOUNT` values are not overwritten.
3. Duplicate bytes under a different filename return the original import without duplicate vouchers.
4. UTF-16 and illegal-control-reference recovery records a warning.
5. A Tally response with `ERRORS=1` has `businessStatus: failed` even though the upload was accepted.
6. An empty collection and an unknown child do not crash or invent vouchers.
---
 
## 8. How it works
 
```
upload bytes
  → SHA-256 of the exact bytes (content identity)
  → fast-path lookup: already imported? return it (200)
  → decode (BOM detection, strict UTF-8 / UTF-16)
  → sanitize illegal XML 1.0 characters (warning if anything was removed)
  → parse into an ORDERED element tree (saxes, DOCTYPE rejected)
  → normalize from DIRECT children only
        ENVELOPE → vouchers          RESPONSE → counters + businessStatus
  → one transaction: import row + raw bytes + every child row
        UNIQUE(content_hash) decides duplicates atomically
```
 
Key rules that make the data trustworthy:
 
- **The tree is never flattened.** The parser keeps ordered children. The mappers only read the
  *direct* children of the node they are mapping (`childText` and `childrenNamed`; there is no
  descendant search anywhere). An `AMOUNT` under a bill allocation cannot overwrite the one on its
  ledger entry.
- **Money is text.** Amounts, quantities, rates and dates are stored and returned as the exact source
  strings. There are no `REAL` columns and no number parsing. `-1250.00` stays `-1250.00` whatever
  `ISDEEMEDPOSITIVE` says.
- **Order and identity.** Every repeated child stores a `position`. Two identical child rows stay
  two rows.
- **Three separate facts.** Transport acceptance (HTTP status), processing outcome
  (`status`), and the Tally business outcome (`tallyResponse.businessStatus`).
- **Idempotency is a database guarantee.** The insert uses `ON CONFLICT(content_hash) DO NOTHING`
  inside one `BEGIN IMMEDIATE` transaction. The lookup before parsing is only a shortcut.
---
 
## 9. Database design
 
Hybrid: **relational rows for the voucher tree, JSON only for small diagnostics.**
 
```
imports 1─1 import_sources                 raw uploaded bytes (BLOB)
imports 1─* vouchers
vouchers 1─* ledger_entries 1─* bill_allocations
                            1─* bank_allocations
vouchers 1─* inventory_entries 1─* batch_allocations
                               1─* accounting_allocations
rate_details → exactly ONE owner: ledger entry, inventory entry, or accounting allocation
```
 
Why relational rows for the tree: the assignment requires the relationships to be inspectable. Real
foreign keys let you `JOIN` from an import down to a rate detail, the database refuses orphans, and
`ON DELETE CASCADE` removes a whole import cleanly.
 
Why JSON for a few columns: `warnings_json`, `errors_json`, `attributes_json` and
`tally_response_json` are small, always read whole, and never filtered by field.
 
Other decisions:
 
- Every repeated child has `position` and `UNIQUE(parent_id, position)`. Position is identity.
- `rate_details` has three nullable foreign keys and a `CHECK` that exactly one is set. This keeps real
  referential integrity, which a generic `(owner_type, owner_id)` pair cannot.
- `import_sources` holds the raw bytes separately from `imports`, so metadata queries can never
  accidentally load a large BLOB.
- `content_hash` is `UNIQUE` with a `CHECK` that it is 64 lowercase hex characters.
- Tables are `STRICT`, so a value of the wrong type is rejected by SQLite itself.
- SQLite runs with `foreign_keys=ON`, WAL journaling and a busy timeout.
Inspect it directly:
 
```bash
sqlite3 data/tally.db ".tables"
sqlite3 data/tally.db "SELECT v.voucher_number, le.ledger_name, le.amount, ba.name, ba.amount
  FROM vouchers v JOIN ledger_entries le ON le.voucher_id=v.id
  LEFT JOIN bill_allocations ba ON ba.ledger_entry_id=le.id ORDER BY v.id, le.position;"
```
 
---
 
## 10. Assumptions and interpretations
 
Where the contract was silent or the samples were unusual, this is what the service does.
 
1. **Allocation names accept both `NAME` and `n`.** Fixture 01 writes the bill/bank allocation name as
   `<n>`, fixture 02 as `<NAME>`. Both map to `name`. If both appear, the first in the source wins.
2. **Unreadable `ERRORS` counts as failed.** If `ERRORS` is neither blank nor an integer, the
   business status is `failed` and an `INVALID_TALLY_COUNTER` warning is recorded, because a false
   "succeeded" is the costly mistake with accounting data. A blank `ERRORS` element is treated as absent.
3. **`LINEERROR`:** whitespace-only counts as empty. Several non-empty occurrences are joined with
   newlines in source order.
4. **`summary.errors` counts processing errors**, not Tally's `ERRORS` counter. That counter lives only
   in `tallyResponse.counters`. With the optional partial-failure extension not implemented, it is
   always `0` for stored imports.
5. **`summary.warnings`** is the number of warning entries on the import. Identical warnings are
   aggregated by code and path, so it is not a count of elements.
6. **Rejected documents are not stored.** Unreadable, unsupported or oversized documents return a
   structured 4xx and create no record (the assignment allows this).
7. **Counters are source strings** (trimmed), consistently.
8. **Text is never trimmed or converted.** Values are exactly the source text. An empty element is
   `""`, an absent one is `null`.
9. **Encodings:** UTF-8, UTF-8 BOM and UTF-16 (LE/BE) with BOM. UTF-16 without a BOM and UTF-32 are
   rejected rather than guessed. Invalid bytes are rejected instead of being replaced with `�`.
   The detected (BOM) encoding wins over the XML declaration, with a warning on mismatch.
10. **`voucherIndex`** is the zero-based position among all `VOUCHER` elements in the document, counting
    across multiple `COLLECTION` elements.
11. **Unknown content** is flagged at every level with a path. It is *not* normalized, and the
    complete raw upload is retained instead. This satisfies source preservation for the core exercise.
12. **A voucher with `ALLLEDGERENTRIES.LIST` and `LEDGERENTRIES.LIST` mixed** keeps one ordered array
    in true source order, with `sourceTag` recording which tag each came from.
13. **`importId` is a random UUID**, not the hash, so ids are not guessable from content.
14. **Duplicate detection is by exact bytes only.** The same XML with different whitespace, or in a
    different encoding, is a different import.
---
 
## 11. Security
 
### Implemented
 
- **Entity and DTD defense:** any `<!DOCTYPE>` is rejected outright, so there are no internal entities
  (no entity expansion), no external entities (no XXE), and nothing is ever fetched or executed.
  `saxes` also errors on undefined entity references.
- **Resource limits on the XML:** maximum nesting depth (64) and maximum element count (1,000,000).
- **Upload limits:** configurable `MAX_UPLOAD_BYTES`, early refusal on `Content-Length`, exactly one file,
  tiny field/part limits. Anything else is rejected before parsing.
- **Safe logging:** the logger redacts `rawXml`, `xml`, `body`, `buffer`, auth headers and cookies as
  defense in depth. Application code logs only ids, hashes, sizes, counts and durations. Parser
  errors are mapped to our own messages and truncated if they are ever logged. Query strings are
  never logged. Tests assert that document content does not appear in logs.
- **Structured errors only:** no stack traces, SQL, library messages or filesystem paths ever reach a
  client. Unexpected errors become a generic 500, and the real error is logged server-side.
- **No raw data over HTTP:** the details endpoint is a field-by-field whitelist. The uploaded
  filename is stored (sanitized to its last path segment) for audit and never returned.
- **Input hygiene:** import ids must be UUIDs (anything else is a 404 with the same body as a missing
  import). SQL is fully parameterized. Attribute objects have a null prototype.
- **Transport hygiene:** `helmet` headers, no `X-Powered-By`, `Cache-Control: no-store` on import
  responses, request/header/keep-alive timeouts against slow clients.
- **Process hygiene:** graceful shutdown, fatal errors exit non-zero for a supervisor to restart.
### Additional controls for production
 
- Authentication and authorization (API keys or OAuth/mTLS), plus tenant isolation so one customer
  cannot read another's imports.
- Rate limiting and per-tenant quotas at the gateway. A limit on concurrent imports.
- TLS terminated at a proxy, with `client_max_body_size` and timeouts enforced there as well.
- Encryption at rest for the database and raw files (raw accounting XML is sensitive), key management,
  and encrypted, tested backups.
- A retention and deletion policy (including a delete endpoint) for raw uploads and imports.
- Audit logging (who uploaded and read what), request-id correlation, metrics and alerting
  (error rate, queue depth, import duration, disk usage).
- Dependency and image scanning, a lockfile-based reproducible build, and an SBOM.
- Content checks on upload (file type sniffing, optional malware scanning) before parsing.
- Move from SQLite to PostgreSQL for multi-instance deployments and concurrent writers.
- Run the parser in a worker or separate process so a pathological document cannot stall the API.
---
 
## 12. Large-file design note (500 MB export)
 
The current implementation buffers the upload (up to `MAX_UPLOAD_BYTES`) and builds the whole tree
in memory. That is deliberate for the exercise: 10 MiB is parsed in tens of milliseconds. A
500 MB export would need roughly 500 MB for the bytes, about the same again as a decoded string,
and several times that for the tree. That would not survive a few concurrent uploads. Here is how a
production version would ingest it with bounded memory.
 
### Incremental XML parsing and object boundaries
 
- `saxes` is already event-based, so the parser can be fed chunks from a stream and never needs the
  complete document.
- **The object boundary is one `VOUCHER` element.** The parser tracks only the fixed ancestors
  (`ENVELOPE/BODY/DATA/COLLECTION`). On `<VOUCHER>` it starts building a small subtree. On
  `</VOUCHER>` it normalizes that one voucher, hands it to the writer, and drops it. Memory is then
  *one voucher plus the current batch*, not the document. The existing mappers (`mapVoucher`) work
  unchanged on a single voucher subtree.
- **Decoding** also streams: BOM detection on the first chunk, then `TextDecoder` with `stream: true`
  so a multi-byte character split across two chunks decodes correctly.
- **Sanitizing** becomes incremental. The tail of each chunk after the last `&` (a few bytes) is held
  back and prepended to the next chunk, so a reference like `&#4;` split across chunks is still found.
- **Per-voucher limits:** the existing depth and element limits apply per voucher. A voucher that
  exceeds a size cap is recorded as a failed object instead of consuming memory, which is where the
  optional partial-failure extension becomes essential.
- **Warnings** are already aggregated by code and path, so their size does not grow with the
  document. A cap on distinct paths keeps a hostile file from inflating them.
- Rough numbers: 500 MB at about 5 KB per voucher is about 100,000 vouchers. With batches of 500, peak memory is
  a few MB for batches plus parser buffers (64 KB chunks), independent of file size.
### Database chunking, restart checkpoints, and idempotency
 
- **Chunked writes:** commit every N vouchers (for example 500) in one transaction. One giant
  transaction would hold the write lock for minutes and could not be resumed.
- **Import states:** `imports.status` gains `processing`, with a `last_committed_voucher_index` and a byte
  offset. The checkpoint is updated **in the same transaction** as each batch, so the checkpoint and the
  data can never disagree.
- **Restart:** on startup, a worker picks up `processing` imports and re-reads the retained raw file.
  It re-parses from the start but **skips** vouchers at or below the checkpoint (reading is cheap, writes are
  not). Recording the byte offset at voucher boundaries would allow a seek, at the cost of
  reconstructing the ancestor stack.
- **Replay safety:** `UNIQUE(import_id, voucher_index)` plus `INSERT … ON CONFLICT DO NOTHING` means a
  batch replayed after a crash cannot create duplicates.
- **Idempotency with streaming:** the SHA-256 is computed incrementally while the upload streams to
  disk, so the hash is known only when the upload ends. At that point the import row is inserted with
  the same `UNIQUE(content_hash)` guarantee. If it conflicts, the temp file is deleted and the existing
  import (completed or still processing) is returned. A client retrying a huge upload never creates a second copy.
- **Final status:** `completed`, or `partial` when some vouchers were rejected, or `failed` when the
  document could not be processed. Because rows are committed progressively, readers must see imports as
  `processing` until the end, and the vouchers endpoint needs **pagination** (cursor on `voucher_index`)
  rather than returning everything.
- Use PostgreSQL (multi-row inserts or `COPY`) for throughput and concurrent writers. SQLite has a single writer.
### Raw-file storage, cleanup, backpressure, and request timeouts
 
- **Do not buffer the upload in RAM.** Stream the multipart body (for example with `busboy`) straight to
  a temp file on disk or an object store, hashing as it goes, enforcing the size cap while streaming. Raw
  files live in object storage (or a disk volume) under a content-addressed key such as the hash, and the
  database stores a reference and size instead of a BLOB.
- **Cleanup:** delete the temp file on any failure or duplicate. A periodic sweeper removes orphaned temp
  files older than a threshold. Raw sources follow a retention policy (and are encrypted at rest with
  restricted access) because they are the evidence needed to investigate sanitization decisions.
- **Backpressure:** use Node stream pipelines so the file reader is paused when the batch writer's queue
  is full. Otherwise a fast disk and a slow database would grow the queue until memory runs out. Bound the
  queue to a few batches.
- **Admission control:** a semaphore limits concurrent imports (the real memory and CPU bound), and
  excess uploads wait or get `429`/`503` with `Retry-After`. Disk quotas protect against full disks. The
  proxy also enforces `client_max_body_size` and per-client rate limits.
- **Request timeouts:** the HTTP request should only cover the *upload*. After the file is stored and
  hashed, the API returns `202 Accepted` with the `importId`, and a background worker does the parsing.
  The client polls `GET /api/tally/imports/{id}` (`processing` → `completed`/`partial`/`failed`) rather than holding
  a connection open for minutes. Header, request and keep-alive timeouts stay tight so slow senders cannot
  tie up sockets, and the upload timeout is sized from the maximum size and a minimum accepted throughput.
- **CPU isolation:** parsing runs in a worker thread or separate process, so the event loop serving health
  checks and small imports is never blocked.
---
 
## 13. Status, time, and honest limitations
 
### Approximate active time
 
**Approximately 4.5 hours of active work**
 
### Complete
 
- All four required endpoints, with exact status codes and response shapes.
- Both document shapes: `ENVELOPE` (vouchers) and `RESPONSE` (Tally result).
- Direct-parent normalization with ordered arrays, the full normalized contract, and lossless values.
- UTF-8, UTF-8 BOM, UTF-16 LE/BE (BOM) decoding, illegal-reference recovery with a persisted warning, and
  retained raw bytes.
- Unknown-child handling with warnings, and empty collections.
- Tally business-status interpretation, kept separate from upload acceptance.
- SQLite persistence with inspectable relationships, migrations, and atomic content-hash idempotency.
- Security basics, structured errors, safe logging, graceful shutdown.
- Automated tests for all required scenarios, one command.
- This README, including the large-file note.
### Optional extensions
 
| Extension | State |
| --- | --- |
| 1. Per-voucher partial failure | **Not implemented** |
| 2. Streaming implementation | **Not implemented** (design in section 12) |
| 3. Concurrency proof | **Partially done.** `tests/api.test.ts` fires 8 simultaneous identical uploads and asserts one import (one `201`, seven `200`). `tests/importRepo.test.ts` proves uniqueness across two separate database connections to one file. Because `better-sqlite3` is synchronous, the in-process test does not by itself prove true multi-process contention. The cross-connection test and the database constraint are the real evidence |
| 4. Richer unknown-node preservation | **Not implemented.** Unknown nodes are flagged by path and the raw upload is retained, but unknown subtrees are not stored separately |
| 5. Alternate response envelope (`IMPORTRESULT`) | **Not implemented.** An `ENVELOPE` without a `COLLECTION` is rejected as unsupported |
 
### Known limitations and production risk
 
| Missing or limited | Risk if shipped as is |
| --- | --- |
| Whole upload and tree held in memory | Memory exhaustion from large or concurrent uploads. Mitigated by the 10 MiB default limit, and a streaming design is described above |
| Parsing is synchronous on the event loop | A large import delays other requests. Mitigate with a worker thread or a queue |
| `GET .../vouchers` returns everything | Large responses for big imports. Needs cursor pagination |
| No per-voucher partial failure | One bad voucher is not isolated. A document is stored whole or not at all. Invalid vouchers (for example a missing `DATE`) are stored as-is with `null` fields |
| `ENVELOPE` without `COLLECTION` and `IMPORTRESULT` unsupported | Some real Tally exports are rejected with 422 instead of being processed |
| Unknown fields only in the raw upload | They cannot be queried until a later reprocess |
| No authentication, rate limiting or encryption at rest | Not safe to expose publicly. See section 11 |
| SQLite, single file | One writer and no horizontal scaling |
| Raw bytes stored as a BLOB | Fine at 10 MiB, wrong at 500 MB (see section 12) |
| `server.ts` (signals and shutdown) has no automated test | Verified manually only |
| Duplicate detection is exact-byte only | Equivalent XML with different whitespace creates a new import. This is as the assignment specifies |
 
### What I would implement next
 
1. Per-voucher validation and `partial` status (the schema already supports it, and rows are removed by cascade).
2. Streaming ingestion with checkpoints, as in section 12.
3. Pagination on the vouchers endpoint.
4. The `IMPORTRESULT` alternate envelope.
5. Authentication, rate limiting and PostgreSQL.
6. A test for graceful shutdown and a real multi-process concurrency test.
---
 
## 14. AI usage disclosure
 
**Tool used:** Claude (Anthropic), used conversationally during development.
 
**What it helped with:**
 
- Discussing the assignment and its scoring, and planning the architecture (stack, schema, module split).
- Generating first drafts of the source files and tests, one file at a time.
- Explaining errors (TypeScript and PowerShell issues) and proposing fixes.
- Drafting this README & Proper Comments.
**What I personally verified or changed:**
 
> **Scoped the work myself.** I read all four assignment documents and the seven
  fixtures, chose the stack (Express, TypeScript, SQLite), and decided to keep a
  single committed `.env` containing only non-secret defaults so a reviewer can
  start the project with one command.
> **Built it incrementally, one file at a time, and ran every step.** After each
  file I ran `npm run typecheck` and `npm test` myself rather than accepting the
  generated code on trust. The suite was green at each stage.
> **Checked behaviour against the fixtures, not only the compiler.** I confirmed
  details that matter for correctness: fixture 06 is byte-identical to 01 (the
  idempotency case), fixture 01 uses `<n>` where fixture 02 uses `<NAME>`
  (so the mapper accepts both), fixture 02 contains an unknown `PERSISTEDVIEW`
  child (the unknown-child warning case), and fixture 04 is UTF-16 with an illegal
  `&#4;` reference.
 
I can explain and safely modify every design decision in this submission.
 
---
 
## 15. Submission checklist mapping
 
| Checklist item | Where |
| --- | --- |
| Stopped at or before 6 hours, time recorded | Section 13 (**fill in the number**) |
| `GET /health` works | `src/routes/health.ts`, `tests/api.test.ts` |
| `POST /api/tally/imports` accepts multipart field `file` | `src/middleware/upload.ts`, `src/routes/imports.ts` |
| `GET /api/tally/imports/{importId}` returns details | `src/routes/imports.ts` |
| `GET .../vouchers` returns the normalized contract | `src/repo/importRepo.ts`, `tests/api.test.ts` (exact JSON equality for fixture 01) |
| Both `ENVELOPE` and `RESPONSE` handled | `src/normalize/voucher.ts`, `src/normalize/response.ts`, `src/services/importService.ts` |
| Repeated `.LIST` nodes remain arrays under their direct parent | `src/normalize/voucher.ts`, `tests/voucher.test.ts` |
| Signed amounts lossless, no binary floating point | All money is `TEXT` (`STRICT` tables), never parsed |
| UTF-8, BOM and UTF-16 behavior tested | `tests/decode.test.ts`, `tests/api.test.ts` |
| Duplicate content idempotent regardless of filename | `tests/api.test.ts` (fixtures 01 and 06), `tests/importRepo.test.ts` |
| Exact-byte SHA-256 uniqueness enforced atomically in persistence | `UNIQUE(content_hash)` in `src/db/migrations.ts`, `ON CONFLICT DO NOTHING` in `saveImport` |
| Import warnings and errors persisted | `imports.warnings_json` / `errors_json` |
| Raw source retained | `import_sources.raw_content`, asserted byte-for-byte in tests |
| `ERRORS` / `LINEERROR` give `businessStatus: failed` without confusing upload acceptance | `src/normalize/response.ts`, `tests/api.test.ts` |
| Unknown children do not crash and produce a warning | `tests/voucher.test.ts`, `tests/api.test.ts` |
| Empty collection completes with zero vouchers | `tests/api.test.ts` |
| Tests run with one documented command | `npm test` |
| Database setup/migrations documented | Section 2 |
| 500 MB ingestion design explained | Section 12 |
| Security assumptions explained | Section 11 |
| Incomplete work and next steps stated honestly | Section 13 |
| AI tool usage disclosed | Section 14 (**complete the verification part**) |
| Per-voucher partial failure tested, if claimed | Not claimed |
| Every attempted optional extension listed | Section 13 |
 
---
 
## 16. Project layout
 
```
.env                      non-secret defaults (see section 2)
fixtures/                 the seven sample XML files
src/
  config.ts               validated environment config
  logger.ts               pino, with redaction and safe error serializer
  errors.ts               structured, client-safe error types
  warnings.ts             the ImportWarning type
  app.ts                  builds the Express app (testable, no listener)
  server.ts               startup, timeouts, graceful shutdown
  db/
    connection.ts         SQLite open + pragmas
    migrations.ts         numbered SQL migrations (the schema)
    migrate.ts            migration runner and CLI
  xml/
    decode.ts             BOM detection, strict decoding, SHA-256
    sanitize.ts           removal of illegal XML 1.0 characters
    tree.ts               safe saxes parser → ordered element tree, direct-child helpers
  normalize/
    voucher.ts            ENVELOPE → normalized vouchers (direct-parent mapping)
    response.ts           RESPONSE → counters and businessStatus
  repo/importRepo.ts      all SQL: atomic save, idempotency, rebuild vouchers
  services/importService.ts  orchestration, document type, status, logging
  routes/                 health.ts, imports.ts
  middleware/             upload.ts, errors.ts
tests/                    behavioral tests (kept outside src, not shipped in dist)
```
 
---
 
## 17. Troubleshooting
 
- **`curl` in PowerShell behaves strangely:** use `curl.exe`, not `curl`.
- **`--env-file` not recognized:** your Node is older than 20.6. Check `node -v`.
- **`better-sqlite3` fails to install or load:** use a Node version that has a prebuilt binary, or install a C++ build toolchain.
- **Project inside OneDrive/Dropbox:** sync can lock `node_modules` and the SQLite files. Keep the project in a plain folder.
- **Postman upload returns `FILE_REQUIRED`:** the key must be named exactly `file` and its type set to **File**, and you must not override the `Content-Type` header.
- **A re-upload returns `200` instead of `201`:** the exact same bytes were already imported. That is the idempotency feature. Delete `data/tally.db*` to reset local data.
 
