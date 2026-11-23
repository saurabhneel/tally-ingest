import { Errors } from "../errors";
import type { ImportWarning } from "../warnings";
import { childText, childrenNamed, type XmlElement } from "../xml/tree";

// ---- Output types (mirror NORMALIZED_DATA_CONTRACT.md) ----------------------
// Absent source elements are null; present-but-empty elements are "".

export interface RateDetail {
  dutyHead: string | null;
  rate: string | null;
}

export interface BillAllocation {
  name: string | null;
  billType: string | null;
  amount: string | null;
}

export interface BankAllocation {
  date: string | null;
  name: string | null;
  transactionType: string | null;
  amount: string | null;
}

export interface LedgerEntry {
  sourceTag: "ALLLEDGERENTRIES.LIST" | "LEDGERENTRIES.LIST";
  ledgerName: string | null;
  isDeemedPositive: string | null;
  amount: string | null;
  billAllocations: BillAllocation[];
  bankAllocations: BankAllocation[];
  rateDetails: RateDetail[];
}

export interface BatchAllocation {
  godownName: string | null;
  batchName: string | null;
  actualQty: string | null;
  billedQty: string | null;
  amount: string | null;
}

export interface AccountingAllocation {
  ledgerName: string | null;
  isDeemedPositive: string | null;
  amount: string | null;
  rateDetails: RateDetail[];
}

export interface InventoryEntry {
  sourceTag: "ALLINVENTORYENTRIES.LIST";
  stockItemName: string | null;
  isDeemedPositive: string | null;
  actualQty: string | null;
  billedQty: string | null;
  rate: string | null;
  amount: string | null;
  batchAllocations: BatchAllocation[];
  accountingAllocations: AccountingAllocation[];
  rateDetails: RateDetail[];
}

/** Everything in the contract's voucher object except `source`. */
export interface VoucherData {
  attributes: Record<string, string>;
  date: string | null;
  voucherType: string | null;
  voucherNumber: string | null;
  partyLedgerName: string | null;
  narration: string | null;
  ledgerEntries: LedgerEntry[];
  inventoryEntries: InventoryEntry[];
  warnings: ImportWarning[];
}

export interface ParsedVoucher {
  /** Zero-based position among VOUCHER elements in the document. */
  voucherIndex: number;
  data: VoucherData;
}

export interface VoucherExportResult {
  vouchers: ParsedVoucher[];
  /** Import-wide warnings (voucher-level ones are aggregated here too). */
  warnings: ImportWarning[];
}

// ---- Warning collection -----------------------------------------------------

const UNKNOWN_ELEMENT = "UNKNOWN_ELEMENT_NOT_NORMALIZED";
const UNKNOWN_ATTRIBUTE = "UNKNOWN_ATTRIBUTE_NOT_NORMALIZED";
const UNKNOWN_ELEMENT_MESSAGE =
  "An element outside the normalized contract was found. It is retained only in the raw upload and was not normalized.";
const UNKNOWN_ATTRIBUTE_MESSAGE =
  "An attribute outside the normalized contract was found. It is retained only in the raw upload and was not normalized.";

const MAX_SAMPLE_VOUCHER_INDEXES = 10;
const MAX_NAME_LENGTH = 100;

/** Element and attribute names come from the document, so cap their length. */
const safeName = (s: string): string =>
  s.length > MAX_NAME_LENGTH ? `${s.slice(0, MAX_NAME_LENGTH)}…` : s;

interface CollectedWarning {
  code: string;
  message: string;
  path: string;
  count: number;
  vouchers: Set<number>;
}

/**
 * Groups identical warnings (same code and path) and counts them, so a
 * voucher with 1,000 ledger entries carrying the same unknown child yields one
 * warning with count=1000, not 1,000 warnings.
 */
class WarningCollector {
  private readonly map = new Map<string, CollectedWarning>();

  add(
    code: string,
    message: string,
    path: string,
    count = 1,
    voucherIndex?: number,
  ): void {
    const key = `${code}\u0000${path}`;
    let entry = this.map.get(key);
    if (!entry) {
      entry = { code, message, path, count: 0, vouchers: new Set() };
      this.map.set(key, entry);
    }
    entry.count += count;
    if (voucherIndex !== undefined) entry.vouchers.add(voucherIndex);
  }

  entries(): IterableIterator<CollectedWarning> {
    return this.map.values();
  }

  toWarnings(): ImportWarning[] {
    return [...this.map.values()].map((e): ImportWarning => {
      const details: NonNullable<ImportWarning["details"]> = { count: e.count };
      if (e.vouchers.size > 0) {
        details["vouchers"] = e.vouchers.size;
        details["sampleVoucherIndexes"] = [...e.vouchers]
          .sort((a, b) => a - b)
          .slice(0, MAX_SAMPLE_VOUCHER_INDEXES);
      }
      return { code: e.code, message: e.message, path: e.path, details };
    });
  }
}

function flagUnknownChildren(
  el: XmlElement,
  known: ReadonlySet<string>,
  path: string,
  w: WarningCollector,
): void {
  const counts = new Map<string, number>();
  for (const child of el.children) {
    if (!known.has(child.name))
      counts.set(child.name, (counts.get(child.name) ?? 0) + 1);
  }
  for (const [name, n] of counts) {
    w.add(
      UNKNOWN_ELEMENT,
      UNKNOWN_ELEMENT_MESSAGE,
      `${path}/${safeName(name)}`,
      n,
    );
  }
}

function flagUnknownAttributes(
  el: XmlElement,
  known: ReadonlySet<string>,
  path: string,
  w: WarningCollector,
): void {
  for (const key of Object.keys(el.attributes)) {
    if (!known.has(key)) {
      w.add(
        UNKNOWN_ATTRIBUTE,
        UNKNOWN_ATTRIBUTE_MESSAGE,
        `${path}/@${safeName(key)}`,
      );
    }
  }
}

// ---- Known children per node type ------------------------------------------
// Anything else found directly under that node is flagged as not normalized.

// Sample fixture 01 writes the name element as <n>, fixture 02 as <NAME>.
// Both are accepted (documented assumption); the first one in the source wins.
const NAME_TAGS = ["NAME", "n"] as const;

const LEDGER_TAGS: ReadonlySet<string> = new Set([
  "ALLLEDGERENTRIES.LIST",
  "LEDGERENTRIES.LIST",
]);
const INVENTORY_TAG = "ALLINVENTORYENTRIES.LIST";

const VOUCHER_ATTRS = new Set(["VCHTYPE", "ACTION"]);
const VOUCHER_KNOWN = new Set([
  "DATE",
  "VOUCHERTYPENAME",
  "VOUCHERNUMBER",
  "PARTYLEDGERNAME",
  "NARRATION",
  ...LEDGER_TAGS,
  INVENTORY_TAG,
]);
const LEDGER_KNOWN = new Set([
  "LEDGERNAME",
  "ISDEEMEDPOSITIVE",
  "AMOUNT",
  "BILLALLOCATIONS.LIST",
  "BANKALLOCATIONS.LIST",
  "RATEDETAILS.LIST",
]);
const BILL_KNOWN = new Set([...NAME_TAGS, "BILLTYPE", "AMOUNT"]);
const BANK_KNOWN = new Set(["DATE", ...NAME_TAGS, "TRANSACTIONTYPE", "AMOUNT"]);
const INVENTORY_KNOWN = new Set([
  "STOCKITEMNAME",
  "ISDEEMEDPOSITIVE",
  "ACTUALQTY",
  "BILLEDQTY",
  "RATE",
  "AMOUNT",
  "BATCHALLOCATIONS.LIST",
  "ACCOUNTINGALLOCATIONS.LIST",
  "RATEDETAILS.LIST",
]);
const BATCH_KNOWN = new Set([
  "GODOWNNAME",
  "BATCHNAME",
  "ACTUALQTY",
  "BILLEDQTY",
  "AMOUNT",
]);
const ACCOUNTING_KNOWN = new Set([
  "LEDGERNAME",
  "ISDEEMEDPOSITIVE",
  "AMOUNT",
  "RATEDETAILS.LIST",
]);
const RATE_KNOWN = new Set(["GSTRATEDUTYHEAD", "GSTRATE"]);

// ---- Mappers (each reads direct children of its own element only) -----------

function mapRateDetails(
  parent: XmlElement,
  parentPath: string,
  w: WarningCollector,
): RateDetail[] {
  const path = `${parentPath}/RATEDETAILS.LIST`;
  return childrenNamed(parent, "RATEDETAILS.LIST").map((rd) => {
    flagUnknownChildren(rd, RATE_KNOWN, path, w);
    return {
      dutyHead: childText(rd, "GSTRATEDUTYHEAD"),
      rate: childText(rd, "GSTRATE"),
    };
  });
}

function mapBillAllocations(
  le: XmlElement,
  parentPath: string,
  w: WarningCollector,
): BillAllocation[] {
  const path = `${parentPath}/BILLALLOCATIONS.LIST`;
  return childrenNamed(le, "BILLALLOCATIONS.LIST").map((b) => {
    flagUnknownChildren(b, BILL_KNOWN, path, w);
    return {
      name: childText(b, NAME_TAGS),
      billType: childText(b, "BILLTYPE"),
      amount: childText(b, "AMOUNT"),
    };
  });
}

function mapBankAllocations(
  le: XmlElement,
  parentPath: string,
  w: WarningCollector,
): BankAllocation[] {
  const path = `${parentPath}/BANKALLOCATIONS.LIST`;
  return childrenNamed(le, "BANKALLOCATIONS.LIST").map((b) => {
    flagUnknownChildren(b, BANK_KNOWN, path, w);
    return {
      date: childText(b, "DATE"),
      name: childText(b, NAME_TAGS),
      transactionType: childText(b, "TRANSACTIONTYPE"),
      amount: childText(b, "AMOUNT"),
    };
  });
}

function mapLedgerEntry(el: XmlElement, w: WarningCollector): LedgerEntry {
  const path = `VOUCHER/${el.name}`;
  flagUnknownChildren(el, LEDGER_KNOWN, path, w);
  return {
    sourceTag: el.name as LedgerEntry["sourceTag"],
    ledgerName: childText(el, "LEDGERNAME"),
    isDeemedPositive: childText(el, "ISDEEMEDPOSITIVE"),
    amount: childText(el, "AMOUNT"),
    billAllocations: mapBillAllocations(el, path, w),
    bankAllocations: mapBankAllocations(el, path, w),
    rateDetails: mapRateDetails(el, path, w),
  };
}

function mapBatchAllocations(
  ie: XmlElement,
  parentPath: string,
  w: WarningCollector,
): BatchAllocation[] {
  const path = `${parentPath}/BATCHALLOCATIONS.LIST`;
  return childrenNamed(ie, "BATCHALLOCATIONS.LIST").map((b) => {
    flagUnknownChildren(b, BATCH_KNOWN, path, w);
    return {
      godownName: childText(b, "GODOWNNAME"),
      batchName: childText(b, "BATCHNAME"),
      actualQty: childText(b, "ACTUALQTY"),
      billedQty: childText(b, "BILLEDQTY"),
      amount: childText(b, "AMOUNT"),
    };
  });
}

function mapAccountingAllocations(
  ie: XmlElement,
  parentPath: string,
  w: WarningCollector,
): AccountingAllocation[] {
  const path = `${parentPath}/ACCOUNTINGALLOCATIONS.LIST`;
  return childrenNamed(ie, "ACCOUNTINGALLOCATIONS.LIST").map((a) => {
    flagUnknownChildren(a, ACCOUNTING_KNOWN, path, w);
    return {
      ledgerName: childText(a, "LEDGERNAME"),
      isDeemedPositive: childText(a, "ISDEEMEDPOSITIVE"),
      amount: childText(a, "AMOUNT"),
      rateDetails: mapRateDetails(a, path, w),
    };
  });
}

function mapInventoryEntry(
  el: XmlElement,
  w: WarningCollector,
): InventoryEntry {
  const path = `VOUCHER/${el.name}`;
  flagUnknownChildren(el, INVENTORY_KNOWN, path, w);
  return {
    sourceTag: "ALLINVENTORYENTRIES.LIST",
    stockItemName: childText(el, "STOCKITEMNAME"),
    isDeemedPositive: childText(el, "ISDEEMEDPOSITIVE"),
    actualQty: childText(el, "ACTUALQTY"),
    billedQty: childText(el, "BILLEDQTY"),
    rate: childText(el, "RATE"),
    amount: childText(el, "AMOUNT"),
    batchAllocations: mapBatchAllocations(el, path, w),
    accountingAllocations: mapAccountingAllocations(el, path, w),
    rateDetails: mapRateDetails(el, path, w),
  };
}

function mapVoucher(el: XmlElement): {
  data: VoucherData;
  collector: WarningCollector;
} {
  const w = new WarningCollector();

  const attributes: Record<string, string> = {};
  for (const key of VOUCHER_ATTRS) {
    const value = el.attributes[key];
    if (value !== undefined) attributes[key] = value;
  }
  flagUnknownAttributes(el, VOUCHER_ATTRS, "VOUCHER", w);
  flagUnknownChildren(el, VOUCHER_KNOWN, "VOUCHER", w);

  // Direct children only, and in document order: a voucher mixing
  // ALLLEDGERENTRIES.LIST and LEDGERENTRIES.LIST keeps its source order.
  const ledgerEntries = el.children
    .filter((c) => LEDGER_TAGS.has(c.name))
    .map((c) => mapLedgerEntry(c, w));
  const inventoryEntries = el.children
    .filter((c) => c.name === INVENTORY_TAG)
    .map((c) => mapInventoryEntry(c, w));

  const data: VoucherData = {
    attributes,
    date: childText(el, "DATE"),
    voucherType: childText(el, "VOUCHERTYPENAME"),
    voucherNumber: childText(el, "VOUCHERNUMBER"),
    partyLedgerName: childText(el, "PARTYLEDGERNAME"),
    narration: childText(el, "NARRATION"),
    ledgerEntries,
    inventoryEntries,
    warnings: w.toWarnings(),
  };
  return { data, collector: w };
}

// ---- Document entry point ---------------------------------------------------

/**
 * Normalize an ENVELOPE document: ENVELOPE/BODY/DATA/COLLECTION/VOUCHER.
 * `root` must be the parsed document root.
 */
export function normalizeVoucherExport(root: XmlElement): VoucherExportResult {
  if (root.name !== "ENVELOPE") {
    throw Errors.unsupportedDocument("Expected an ENVELOPE root element.");
  }

  const importWarnings = new WarningCollector();
  const vouchers: ParsedVoucher[] = [];
  let collectionsFound = 0;

  // HEADER is standard metadata and is not reported as unknown.
  flagUnknownChildren(
    root,
    new Set(["HEADER", "BODY"]),
    "ENVELOPE",
    importWarnings,
  );

  for (const body of childrenNamed(root, "BODY")) {
    flagUnknownChildren(
      body,
      new Set(["DATA"]),
      "ENVELOPE/BODY",
      importWarnings,
    );
    for (const data of childrenNamed(body, "DATA")) {
      flagUnknownChildren(
        data,
        new Set(["COLLECTION"]),
        "ENVELOPE/BODY/DATA",
        importWarnings,
      );
      for (const collection of childrenNamed(data, "COLLECTION")) {
        collectionsFound++;
        flagUnknownChildren(
          collection,
          new Set(["VOUCHER"]),
          "ENVELOPE/BODY/DATA/COLLECTION",
          importWarnings,
        );
        for (const voucherEl of childrenNamed(collection, "VOUCHER")) {
          const voucherIndex = vouchers.length;
          const { data: voucherData, collector } = mapVoucher(voucherEl);
          vouchers.push({ voucherIndex, data: voucherData });
          for (const e of collector.entries()) {
            importWarnings.add(
              e.code,
              e.message,
              e.path,
              e.count,
              voucherIndex,
            );
          }
        }
      }
    }
  }

  if (collectionsFound === 0) {
    throw Errors.unsupportedDocument("Expected ENVELOPE/BODY/DATA/COLLECTION.");
  }

  return { vouchers, warnings: importWarnings.toWarnings() };
}
