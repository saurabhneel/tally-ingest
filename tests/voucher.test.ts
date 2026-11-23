import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeDocument } from "../src/xml/decode";
import { sanitizeXmlText } from "../src/xml/sanitize";
import { parseXmlTree } from "../src/xml/tree";
import { normalizeVoucherExport } from "../src/normalize/voucher";

function normalizeFixture(name: string) {
  const bytes = readFileSync(join(__dirname, "..", "fixtures", name));
  const { text } = decodeDocument(bytes);
  return normalizeVoucherExport(parseXmlTree(sanitizeXmlText(text).text));
}

const envelope = (inner: string) =>
  `<ENVELOPE><BODY><DATA><COLLECTION>${inner}</COLLECTION></DATA></BODY></ENVELOPE>`;
const normalizeXml = (xml: string) => normalizeVoucherExport(parseXmlTree(xml));

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("fixture 01: receipt with allocations", () => {
  const result = normalizeFixture("01_receipt_with_allocations.xml");
  const v = result.vouchers[0]!.data;

  it("maps voucher scalars and attributes from direct children", () => {
    expect(result.vouchers).toHaveLength(1);
    expect(result.vouchers[0]!.voucherIndex).toBe(0);
    expect(v.attributes).toEqual({ VCHTYPE: "Receipt", ACTION: "Create" });
    expect(v.date).toBe("20260715");
    expect(v.voucherType).toBe("Receipt");
    expect(v.voucherNumber).toBe("RCP-DEMO-001");
    expect(v.partyLedgerName).toBe("Demo Customer");
    expect(v.narration).toBe("Sanitized receipt fixture");
  });

  it("keeps both ledger entries separate and ordered, with signed amounts untouched", () => {
    expect(v.ledgerEntries.map((e) => e.ledgerName)).toEqual([
      "Demo Bank",
      "Demo Customer",
    ]);
    expect(v.ledgerEntries.map((e) => e.amount)).toEqual([
      "1250.00",
      "-1250.00",
    ]);
    expect(v.ledgerEntries.map((e) => e.isDeemedPositive)).toEqual([
      "No",
      "Yes",
    ]);
    expect(
      v.ledgerEntries.every((e) => e.sourceTag === "ALLLEDGERENTRIES.LIST"),
    ).toBe(true);
  });

  it("keeps allocations under their own ledger entry, as arrays, accepting <n> for name", () => {
    const [bank, customer] = v.ledgerEntries;
    expect(bank!.billAllocations).toEqual([]);
    expect(bank!.bankAllocations).toEqual([
      {
        date: "20260715",
        name: "UTR-DEMO-001",
        transactionType: "Inter Bank Transfer",
        amount: "1250.00",
      },
    ]);
    expect(customer!.bankAllocations).toEqual([]);
    expect(customer!.billAllocations).toEqual([
      { name: "INV-DEMO-001", billType: "Agst Ref", amount: "-1250.00" },
    ]);
    expect(v.inventoryEntries).toEqual([]);
    expect(v.warnings).toEqual([]);
    expect(result.warnings).toEqual([]);
  });
});

describe("fixture 02: nested sales invoice", () => {
  const result = normalizeFixture("02_sales_invoice_nested.xml");
  const v = result.vouchers[0]!.data;

  it("preserves LEDGERENTRIES.LIST as sourceTag and each ledger amount", () => {
    expect(v.ledgerEntries.map((e) => e.sourceTag)).toEqual(
      Array(3).fill("LEDGERENTRIES.LIST"),
    );
    expect(v.ledgerEntries.map((e) => e.amount)).toEqual([
      "-118.00",
      "9.00",
      "9.00",
    ]);
    expect(v.ledgerEntries[0]!.billAllocations).toEqual([
      { name: "SAL-DEMO-001", billType: "New Ref", amount: "-118.00" },
    ]);
  });

  it("attaches rate details to the direct parent that owned them", () => {
    expect(v.ledgerEntries[0]!.rateDetails).toEqual([]);
    expect(v.ledgerEntries[1]!.rateDetails).toEqual([
      { dutyHead: "CGST", rate: "9" },
    ]);
    expect(v.ledgerEntries[2]!.rateDetails).toEqual([
      { dutyHead: "SGST/UTGST", rate: "9" },
    ]);

    const inv = v.inventoryEntries[0]!;
    expect(inv.rateDetails).toEqual([]);
    expect(inv.accountingAllocations[0]!.rateDetails).toEqual([
      { dutyHead: "CGST", rate: "9" },
      { dutyHead: "SGST/UTGST", rate: "9" },
    ]);
  });

  it("keeps units in quantities and rates and does not mix inventory, batch and accounting values", () => {
    const inv = v.inventoryEntries[0]!;
    expect(inv).toMatchObject({
      sourceTag: "ALLINVENTORYENTRIES.LIST",
      stockItemName: "Demo Item",
      actualQty: "2 PCS",
      billedQty: "2 PCS",
      rate: "50.00/PCS",
      amount: "100.00",
    });
    expect(inv.batchAllocations).toEqual([
      {
        godownName: "Main Location",
        batchName: "Primary Batch",
        actualQty: "2 PCS",
        billedQty: "2 PCS",
        amount: "100.00",
      },
    ]);
    expect(inv.accountingAllocations[0]).toMatchObject({
      ledgerName: "Demo Sales",
      isDeemedPositive: "No",
      amount: "100.00",
    });
  });

  it("flags the unknown PERSISTEDVIEW child instead of crashing or normalizing it", () => {
    expect(v.narration).toBeNull();
    expect(v.warnings).toHaveLength(1);
    expect(v.warnings[0]).toMatchObject({
      code: "UNKNOWN_ELEMENT_NOT_NORMALIZED",
      path: "VOUCHER/PERSISTEDVIEW",
      details: { count: 1 },
    });
    expect(result.warnings[0]).toMatchObject({
      path: "VOUCHER/PERSISTEDVIEW",
      details: { count: 1, vouchers: 1, sampleVoucherIndexes: [0] },
    });
  });
});

describe("fixture 07 and 05", () => {
  it("normalizes the UTF-8 BOM payment", () => {
    const v = normalizeFixture("07_utf8_bom_payment.xml").vouchers[0]!.data;
    expect(v.voucherNumber).toBe("PAY-DEMO-UTF8-BOM");
    expect(v.ledgerEntries.map((e) => e.amount)).toEqual(["-42.10", "42.10"]);
  });

  it("returns zero vouchers for an empty collection", () => {
    const r = normalizeFixture("05_empty_collection.xml");
    expect(r.vouchers).toEqual([]);
    expect(r.warnings).toEqual([]);
  });
});

describe("ownership and ordering", () => {
  it("does not overwrite AMOUNT values across levels", () => {
    const r = normalizeXml(
      envelope(`<VOUCHER>
        <ALLLEDGERENTRIES.LIST><AMOUNT>1</AMOUNT>
          <BILLALLOCATIONS.LIST><AMOUNT>2</AMOUNT></BILLALLOCATIONS.LIST>
          <BANKALLOCATIONS.LIST><AMOUNT>3</AMOUNT></BANKALLOCATIONS.LIST>
        </ALLLEDGERENTRIES.LIST>
        <ALLINVENTORYENTRIES.LIST><AMOUNT>4</AMOUNT>
          <BATCHALLOCATIONS.LIST><AMOUNT>5</AMOUNT></BATCHALLOCATIONS.LIST>
          <ACCOUNTINGALLOCATIONS.LIST><AMOUNT>6</AMOUNT></ACCOUNTINGALLOCATIONS.LIST>
        </ALLINVENTORYENTRIES.LIST>
      </VOUCHER>`),
    );
    const v = r.vouchers[0]!.data;
    expect(v.ledgerEntries[0]!.amount).toBe("1");
    expect(v.ledgerEntries[0]!.billAllocations[0]!.amount).toBe("2");
    expect(v.ledgerEntries[0]!.bankAllocations[0]!.amount).toBe("3");
    expect(v.inventoryEntries[0]!.amount).toBe("4");
    expect(v.inventoryEntries[0]!.batchAllocations[0]!.amount).toBe("5");
    expect(v.inventoryEntries[0]!.accountingAllocations[0]!.amount).toBe("6");
  });

  it("never reads a voucher scalar from a descendant", () => {
    const r = normalizeXml(
      envelope(`<VOUCHER>
        <ALLLEDGERENTRIES.LIST><DATE>20990101</DATE><NARRATION>decoy</NARRATION><VOUCHERNUMBER>X</VOUCHERNUMBER></ALLLEDGERENTRIES.LIST>
      </VOUCHER>`),
    );
    const v = r.vouchers[0]!.data;
    expect(v.date).toBeNull();
    expect(v.narration).toBeNull();
    expect(v.voucherNumber).toBeNull();
  });

  it("does not merge child rows with equal values, and single items stay arrays", () => {
    const r = normalizeXml(
      envelope(`<VOUCHER>
        <ALLLEDGERENTRIES.LIST><AMOUNT>10</AMOUNT>
          <BILLALLOCATIONS.LIST><NAME>B</NAME><AMOUNT>5</AMOUNT></BILLALLOCATIONS.LIST>
          <BILLALLOCATIONS.LIST><NAME>B</NAME><AMOUNT>5</AMOUNT></BILLALLOCATIONS.LIST>
        </ALLLEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST><AMOUNT>10</AMOUNT></ALLLEDGERENTRIES.LIST>
      </VOUCHER>`),
    );
    const v = r.vouchers[0]!.data;
    expect(v.ledgerEntries).toHaveLength(2);
    expect(v.ledgerEntries[0]!.billAllocations).toHaveLength(2);
    expect(Array.isArray(v.ledgerEntries[1]!.billAllocations)).toBe(true);
  });

  it("keeps mixed ledger tags in source order", () => {
    const r = normalizeXml(
      envelope(`<VOUCHER>
        <LEDGERENTRIES.LIST><LEDGERNAME>A</LEDGERNAME></LEDGERENTRIES.LIST>
        <ALLLEDGERENTRIES.LIST><LEDGERNAME>B</LEDGERNAME></ALLLEDGERENTRIES.LIST>
        <LEDGERENTRIES.LIST><LEDGERNAME>C</LEDGERNAME></LEDGERENTRIES.LIST>
      </VOUCHER>`),
    );
    const entries = r.vouchers[0]!.data.ledgerEntries;
    expect(entries.map((e) => e.ledgerName)).toEqual(["A", "B", "C"]);
    expect(entries.map((e) => e.sourceTag)).toEqual([
      "LEDGERENTRIES.LIST",
      "ALLLEDGERENTRIES.LIST",
      "LEDGERENTRIES.LIST",
    ]);
  });

  it("distinguishes an empty element from an absent one", () => {
    const v = normalizeXml(
      envelope("<VOUCHER><NARRATION></NARRATION></VOUCHER>"),
    ).vouchers[0]!.data;
    expect(v.narration).toBe("");
    expect(v.partyLedgerName).toBeNull();
  });
});

describe("unknown content", () => {
  it("aggregates repeated unknown children and keeps voucher indexes", () => {
    const entry =
      "<ALLLEDGERENTRIES.LIST><UDF:X>1</UDF:X><LEDGERNAME>L</LEDGERNAME></ALLLEDGERENTRIES.LIST>";
    const r = normalizeXml(
      envelope(
        `<VOUCHER>${entry}${entry}</VOUCHER><VOUCHER REMOTEID="r">${entry}</VOUCHER>`,
      ),
    );
    expect(r.vouchers.map((v) => v.voucherIndex)).toEqual([0, 1]);
    expect(r.vouchers[0]!.data.warnings).toHaveLength(1);
    expect(r.vouchers[0]!.data.warnings[0]!.details).toEqual({ count: 2 });

    const unknownX = r.warnings.find(
      (w) => w.path === "VOUCHER/ALLLEDGERENTRIES.LIST/UDF:X",
    );
    expect(unknownX?.details).toEqual({
      count: 3,
      vouchers: 2,
      sampleVoucherIndexes: [0, 1],
    });
    expect(
      r.warnings.some((w) => w.code === "UNKNOWN_ATTRIBUTE_NOT_NORMALIZED"),
    ).toBe(true);
  });

  it("does not invent vouchers from non-voucher collection children", () => {
    const r = normalizeXml(envelope("<LEDGER><NAME>x</NAME></LEDGER>"));
    expect(r.vouchers).toEqual([]);
    expect(r.warnings[0]).toMatchObject({
      path: "ENVELOPE/BODY/DATA/COLLECTION/LEDGER",
    });
  });

  it("indexes vouchers across multiple collections", () => {
    const xml = `<ENVELOPE><BODY><DATA>
      <COLLECTION><VOUCHER/></COLLECTION><COLLECTION><VOUCHER/></COLLECTION>
    </DATA></BODY></ENVELOPE>`;
    expect(normalizeXml(xml).vouchers.map((v) => v.voucherIndex)).toEqual([
      0, 1,
    ]);
  });
});

describe("unsupported shapes", () => {
  it("rejects a non-ENVELOPE root", () => {
    expect(caught(() => normalizeXml("<FOO/>"))).toMatchObject({
      code: "UNSUPPORTED_DOCUMENT",
    });
  });

  it("rejects an ENVELOPE without a COLLECTION", () => {
    expect(
      caught(() => normalizeXml("<ENVELOPE><BODY><DATA/></BODY></ENVELOPE>")),
    ).toMatchObject({
      code: "UNSUPPORTED_DOCUMENT",
    });
  });
});
