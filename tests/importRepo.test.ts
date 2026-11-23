import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type Db } from "../src/db/connection";
import { runMigrations } from "../src/db/migrate";
import { ImportRepository, type NewImport } from "../src/repo/importRepo";
import { decodeDocument, sha256Hex } from "../src/xml/decode";
import { sanitizeXmlText } from "../src/xml/sanitize";
import { parseXmlTree } from "../src/xml/tree";
import { normalizeVoucherExport } from "../src/normalize/voucher";
import { normalizeTallyResponse } from "../src/normalize/response";

const fixtureBytes = (name: string) =>
  readFileSync(join(__dirname, "..", "fixtures", name));

/** Builds a NewImport the way the import service will (minus validation). */
function buildImport(fixture: string, filename: string = fixture): NewImport {
  const raw = fixtureBytes(fixture);
  const decoded = decodeDocument(raw);
  const sanitized = sanitizeXmlText(decoded.text);
  const root = parseXmlTree(sanitized.text);
  const base = {
    contentHash: sha256Hex(raw),
    originalFilename: filename,
    rawContent: raw,
    detectedEncoding: decoded.detectedEncoding,
    status: "completed" as const,
    errors: [],
  };

  if (root.name === "RESPONSE") {
    const r = normalizeTallyResponse(root);
    const warnings = [...sanitized.warnings, ...r.warnings];
    return {
      ...base,
      documentType: "tallyResponse",
      warnings,
      summary: {
        vouchers: 0,
        ledgerEntries: 0,
        inventoryEntries: 0,
        warnings: warnings.length,
        errors: 0,
      },
      tallyResponse: r.tallyResponse,
      vouchers: [],
    };
  }

  const n = normalizeVoucherExport(root);
  const warnings = [...sanitized.warnings, ...n.warnings];
  return {
    ...base,
    documentType: "voucherExport",
    warnings,
    summary: {
      vouchers: n.vouchers.length,
      ledgerEntries: n.vouchers.reduce(
        (s, v) => s + v.data.ledgerEntries.length,
        0,
      ),
      inventoryEntries: n.vouchers.reduce(
        (s, v) => s + v.data.inventoryEntries.length,
        0,
      ),
      warnings: warnings.length,
      errors: 0,
    },
    tallyResponse: null,
    vouchers: n.vouchers,
  };
}

const count = (db: Db, table: string) =>
  (db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;

let db: Db;
let repo: ImportRepository;

beforeEach(() => {
  db = openDatabase(":memory:");
  runMigrations(db);
  repo = new ImportRepository(db);
});

describe("round trip", () => {
  it("stores and rebuilds fixture 01 exactly as normalized", () => {
    const input = buildImport("01_receipt_with_allocations.xml");
    const { record, duplicate } = repo.saveImport(input);
    expect(duplicate).toBe(false);
    expect(record).toMatchObject({
      documentType: "voucherExport",
      status: "completed",
      contentHash: input.contentHash,
      summary: {
        vouchers: 1,
        ledgerEntries: 2,
        inventoryEntries: 0,
        warnings: 0,
        errors: 0,
      },
    });
    expect(record.tallyResponse).toBeUndefined();

    const items = repo.getVouchers(record.importId)!;
    expect(items).toEqual([
      {
        source: {
          importId: record.importId,
          contentHash: input.contentHash,
          voucherIndex: 0,
        },
        ...input.vouchers[0]!.data,
      },
    ]);
    expect(items[0]!.ledgerEntries[1]!.amount).toBe("-1250.00");
  });

  it("stores and rebuilds fixture 02 with the whole nested tree and its warnings", () => {
    const input = buildImport("02_sales_invoice_nested.xml");
    const { record } = repo.saveImport(input);
    expect(record.summary).toMatchObject({
      vouchers: 1,
      ledgerEntries: 3,
      inventoryEntries: 1,
      warnings: 1,
    });

    const [item] = repo.getVouchers(record.importId)!;
    expect(item).toEqual({
      source: {
        importId: record.importId,
        contentHash: input.contentHash,
        voucherIndex: 0,
      },
      ...input.vouchers[0]!.data,
    });
    expect(item!.ledgerEntries[1]!.rateDetails).toEqual([
      { dutyHead: "CGST", rate: "9" },
    ]);
    expect(
      item!.inventoryEntries[0]!.accountingAllocations[0]!.rateDetails,
    ).toHaveLength(2);
    expect(item!.warnings[0]).toMatchObject({ path: "VOUCHER/PERSISTEDVIEW" });
    expect(record.warnings[0]).toMatchObject({ path: "VOUCHER/PERSISTEDVIEW" });
  });

  it("stores a tallyResponse with its details and zero vouchers", () => {
    const { record } = repo.saveImport(
      buildImport("03_tally_error_response.xml"),
    );
    expect(record.documentType).toBe("tallyResponse");
    expect(record.tallyResponse).toEqual({
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
    expect(repo.getVouchers(record.importId)).toEqual([]);
    expect(count(db, "vouchers")).toBe(0);
  });

  it("stores an empty collection as completed with zero vouchers", () => {
    const { record } = repo.saveImport(buildImport("05_empty_collection.xml"));
    expect(record.status).toBe("completed");
    expect(record.summary.vouchers).toBe(0);
    expect(repo.getVouchers(record.importId)).toEqual([]);
  });

  it("persists the sanitizer warning for the UTF-16 fixture", () => {
    const { record } = repo.saveImport(
      buildImport("04_utf16_invalid_control_ref.xml"),
    );
    expect(record.detectedEncoding).toBe("UTF-16LE");
    expect(record.warnings.map((w) => w.code)).toContain(
      "ILLEGAL_XML_CHARACTER_REFERENCE_REMOVED",
    );
    expect(record.summary.warnings).toBe(record.warnings.length);
  });

  it("returns null for an unknown import", () => {
    expect(repo.getImport("nope")).toBeNull();
    expect(repo.getVouchers("nope")).toBeNull();
    expect(repo.getRawSource("nope")).toBeNull();
  });
});

describe("idempotency", () => {
  it("returns the original import for identical bytes under a different filename", () => {
    const first = repo.saveImport(
      buildImport("01_receipt_with_allocations.xml"),
    );
    const second = repo.saveImport(buildImport("06_duplicate_receipt.xml"));

    expect(first.duplicate).toBe(false);
    expect(second.duplicate).toBe(true);
    expect(second.record.importId).toBe(first.record.importId);
    expect(count(db, "imports")).toBe(1);
    expect(count(db, "vouchers")).toBe(1);
    expect(count(db, "ledger_entries")).toBe(2);
    expect(count(db, "import_sources")).toBe(1);
  });

  it("enforces uniqueness in the database itself, not only in application code", () => {
    const input = buildImport("01_receipt_with_allocations.xml");
    repo.saveImport(input);
    const insertRaw = () =>
      db
        .prepare(
          `INSERT INTO imports (id, content_hash, byte_size, detected_encoding, document_type, status)
           VALUES ('other', ?, 1, 'UTF-8', 'voucherExport', 'completed')`,
        )
        .run(input.contentHash);
    expect(insertRaw).toThrow(/UNIQUE/);
  });

  it("is enforced across separate connections to the same database file", () => {
    const dir = mkdtempSync(join(tmpdir(), "tally-ingest-"));
    const file = join(dir, "test.db");
    const a = openDatabase(file);
    runMigrations(a);
    const b = openDatabase(file);
    try {
      const input = buildImport("01_receipt_with_allocations.xml");
      const r1 = new ImportRepository(a).saveImport(input);
      const r2 = new ImportRepository(b).saveImport(input);
      expect(r1.duplicate).toBe(false);
      expect(r2.duplicate).toBe(true);
      expect(r2.record.importId).toBe(r1.record.importId);
      expect(count(a, "imports")).toBe(1);
    } finally {
      a.close();
      b.close();
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best-effort cleanup (Windows may hold the file briefly) */
      }
    }
  });
});

describe("raw source", () => {
  it("retains the exact uploaded bytes, BOM and UTF-16 included", () => {
    for (const name of [
      "04_utf16_invalid_control_ref.xml",
      "07_utf8_bom_payment.xml",
    ]) {
      const input = buildImport(name);
      const { record } = repo.saveImport(input);
      const raw = repo.getRawSource(record.importId)!;
      expect(raw.equals(fixtureBytes(name))).toBe(true);
      expect(sha256Hex(raw)).toBe(record.contentHash);
    }
  });
});

describe("atomicity and integrity", () => {
  it("rolls back the whole import when any child row fails", () => {
    const input = buildImport("01_receipt_with_allocations.xml");
    const bad = structuredClone(input);
    bad.vouchers.push({
      voucherIndex: 1,
      data: {
        ...structuredClone(input.vouchers[0]!.data),
        ledgerEntries: [
          {
            ...input.vouchers[0]!.data.ledgerEntries[0]!,
            sourceTag: "BOGUS.LIST" as never,
          },
        ],
      },
    });

    expect(() => repo.saveImport(bad)).toThrow();
    expect(count(db, "imports")).toBe(0);
    expect(count(db, "import_sources")).toBe(0);
    expect(count(db, "vouchers")).toBe(0);
    expect(count(db, "ledger_entries")).toBe(0);

    // The same bytes can still be imported afterwards.
    expect(repo.saveImport(input).duplicate).toBe(false);
  });

  it("cascades deletes through the whole tree", () => {
    const { record } = repo.saveImport(
      buildImport("02_sales_invoice_nested.xml"),
    );
    db.prepare("DELETE FROM imports WHERE id = ?").run(record.importId);
    for (const table of [
      "import_sources",
      "vouchers",
      "ledger_entries",
      "bill_allocations",
      "inventory_entries",
      "batch_allocations",
      "accounting_allocations",
      "rate_details",
    ]) {
      expect(count(db, table)).toBe(0);
    }
  });

  it("refuses a rate detail with no owner", () => {
    expect(() =>
      db
        .prepare(
          "INSERT INTO rate_details (position, duty_head, rate) VALUES (0, ?, ?)",
        )
        .run("CGST", "9"),
    ).toThrow(/CHECK/);
  });

  it("keeps equal-valued sibling rows as separate rows in source order", () => {
    const input = buildImport("01_receipt_with_allocations.xml");
    const twin = structuredClone(input);
    const bill = { name: "B", billType: "New Ref", amount: "5" };
    twin.contentHash = "b".repeat(64);
    twin.vouchers[0]!.data.ledgerEntries[0]!.billAllocations = [
      bill,
      { ...bill },
    ];
    const { record } = repo.saveImport(twin);
    const [item] = repo.getVouchers(record.importId)!;
    expect(item!.ledgerEntries[0]!.billAllocations).toEqual([bill, bill]);
    expect(count(db, "bill_allocations")).toBe(3);
  });
});
