import { describe, it, expect, beforeEach } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Express } from "express";
import { createApp } from "../src/app";
import { loadConfig } from "../src/config";
import { openDatabase, type Db } from "../src/db/connection";
import { runMigrations } from "../src/db/migrate";
import { createLogger } from "../src/logger";
import { sha256Hex } from "../src/xml/decode";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "..", "fixtures", name));

function build(env: Record<string, string> = {}): { app: Express; db: Db } {
  const config = loadConfig({
    NODE_ENV: "test",
    LOG_LEVEL: "silent",
    DATABASE_PATH: ":memory:",
    ...env,
  });
  const db = openDatabase(":memory:");
  runMigrations(db);
  return { app: createApp({ config, logger: createLogger(config), db }), db };
}

const upload = (app: Express, bytes: Buffer, filename = "upload.xml") =>
  request(app).post("/api/tally/imports").attach("file", bytes, filename);

let app: Express;
let db: Db;

beforeEach(() => {
  ({ app, db } = build());
});

const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

describe("GET /health", () => {
  it("returns 200 with a JSON status and hardened headers", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body).toEqual({ status: "ok", service: "tally-ingest" });
    expect(res.headers["x-powered-by"]).toBeUndefined();
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
  });

  it("returns 503 when the database is unavailable", async () => {
    db.close();
    const res = await request(app).get("/health");
    expect(res.status).toBe(503);
    expect(res.body).toEqual({
      status: "unavailable",
      service: "tally-ingest",
    });
  });
});

describe("required scenario 1 and 2: ordered entries, no overwritten AMOUNT values", () => {
  it("returns the exact normalized contract for fixture 01", async () => {
    const bytes = fixture("01_receipt_with_allocations.xml");
    const created = await upload(app, bytes);
    expect(created.status).toBe(201);
    expect(created.headers["location"]).toBe(
      `/api/tally/imports/${created.body.importId}`,
    );
    expect(created.body).toEqual({
      importId: expect.any(String),
      documentType: "voucherExport",
      status: "completed",
      duplicate: false,
      summary: {
        vouchers: 1,
        ledgerEntries: 2,
        inventoryEntries: 0,
        warnings: 0,
        errors: 0,
      },
    });

    const res = await request(app).get(
      `/api/tally/imports/${created.body.importId}/vouchers`,
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.items).toEqual([
      {
        source: {
          importId: created.body.importId,
          contentHash: sha256Hex(bytes),
          voucherIndex: 0,
        },
        attributes: { VCHTYPE: "Receipt", ACTION: "Create" },
        date: "20260715",
        voucherType: "Receipt",
        voucherNumber: "RCP-DEMO-001",
        partyLedgerName: "Demo Customer",
        narration: "Sanitized receipt fixture",
        ledgerEntries: [
          {
            sourceTag: "ALLLEDGERENTRIES.LIST",
            ledgerName: "Demo Bank",
            isDeemedPositive: "No",
            amount: "1250.00",
            billAllocations: [],
            bankAllocations: [
              {
                date: "20260715",
                name: "UTR-DEMO-001",
                transactionType: "Inter Bank Transfer",
                amount: "1250.00",
              },
            ],
            rateDetails: [],
          },
          {
            sourceTag: "ALLLEDGERENTRIES.LIST",
            ledgerName: "Demo Customer",
            isDeemedPositive: "Yes",
            amount: "-1250.00",
            billAllocations: [
              {
                name: "INV-DEMO-001",
                billType: "Agst Ref",
                amount: "-1250.00",
              },
            ],
            bankAllocations: [],
            rateDetails: [],
          },
        ],
        inventoryEntries: [],
        warnings: [],
      },
    ]);
  });

  it("keeps ledger, bill, inventory, batch and accounting amounts separate (fixture 02)", async () => {
    const created = await upload(app, fixture("02_sales_invoice_nested.xml"));
    expect(created.status).toBe(201);
    expect(created.body.summary).toEqual({
      vouchers: 1,
      ledgerEntries: 3,
      inventoryEntries: 1,
      warnings: 1,
      errors: 0,
    });

    const res = await request(app).get(
      `/api/tally/imports/${created.body.importId}/vouchers`,
    );
    const v = res.body.items[0];
    expect(
      v.ledgerEntries.map((e: { sourceTag: string }) => e.sourceTag),
    ).toEqual(Array(3).fill("LEDGERENTRIES.LIST"));
    expect(v.ledgerEntries.map((e: { amount: string }) => e.amount)).toEqual([
      "-118.00",
      "9.00",
      "9.00",
    ]);
    expect(v.ledgerEntries[0].billAllocations[0].amount).toBe("-118.00");

    const inv = v.inventoryEntries[0];
    expect(inv.amount).toBe("100.00");
    expect(inv.actualQty).toBe("2 PCS");
    expect(inv.rate).toBe("50.00/PCS");
    expect(inv.batchAllocations[0].amount).toBe("100.00");
    expect(inv.accountingAllocations[0].amount).toBe("100.00");
    expect(inv.accountingAllocations[0].rateDetails).toEqual([
      { dutyHead: "CGST", rate: "9" },
      { dutyHead: "SGST/UTGST", rate: "9" },
    ]);
    expect(v.ledgerEntries[1].rateDetails).toEqual([
      { dutyHead: "CGST", rate: "9" },
    ]);
  });
});

describe("required scenario 3: duplicate bytes under a different filename", () => {
  it("returns 200 with the original import and no duplicate rows", async () => {
    const first = await upload(
      app,
      fixture("01_receipt_with_allocations.xml"),
      "one.xml",
    );
    const second = await upload(
      app,
      fixture("06_duplicate_receipt.xml"),
      "completely-different.xml",
    );

    expect(first.status).toBe(201);
    expect(first.body.duplicate).toBe(false);
    expect(second.status).toBe(200);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.importId).toBe(first.body.importId);
    expect(count("imports")).toBe(1);
    expect(count("vouchers")).toBe(1);
    expect(count("ledger_entries")).toBe(2);

    const vouchers = await request(app).get(
      `/api/tally/imports/${first.body.importId}/vouchers`,
    );
    expect(vouchers.body.count).toBe(1);
  });

  it("produces exactly one import from simultaneous identical uploads", async () => {
    const bytes = fixture("02_sales_invoice_nested.xml");
    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => upload(app, bytes, `copy-${i}.xml`)),
    );
    const statuses = results.map((r) => r.status).sort();
    expect(statuses).toEqual([200, 200, 200, 200, 200, 200, 200, 201]);
    expect(new Set(results.map((r) => r.body.importId)).size).toBe(1);
    expect(count("imports")).toBe(1);
    expect(count("vouchers")).toBe(1);
    expect(count("inventory_entries")).toBe(1);
  });
});

describe("required scenario 4: encodings and illegal control references", () => {
  it("recovers UTF-16 with an illegal reference and records a warning", async () => {
    const bytes = fixture("04_utf16_invalid_control_ref.xml");
    const created = await upload(app, bytes);
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("completed");
    expect(created.body.summary.warnings).toBe(1);

    const details = await request(app).get(
      `/api/tally/imports/${created.body.importId}`,
    );
    expect(details.status).toBe(200);
    expect(details.body).toMatchObject({
      importId: created.body.importId,
      documentType: "voucherExport",
      status: "completed",
      contentHash: sha256Hex(bytes),
      detectedEncoding: "UTF-16LE",
      errors: [],
    });
    expect(details.body.warnings).toEqual([
      expect.objectContaining({
        code: "ILLEGAL_XML_CHARACTER_REFERENCE_REMOVED",
      }),
    ]);

    const vouchers = await request(app).get(
      `/api/tally/imports/${created.body.importId}/vouchers`,
    );
    expect(vouchers.body.items[0].voucherNumber).toBe("JRN-DEMO-UTF16");
    expect(vouchers.body.items[0].ledgerEntries).toHaveLength(2);
  });

  it("detects the UTF-8 BOM", async () => {
    const created = await upload(app, fixture("07_utf8_bom_payment.xml"));
    expect(created.status).toBe(201);
    const details = await request(app).get(
      `/api/tally/imports/${created.body.importId}`,
    );
    expect(details.body.detectedEncoding).toBe("UTF-8-BOM");
    expect(details.body.warnings).toEqual([]);
  });

  it("retains the exact uploaded bytes as the raw source", async () => {
    const bytes = fixture("04_utf16_invalid_control_ref.xml");
    await upload(app, bytes);
    const row = db
      .prepare("SELECT raw_content AS raw FROM import_sources")
      .get() as { raw: Buffer };
    expect(row.raw.equals(bytes)).toBe(true);
  });
});

describe("required scenario 5: Tally business failure vs upload acceptance", () => {
  it("accepts the upload (201) while the Tally result is failed", async () => {
    const created = await upload(app, fixture("03_tally_error_response.xml"));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      documentType: "tallyResponse",
      status: "completed",
      duplicate: false,
    });

    const details = await request(app).get(
      `/api/tally/imports/${created.body.importId}`,
    );
    expect(details.body.status).toBe("completed");
    expect(details.body.tallyResponse).toEqual({
      businessStatus: "failed",
      counters: {
        CREATED: "0",
        ALTERED: "0",
        DELETED: "0",
        IGNORED: "1",
        ERRORS: "1",
      },
      lineError: "Demo ledger does not exist",
    });

    const vouchers = await request(app).get(
      `/api/tally/imports/${created.body.importId}/vouchers`,
    );
    expect(vouchers.status).toBe(200);
    expect(vouchers.body).toEqual({ items: [], count: 0 });
  });

  it("does not include tallyResponse in a voucher export", async () => {
    const created = await upload(
      app,
      fixture("01_receipt_with_allocations.xml"),
    );
    const details = await request(app).get(
      `/api/tally/imports/${created.body.importId}`,
    );
    expect(details.body).not.toHaveProperty("tallyResponse");
  });
});

describe("required scenario 6: empty collection and unknown child", () => {
  it("completes an empty collection with zero counts and no vouchers", async () => {
    const created = await upload(app, fixture("05_empty_collection.xml"));
    expect(created.status).toBe(201);
    expect(created.body.status).toBe("completed");
    expect(created.body.summary).toEqual({
      vouchers: 0,
      ledgerEntries: 0,
      inventoryEntries: 0,
      warnings: 0,
      errors: 0,
    });
    const vouchers = await request(app).get(
      `/api/tally/imports/${created.body.importId}/vouchers`,
    );
    expect(vouchers.body).toEqual({ items: [], count: 0 });
  });

  it("warns about an unknown child without crashing or inventing data", async () => {
    const xml = `<ENVELOPE><BODY><DATA><COLLECTION>
      <VOUCHER VCHTYPE="Journal">
        <DATE>20260101</DATE>
        <UDF:CUSTOMFIELD.LIST><UDF:VALUE>secret-custom-value</UDF:VALUE></UDF:CUSTOMFIELD.LIST>
      </VOUCHER>
      <MYSTERYOBJECT><NAME>not a voucher</NAME></MYSTERYOBJECT>
    </COLLECTION></DATA></BODY></ENVELOPE>`;
    const created = await upload(app, Buffer.from(xml));
    expect(created.status).toBe(201);
    expect(created.body.summary).toMatchObject({ vouchers: 1, warnings: 2 });

    const details = await request(app).get(
      `/api/tally/imports/${created.body.importId}`,
    );
    const paths = details.body.warnings
      .map((w: { path: string }) => w.path)
      .sort();
    expect(paths).toEqual([
      "ENVELOPE/BODY/DATA/COLLECTION/MYSTERYOBJECT",
      "VOUCHER/UDF:CUSTOMFIELD.LIST",
    ]);
    expect(JSON.stringify(details.body)).not.toContain("secret-custom-value");

    const vouchers = await request(app).get(
      `/api/tally/imports/${created.body.importId}/vouchers`,
    );
    expect(vouchers.body.count).toBe(1);
    expect(vouchers.body.items[0].date).toBe("20260101");
  });
});

describe("errors", () => {
  it("returns FILE_REQUIRED when no file is sent", async () => {
    const res = await request(app)
      .post("/api/tally/imports")
      .field("note", "x");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("FILE_REQUIRED");
  });

  it("returns 422 INVALID_XML for malformed XML, stores nothing, and leaks nothing", async () => {
    const res = await upload(app, Buffer.from("<a>secret-ledger <b></a>"));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("INVALID_XML");
    expect(Object.keys(res.body)).toEqual(["error"]);
    const text = JSON.stringify(res.body);
    expect(text).not.toContain("secret-ledger");
    expect(text).not.toContain("stack");
    expect(text).not.toContain("node_modules");
    expect(count("imports")).toBe(0);
  });

  it("returns 422 for an unsupported root element", async () => {
    const res = await upload(app, Buffer.from("<FOO/>"));
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("UNSUPPORTED_DOCUMENT");
  });

  it("rejects a DOCTYPE / external entity document", async () => {
    const xml =
      '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><RESPONSE>&x;</RESPONSE>';
    const res = await upload(app, Buffer.from(xml));
    expect(res.status).toBe(422);
    expect(count("imports")).toBe(0);
  });

  it("enforces the configurable upload size limit with 413", async () => {
    const small = build({ MAX_UPLOAD_BYTES: "200" });
    const res = await upload(small.app, fixture("02_sales_invoice_nested.xml"));
    expect(res.status).toBe(413);
    expect(res.body.error).toMatchObject({
      code: "PAYLOAD_TOO_LARGE",
      details: { maxBytes: 200 },
    });
    expect(
      (
        small.db.prepare("SELECT COUNT(*) AS c FROM imports").get() as {
          c: number;
        }
      ).c,
    ).toBe(0);
  });

  it("returns 404 for unknown, malformed and wrongly shaped import ids", async () => {
    const unknown = "00000000-0000-4000-8000-000000000000";
    for (const path of [
      `/api/tally/imports/${unknown}`,
      `/api/tally/imports/${unknown}/vouchers`,
      "/api/tally/imports/not-a-uuid",
      "/api/tally/imports/1'%20OR%20'1'='1/vouchers",
    ]) {
      const res = await request(app).get(path);
      expect(res.status, path).toBe(404);
      expect(res.body).toEqual({
        error: { code: "NOT_FOUND", message: "Import not found." },
      });
    }
  });

  it("returns a structured 404 for unknown routes", async () => {
    const res = await request(app).get("/api/tally/other");
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });
});

describe("response safety", () => {
  it("never exposes raw XML, filenames or filesystem paths in details", async () => {
    const created = await upload(
      app,
      fixture("01_receipt_with_allocations.xml"),
      "C:\\clients\\acme-secret.xml",
    );
    const details = await request(app).get(
      `/api/tally/imports/${created.body.importId}`,
    );
    const text = JSON.stringify(details.body);
    expect(text).not.toContain("acme-secret");
    expect(text).not.toContain("C:\\");
    expect(text).not.toContain("<VOUCHER");
    expect(text).not.toContain("RCP-DEMO-001");
    expect(Object.keys(details.body).sort()).toEqual([
      "contentHash",
      "detectedEncoding",
      "documentType",
      "errors",
      "importId",
      "status",
      "summary",
      "warnings",
    ]);
  });

  it("marks import responses as non-cacheable", async () => {
    const created = await upload(app, fixture("05_empty_collection.xml"));
    expect(created.headers["cache-control"]).toBe("no-store");
    const details = await request(app).get(
      `/api/tally/imports/${created.body.importId}`,
    );
    expect(details.headers["cache-control"]).toBe("no-store");
  });

  it("uses lowercase 64-character SHA-256 hex of the exact bytes as the content hash", async () => {
    const bytes = fixture("07_utf8_bom_payment.xml");
    const created = await upload(app, bytes);
    const details = await request(app).get(
      `/api/tally/imports/${created.body.importId}`,
    );
    expect(details.body.contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(details.body.contentHash).toBe(sha256Hex(bytes));
  });
});
