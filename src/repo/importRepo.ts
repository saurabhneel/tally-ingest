import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { Db } from "../db/connection";
import type { TallyResponseDetails } from "../normalize/response";
import type {
  AccountingAllocation,
  BankAllocation,
  BatchAllocation,
  BillAllocation,
  InventoryEntry,
  LedgerEntry,
  ParsedVoucher,
  RateDetail,
  VoucherData,
} from "../normalize/voucher";
import type { ImportWarning } from "../warnings";

// ---- Public types -----------------------------------------------------------

export type DocumentType = "voucherExport" | "tallyResponse";
export type ImportStatus = "completed" | "partial" | "failed";
/** Same shape as a warning: a stable code, our own message, optional path/details. */
export type ImportError = ImportWarning;

export interface ImportSummary {
  vouchers: number;
  ledgerEntries: number;
  inventoryEntries: number;
  warnings: number;
  errors: number;
}

export interface NewImport {
  /** Lowercase SHA-256 hex of the exact uploaded bytes. */
  contentHash: string;
  /** Stored for audit only. Never returned by the API. */
  originalFilename: string | null;
  /** The exact uploaded bytes. */
  rawContent: Buffer;
  detectedEncoding: string;
  documentType: DocumentType;
  status: ImportStatus;
  summary: ImportSummary;
  warnings: ImportWarning[];
  errors: ImportError[];
  tallyResponse: TallyResponseDetails | null;
  vouchers: ParsedVoucher[];
}

export interface ImportRecord {
  importId: string;
  documentType: DocumentType;
  status: ImportStatus;
  contentHash: string;
  detectedEncoding: string;
  summary: ImportSummary;
  warnings: ImportWarning[];
  errors: ImportError[];
  /** Present only for documentType "tallyResponse". */
  tallyResponse?: TallyResponseDetails;
}

export interface SaveResult {
  record: ImportRecord;
  duplicate: boolean;
}

/** A voucher exactly as the HTTP contract returns it. */
export interface VoucherItem extends VoucherData {
  source: { importId: string; contentHash: string; voucherIndex: number };
}

// ---- Row types --------------------------------------------------------------

interface ImportRow {
  id: string;
  content_hash: string;
  detected_encoding: string;
  document_type: DocumentType;
  status: ImportStatus;
  voucher_count: number;
  ledger_entry_count: number;
  inventory_entry_count: number;
  warning_count: number;
  error_count: number;
  warnings_json: string;
  errors_json: string;
  tally_response_json: string | null;
}

interface VoucherRow {
  id: number;
  voucher_index: number;
  attributes_json: string;
  date: string | null;
  voucher_type: string | null;
  voucher_number: string | null;
  party_ledger_name: string | null;
  narration: string | null;
  warnings_json: string;
}

interface LedgerRow {
  id: number;
  voucher_id: number;
  source_tag: LedgerEntry["sourceTag"];
  ledger_name: string | null;
  is_deemed_positive: string | null;
  amount: string | null;
}

interface BillRow {
  ledger_entry_id: number;
  name: string | null;
  bill_type: string | null;
  amount: string | null;
}

interface BankRow {
  ledger_entry_id: number;
  date: string | null;
  name: string | null;
  transaction_type: string | null;
  amount: string | null;
}

interface InventoryRow {
  id: number;
  voucher_id: number;
  source_tag: InventoryEntry["sourceTag"];
  stock_item_name: string | null;
  is_deemed_positive: string | null;
  actual_qty: string | null;
  billed_qty: string | null;
  rate: string | null;
  amount: string | null;
}

interface BatchRow {
  inventory_entry_id: number;
  godown_name: string | null;
  batch_name: string | null;
  actual_qty: string | null;
  billed_qty: string | null;
  amount: string | null;
}

interface AccountingRow {
  id: number;
  inventory_entry_id: number;
  ledger_name: string | null;
  is_deemed_positive: string | null;
  amount: string | null;
}

interface RateRow {
  ledger_entry_id: number | null;
  inventory_entry_id: number | null;
  accounting_allocation_id: number | null;
  duty_head: string | null;
  rate: string | null;
}

// ---- Statements -------------------------------------------------------------

function prepareStatements(db: Db) {
  const p = (sql: string): Database.Statement => db.prepare(sql);
  return {
    insertImport: p(`
      INSERT INTO imports (
        id, content_hash, original_filename, byte_size, detected_encoding,
        document_type, status, voucher_count, ledger_entry_count,
        inventory_entry_count, warning_count, error_count,
        warnings_json, errors_json, tally_response_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(content_hash) DO NOTHING`),
    insertSource: p(
      "INSERT INTO import_sources (import_id, raw_content) VALUES (?, ?)",
    ),
    insertVoucher: p(`
      INSERT INTO vouchers (
        import_id, voucher_index, attributes_json, date, voucher_type,
        voucher_number, party_ledger_name, narration, warnings_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertLedger: p(`
      INSERT INTO ledger_entries (
        voucher_id, position, source_tag, ledger_name, is_deemed_positive, amount
      ) VALUES (?, ?, ?, ?, ?, ?)`),
    insertBill: p(`
      INSERT INTO bill_allocations (ledger_entry_id, position, name, bill_type, amount)
      VALUES (?, ?, ?, ?, ?)`),
    insertBank: p(`
      INSERT INTO bank_allocations (
        ledger_entry_id, position, date, name, transaction_type, amount
      ) VALUES (?, ?, ?, ?, ?, ?)`),
    insertInventory: p(`
      INSERT INTO inventory_entries (
        voucher_id, position, source_tag, stock_item_name, is_deemed_positive,
        actual_qty, billed_qty, rate, amount
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    insertBatch: p(`
      INSERT INTO batch_allocations (
        inventory_entry_id, position, godown_name, batch_name,
        actual_qty, billed_qty, amount
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`),
    insertAccounting: p(`
      INSERT INTO accounting_allocations (
        inventory_entry_id, position, ledger_name, is_deemed_positive, amount
      ) VALUES (?, ?, ?, ?, ?)`),
    insertRateForLedger: p(`
      INSERT INTO rate_details (ledger_entry_id, position, duty_head, rate)
      VALUES (?, ?, ?, ?)`),
    insertRateForInventory: p(`
      INSERT INTO rate_details (inventory_entry_id, position, duty_head, rate)
      VALUES (?, ?, ?, ?)`),
    insertRateForAccounting: p(`
      INSERT INTO rate_details (accounting_allocation_id, position, duty_head, rate)
      VALUES (?, ?, ?, ?)`),

    importById: p("SELECT * FROM imports WHERE id = ?"),
    importByHash: p("SELECT * FROM imports WHERE content_hash = ?"),
    rawByImport: p(
      "SELECT raw_content FROM import_sources WHERE import_id = ?",
    ),

    vouchers: p(
      "SELECT * FROM vouchers WHERE import_id = ? ORDER BY voucher_index",
    ),
    ledgers: p(`
      SELECT le.* FROM ledger_entries le
      JOIN vouchers v ON v.id = le.voucher_id
      WHERE v.import_id = ? ORDER BY le.voucher_id, le.position`),
    bills: p(`
      SELECT ba.* FROM bill_allocations ba
      JOIN ledger_entries le ON le.id = ba.ledger_entry_id
      JOIN vouchers v ON v.id = le.voucher_id
      WHERE v.import_id = ? ORDER BY ba.ledger_entry_id, ba.position`),
    banks: p(`
      SELECT ba.* FROM bank_allocations ba
      JOIN ledger_entries le ON le.id = ba.ledger_entry_id
      JOIN vouchers v ON v.id = le.voucher_id
      WHERE v.import_id = ? ORDER BY ba.ledger_entry_id, ba.position`),
    inventories: p(`
      SELECT ie.* FROM inventory_entries ie
      JOIN vouchers v ON v.id = ie.voucher_id
      WHERE v.import_id = ? ORDER BY ie.voucher_id, ie.position`),
    batches: p(`
      SELECT ba.* FROM batch_allocations ba
      JOIN inventory_entries ie ON ie.id = ba.inventory_entry_id
      JOIN vouchers v ON v.id = ie.voucher_id
      WHERE v.import_id = ? ORDER BY ba.inventory_entry_id, ba.position`),
    accountings: p(`
      SELECT aa.* FROM accounting_allocations aa
      JOIN inventory_entries ie ON ie.id = aa.inventory_entry_id
      JOIN vouchers v ON v.id = ie.voucher_id
      WHERE v.import_id = ? ORDER BY aa.inventory_entry_id, aa.position`),
    ratesOfLedgers: p(`
      SELECT rd.* FROM rate_details rd
      JOIN ledger_entries le ON le.id = rd.ledger_entry_id
      JOIN vouchers v ON v.id = le.voucher_id
      WHERE v.import_id = ? ORDER BY rd.ledger_entry_id, rd.position`),
    ratesOfInventories: p(`
      SELECT rd.* FROM rate_details rd
      JOIN inventory_entries ie ON ie.id = rd.inventory_entry_id
      JOIN vouchers v ON v.id = ie.voucher_id
      WHERE v.import_id = ? ORDER BY rd.inventory_entry_id, rd.position`),
    ratesOfAccountings: p(`
      SELECT rd.* FROM rate_details rd
      JOIN accounting_allocations aa ON aa.id = rd.accounting_allocation_id
      JOIN inventory_entries ie ON ie.id = aa.inventory_entry_id
      JOIN vouchers v ON v.id = ie.voucher_id
      WHERE v.import_id = ? ORDER BY rd.accounting_allocation_id, rd.position`),
  };
}

// ---- Helpers ----------------------------------------------------------------

function groupBy<T>(rows: T[], key: (row: T) => number): Map<number, T[]> {
  const map = new Map<number, T[]>();
  for (const row of rows) {
    const k = key(row);
    const list = map.get(k);
    if (list) list.push(row);
    else map.set(k, [row]);
  }
  return map;
}

function toRecord(row: ImportRow): ImportRecord {
  const record: ImportRecord = {
    importId: row.id,
    documentType: row.document_type,
    status: row.status,
    contentHash: row.content_hash,
    detectedEncoding: row.detected_encoding,
    summary: {
      vouchers: row.voucher_count,
      ledgerEntries: row.ledger_entry_count,
      inventoryEntries: row.inventory_entry_count,
      warnings: row.warning_count,
      errors: row.error_count,
    },
    warnings: JSON.parse(row.warnings_json) as ImportWarning[],
    errors: JSON.parse(row.errors_json) as ImportError[],
  };
  if (row.tally_response_json !== null) {
    record.tallyResponse = JSON.parse(
      row.tally_response_json,
    ) as TallyResponseDetails;
  }
  return record;
}

const toRate = (r: RateRow): RateDetail => ({
  dutyHead: r.duty_head,
  rate: r.rate,
});

// ---- Repository -------------------------------------------------------------

export class ImportRepository {
  private readonly q: ReturnType<typeof prepareStatements>;

  constructor(private readonly db: Db) {
    // Throws immediately if migrations have not been applied.
    this.q = prepareStatements(db);
  }

  /** Lookup by content identity. Used as a fast path only; saveImport is the guard. */
  findByContentHash(contentHash: string): ImportRecord | null {
    const row = this.q.importByHash.get(contentHash) as ImportRow | undefined;
    return row ? toRecord(row) : null;
  }

  /**
   * Persist an import and all its children atomically.
   *
   * Idempotency is decided by the database: the INSERT either creates the row
   * or hits UNIQUE(content_hash) and does nothing. Everything runs in one
   * BEGIN IMMEDIATE transaction, so a failure anywhere rolls the whole import
   * back, and two writers (even in different processes) cannot both create it.
   */
  saveImport(input: NewImport): SaveResult {
    const write = this.db.transaction((): SaveResult => {
      const importId = randomUUID();
      const inserted = this.q.insertImport.run(
        importId,
        input.contentHash,
        input.originalFilename,
        input.rawContent.length,
        input.detectedEncoding,
        input.documentType,
        input.status,
        input.summary.vouchers,
        input.summary.ledgerEntries,
        input.summary.inventoryEntries,
        input.summary.warnings,
        input.summary.errors,
        JSON.stringify(input.warnings),
        JSON.stringify(input.errors),
        input.tallyResponse ? JSON.stringify(input.tallyResponse) : null,
      );

      if (inserted.changes === 0) {
        const existing = this.q.importByHash.get(input.contentHash) as
          | ImportRow
          | undefined;
        if (!existing) {
          throw new Error(
            "Import conflict reported but no existing row was found.",
          );
        }
        return { record: toRecord(existing), duplicate: true };
      }

      this.q.insertSource.run(importId, input.rawContent);
      for (const voucher of input.vouchers)
        this.insertVoucherTree(importId, voucher);

      const created = this.q.importById.get(importId) as ImportRow;
      return { record: toRecord(created), duplicate: false };
    });

    return write.immediate();
  }

  getImport(importId: string): ImportRecord | null {
    const row = this.q.importById.get(importId) as ImportRow | undefined;
    return row ? toRecord(row) : null;
  }

  /** The exact uploaded bytes, for investigation. Never exposed over HTTP. */
  getRawSource(importId: string): Buffer | null {
    const row = this.q.rawByImport.get(importId) as
      | { raw_content: Buffer }
      | undefined;
    return row ? row.raw_content : null;
  }

  /**
   * Rebuild the normalized vouchers for an import, in source order.
   * Returns null when the import does not exist (a tallyResponse import
   * exists and yields an empty array).
   */
  getVouchers(importId: string): VoucherItem[] | null {
    const imp = this.q.importById.get(importId) as ImportRow | undefined;
    if (!imp) return null;

    const voucherRows = this.q.vouchers.all(importId) as VoucherRow[];
    if (voucherRows.length === 0) return [];

    const ledgers = groupBy(
      this.q.ledgers.all(importId) as LedgerRow[],
      (r) => r.voucher_id,
    );
    const bills = groupBy(
      this.q.bills.all(importId) as BillRow[],
      (r) => r.ledger_entry_id,
    );
    const banks = groupBy(
      this.q.banks.all(importId) as BankRow[],
      (r) => r.ledger_entry_id,
    );
    const inventories = groupBy(
      this.q.inventories.all(importId) as InventoryRow[],
      (r) => r.voucher_id,
    );
    const batches = groupBy(
      this.q.batches.all(importId) as BatchRow[],
      (r) => r.inventory_entry_id,
    );
    const accountings = groupBy(
      this.q.accountings.all(importId) as AccountingRow[],
      (r) => r.inventory_entry_id,
    );
    const ledgerRates = groupBy(
      this.q.ratesOfLedgers.all(importId) as RateRow[],
      (r) => r.ledger_entry_id as number,
    );
    const inventoryRates = groupBy(
      this.q.ratesOfInventories.all(importId) as RateRow[],
      (r) => r.inventory_entry_id as number,
    );
    const accountingRates = groupBy(
      this.q.ratesOfAccountings.all(importId) as RateRow[],
      (r) => r.accounting_allocation_id as number,
    );

    return voucherRows.map((v): VoucherItem => {
      const ledgerEntries: LedgerEntry[] = (ledgers.get(v.id) ?? []).map(
        (le) => ({
          sourceTag: le.source_tag,
          ledgerName: le.ledger_name,
          isDeemedPositive: le.is_deemed_positive,
          amount: le.amount,
          billAllocations: (bills.get(le.id) ?? []).map(
            (b): BillAllocation => ({
              name: b.name,
              billType: b.bill_type,
              amount: b.amount,
            }),
          ),
          bankAllocations: (banks.get(le.id) ?? []).map(
            (b): BankAllocation => ({
              date: b.date,
              name: b.name,
              transactionType: b.transaction_type,
              amount: b.amount,
            }),
          ),
          rateDetails: (ledgerRates.get(le.id) ?? []).map(toRate),
        }),
      );

      const inventoryEntries: InventoryEntry[] = (
        inventories.get(v.id) ?? []
      ).map((ie) => ({
        sourceTag: ie.source_tag,
        stockItemName: ie.stock_item_name,
        isDeemedPositive: ie.is_deemed_positive,
        actualQty: ie.actual_qty,
        billedQty: ie.billed_qty,
        rate: ie.rate,
        amount: ie.amount,
        batchAllocations: (batches.get(ie.id) ?? []).map(
          (b): BatchAllocation => ({
            godownName: b.godown_name,
            batchName: b.batch_name,
            actualQty: b.actual_qty,
            billedQty: b.billed_qty,
            amount: b.amount,
          }),
        ),
        accountingAllocations: (accountings.get(ie.id) ?? []).map(
          (a): AccountingAllocation => ({
            ledgerName: a.ledger_name,
            isDeemedPositive: a.is_deemed_positive,
            amount: a.amount,
            rateDetails: (accountingRates.get(a.id) ?? []).map(toRate),
          }),
        ),
        rateDetails: (inventoryRates.get(ie.id) ?? []).map(toRate),
      }));

      return {
        source: {
          importId,
          contentHash: imp.content_hash,
          voucherIndex: v.voucher_index,
        },
        attributes: JSON.parse(v.attributes_json) as Record<string, string>,
        date: v.date,
        voucherType: v.voucher_type,
        voucherNumber: v.voucher_number,
        partyLedgerName: v.party_ledger_name,
        narration: v.narration,
        ledgerEntries,
        inventoryEntries,
        warnings: JSON.parse(v.warnings_json) as ImportWarning[],
      };
    });
  }

  // ---- Writes (always called inside the saveImport transaction) -------------

  private insertVoucherTree(importId: string, voucher: ParsedVoucher): void {
    const d = voucher.data;
    const voucherId = Number(
      this.q.insertVoucher.run(
        importId,
        voucher.voucherIndex,
        JSON.stringify(d.attributes),
        d.date,
        d.voucherType,
        d.voucherNumber,
        d.partyLedgerName,
        d.narration,
        JSON.stringify(d.warnings),
      ).lastInsertRowid,
    );

    d.ledgerEntries.forEach((le, position) => {
      const ledgerId = Number(
        this.q.insertLedger.run(
          voucherId,
          position,
          le.sourceTag,
          le.ledgerName,
          le.isDeemedPositive,
          le.amount,
        ).lastInsertRowid,
      );
      le.billAllocations.forEach((b, i) =>
        this.q.insertBill.run(ledgerId, i, b.name, b.billType, b.amount),
      );
      le.bankAllocations.forEach((b, i) =>
        this.q.insertBank.run(
          ledgerId,
          i,
          b.date,
          b.name,
          b.transactionType,
          b.amount,
        ),
      );
      le.rateDetails.forEach((r, i) =>
        this.q.insertRateForLedger.run(ledgerId, i, r.dutyHead, r.rate),
      );
    });

    d.inventoryEntries.forEach((ie, position) => {
      const inventoryId = Number(
        this.q.insertInventory.run(
          voucherId,
          position,
          ie.sourceTag,
          ie.stockItemName,
          ie.isDeemedPositive,
          ie.actualQty,
          ie.billedQty,
          ie.rate,
          ie.amount,
        ).lastInsertRowid,
      );
      ie.batchAllocations.forEach((b, i) =>
        this.q.insertBatch.run(
          inventoryId,
          i,
          b.godownName,
          b.batchName,
          b.actualQty,
          b.billedQty,
          b.amount,
        ),
      );
      ie.accountingAllocations.forEach((a, i) => {
        const accountingId = Number(
          this.q.insertAccounting.run(
            inventoryId,
            i,
            a.ledgerName,
            a.isDeemedPositive,
            a.amount,
          ).lastInsertRowid,
        );
        a.rateDetails.forEach((r, j) =>
          this.q.insertRateForAccounting.run(
            accountingId,
            j,
            r.dutyHead,
            r.rate,
          ),
        );
      });
      ie.rateDetails.forEach((r, i) =>
        this.q.insertRateForInventory.run(inventoryId, i, r.dutyHead, r.rate),
      );
    });
  }
}
