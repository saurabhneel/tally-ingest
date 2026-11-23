import { describe, it, expect, beforeEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, type Db } from "../src/db/connection";
import { runMigrations } from "../src/db/migrate";
import { createLogger, type AppLogger } from "../src/logger";
import { ImportRepository } from "../src/repo/importRepo";
import { ImportService } from "../src/services/importService";
import { sha256Hex } from "../src/xml/decode";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "..", "fixtures", name));

let db: Db;
let logger: AppLogger;
let service: ImportService;

beforeEach(() => {
  db = openDatabase(":memory:");
  runMigrations(db);
  logger = createLogger({ LOG_LEVEL: "silent", NODE_ENV: "test" });
  service = new ImportService(new ImportRepository(db), logger);
});

const count = (table: string) =>
  (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

const upload = (xml: string | Buffer, filename = "test.xml") => ({
  bytes: Buffer.isBuffer(xml) ? xml : Buffer.from(xml, "utf8"),
  filename,
});

describe("fixtures end to end", () => {
  it("01: voucher export with allocations", () => {
    const { record, duplicate } = service.importDocument({
      bytes: fixture("01_receipt_with_allocations.xml"),
      filename: "a.xml",
    });
    expect(duplicate).toBe(false);
    expect(record).toMatchObject({
      documentType: "voucherExport",
      status: "completed",
      detectedEncoding: "UTF-8",
      summary: {
        vouchers: 1,
        ledgerEntries: 2,
        inventoryEntries: 0,
        warnings: 0,
        errors: 0,
      },
      warnings: [],
      errors: [],
    });
    expect(record.contentHash).toBe(
      sha256Hex(fixture("01_receipt_with_allocations.xml")),
    );
  });

  it("02: nested invoice reports the unknown child as a warning", () => {
    const { record } = service.importDocument({
      bytes: fixture("02_sales_invoice_nested.xml"),
    });
    expect(record.summary).toMatchObject({
      vouchers: 1,
      ledgerEntries: 3,
      inventoryEntries: 1,
      warnings: 1,
    });
    expect(record.warnings[0]).toMatchObject({
      code: "UNKNOWN_ELEMENT_NOT_NORMALIZED",
      path: "VOUCHER/PERSISTEDVIEW",
    });
  });

  it("03: Tally error response is accepted but is a business failure", () => {
    const { record, duplicate } = service.importDocument({
      bytes: fixture("03_tally_error_response.xml"),
    });
    expect(duplicate).toBe(false);
    expect(record.documentType).toBe("tallyResponse");
    expect(record.status).toBe("completed");
    expect(record.tallyResponse?.businessStatus).toBe("failed");
    expect(record.tallyResponse?.counters.ERRORS).toBe("1");
    expect(record.summary).toEqual({
      vouchers: 0,
      ledgerEntries: 0,
      inventoryEntries: 0,
      warnings: 0,
      errors: 0,
    });
    expect(service.getVouchers(record.importId)).toEqual([]);
  });

  it("04: UTF-16 with an illegal reference completes with a warning", () => {
    const { record } = service.importDocument({
      bytes: fixture("04_utf16_invalid_control_ref.xml"),
    });
    expect(record.status).toBe("completed");
    expect(record.detectedEncoding).toBe("UTF-16LE");
    expect(record.summary).toMatchObject({
      vouchers: 1,
      ledgerEntries: 2,
      warnings: 1,
    });
    expect(record.warnings[0]?.code).toBe(
      "ILLEGAL_XML_CHARACTER_REFERENCE_REMOVED",
    );
    const [v] = service.getVouchers(record.importId);
    expect(v!.narration).toBe("Recoverable control reference  in UTF-16 input");
  });

  it("05: empty collection completes with zero counts", () => {
    const { record } = service.importDocument({
      bytes: fixture("05_empty_collection.xml"),
    });
    expect(record.status).toBe("completed");
    expect(record.summary).toEqual({
      vouchers: 0,
      ledgerEntries: 0,
      inventoryEntries: 0,
      warnings: 0,
      errors: 0,
    });
    expect(service.getVouchers(record.importId)).toEqual([]);
  });

  it("07: UTF-8 BOM is detected and parsed", () => {
    const { record } = service.importDocument({
      bytes: fixture("07_utf8_bom_payment.xml"),
    });
    expect(record.detectedEncoding).toBe("UTF-8-BOM");
    expect(record.summary).toMatchObject({
      vouchers: 1,
      ledgerEntries: 2,
      warnings: 0,
    });
  });
});

describe("idempotency", () => {
  it("06 duplicates 01: same import returned, no duplicate vouchers", () => {
    const first = service.importDocument({
      bytes: fixture("01_receipt_with_allocations.xml"),
      filename: "one.xml",
    });
    const second = service.importDocument({
      bytes: fixture("06_duplicate_receipt.xml"),
      filename: "two.xml",
    });
    expect(second.duplicate).toBe(true);
    expect(second.record.importId).toBe(first.record.importId);
    expect(count("imports")).toBe(1);
    expect(count("vouchers")).toBe(1);
    expect(count("ledger_entries")).toBe(2);
  });

  it("treats whitespace-different XML as different content", () => {
    const base = fixture("05_empty_collection.xml");
    const a = service.importDocument({ bytes: base });
    const b = service.importDocument({
      bytes: Buffer.concat([base, Buffer.from("\n")]),
    });
    expect(b.duplicate).toBe(false);
    expect(b.record.importId).not.toBe(a.record.importId);
    expect(count("imports")).toBe(2);
  });
});

describe("rejection", () => {
  it("rejects malformed XML with 422 and stores nothing", () => {
    expect(
      caught(() => service.importDocument(upload("<a><b></a>"))),
    ).toMatchObject({
      code: "INVALID_XML",
      status: 422,
    });
    expect(count("imports")).toBe(0);
  });

  it("rejects an empty upload", () => {
    expect(
      caught(() => service.importDocument({ bytes: Buffer.alloc(0) })),
    ).toMatchObject({
      code: "INVALID_XML",
    });
  });

  it("rejects an unsupported root element", () => {
    expect(
      caught(() => service.importDocument(upload("<FOO/>"))),
    ).toMatchObject({
      code: "UNSUPPORTED_DOCUMENT",
    });
    expect(count("imports")).toBe(0);
  });

  it("rejects a DOCTYPE (entity-expansion and XXE defense)", () => {
    const xml =
      '<?xml version="1.0"?><!DOCTYPE r [<!ENTITY x SYSTEM "file:///etc/passwd">]><RESPONSE>&x;</RESPONSE>';
    const err = caught(() => service.importDocument(upload(xml))) as {
      code: string;
    };
    expect(["UNSUPPORTED_DOCUMENT", "INVALID_XML"]).toContain(err.code);
    expect(count("imports")).toBe(0);
  });

  it("rejects undecodable bytes", () => {
    expect(
      caught(() =>
        service.importDocument({
          bytes: Buffer.from([0x3c, 0xff, 0xfe, 0x3e]),
        }),
      ),
    ).toMatchObject({
      code: "UNSUPPORTED_ENCODING",
    });
  });

  it("allows the same bytes to be imported after a different rejected upload", () => {
    caught(() => service.importDocument(upload("<FOO/>")));
    expect(
      service.importDocument(upload("<RESPONSE><ERRORS>0</ERRORS></RESPONSE>"))
        .duplicate,
    ).toBe(false);
  });
});

describe("warnings", () => {
  it("warns when the declared encoding disagrees with the bytes, without echoing it", () => {
    const xml =
      '<?xml version="1.0" encoding="ISO-8859-1"?><RESPONSE><ERRORS>0</ERRORS></RESPONSE>';
    const { record } = service.importDocument(upload(xml));
    expect(record.warnings).toEqual([
      expect.objectContaining({
        code: "ENCODING_DECLARATION_MISMATCH",
        details: { detectedEncoding: "UTF-8" },
      }),
    ]);
    expect(JSON.stringify(record.warnings)).not.toContain("8859");
  });

  it("does not warn when the declaration agrees", () => {
    const xml =
      '<?xml version="1.0" encoding="utf-8"?><RESPONSE><ERRORS>0</ERRORS></RESPONSE>';
    expect(service.importDocument(upload(xml)).record.warnings).toEqual([]);
  });
});

describe("details and safety", () => {
  it("returns details and vouchers, and 404s for unknown ids", () => {
    const { record } = service.importDocument({
      bytes: fixture("07_utf8_bom_payment.xml"),
    });
    expect(service.getImportDetails(record.importId)).toEqual(record);
    expect(service.getVouchers(record.importId)).toHaveLength(1);
    expect(caught(() => service.getImportDetails("missing"))).toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
    expect(caught(() => service.getVouchers("missing"))).toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("never exposes the filename or raw XML in import details", () => {
    const { record } = service.importDocument({
      bytes: fixture("01_receipt_with_allocations.xml"),
      filename: "secret-client-name.xml",
    });
    const json = JSON.stringify(service.getImportDetails(record.importId));
    expect(json).not.toContain("secret-client-name");
    expect(json).not.toContain("<VOUCHER");
    expect(json).not.toContain("RCP-DEMO-001");
  });

  it("stores only a sanitized final path segment as the audit filename", () => {
    service.importDocument({
      bytes: fixture("05_empty_collection.xml"),
      filename: "..\\..\\etc/passwd.xml\u0000",
    });
    const row = db
      .prepare("SELECT original_filename AS f FROM imports")
      .get() as { f: string };
    expect(row.f).toBe("passwd.xml");
  });

  it("logs metadata only, never document content", () => {
    const info = vi.spyOn(logger, "info");
    const warn = vi.spyOn(logger, "warn");
    service.importDocument({
      bytes: fixture("01_receipt_with_allocations.xml"),
      filename: "x.xml",
    });
    caught(() =>
      service.importDocument(upload("<a>Demo Customer &bogus;</a>")),
    );

    const logged = JSON.stringify([...info.mock.calls, ...warn.mock.calls]);
    expect(info).toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();
    expect(logged).not.toContain("Demo Customer");
    expect(logged).not.toContain("RCP-DEMO-001");
    expect(logged).not.toContain("<VOUCHER");
  });
});
