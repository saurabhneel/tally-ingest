import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  parseXmlTree,
  childrenNamed,
  firstChild,
  childText,
} from "../src/xml/tree";
import { decodeDocument } from "../src/xml/decode";

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("parseXmlTree", () => {
  it("keeps repeated siblings with the same name as ordered children", () => {
    const root = parseXmlTree("<r><a>1</a><b>x</b><a>2</a><a>3</a></r>");
    expect(root.children.map((c) => c.name)).toEqual(["a", "b", "a", "a"]);
    expect(childrenNamed(root, "a").map((c) => c.text)).toEqual([
      "1",
      "2",
      "3",
    ]);
  });

  it("handles self-closing elements and attributes", () => {
    const root = parseXmlTree('<r><v VCHTYPE="Receipt" ACTION="Create"/></r>');
    const v = firstChild(root, "v");
    expect(v?.children).toEqual([]);
    expect({ ...v?.attributes }).toEqual({
      VCHTYPE: "Receipt",
      ACTION: "Create",
    });
  });

  it("returns text exactly as written, decoding entities and CDATA", () => {
    const root = parseXmlTree(
      "<r><a>  Tom &amp; Jerry  </a><b><![CDATA[<x>&]]></b><c></c></r>",
    );
    expect(childText(root, "a")).toBe("  Tom & Jerry  ");
    expect(childText(root, "b")).toBe("<x>&");
    expect(childText(root, "c")).toBe("");
    expect(childText(root, "missing")).toBeNull();
  });

  it("childText only looks at direct children, never descendants", () => {
    const root = parseXmlTree("<r><x><AMOUNT>1</AMOUNT></x></r>");
    expect(childText(root, "AMOUNT")).toBeNull();
  });

  it("childText accepts alternative names and takes the first in document order", () => {
    const root = parseXmlTree("<r><n>short</n><NAME>long</NAME></r>");
    expect(childText(root, ["NAME", "n"])).toBe("short");
  });

  it("accepts prefixed custom element names", () => {
    const root = parseXmlTree("<r><UDF:CUSTOM.LIST>x</UDF:CUSTOM.LIST></r>");
    expect(root.children[0]?.name).toBe("UDF:CUSTOM.LIST");
  });

  it("uses null-prototype attribute objects", () => {
    const root = parseXmlTree('<r __proto__="x"/>');
    expect(Object.getPrototypeOf(root.attributes)).toBeNull();
    expect(root.attributes["__proto__"]).toBe("x");
    expect(({} as Record<string, unknown>)["x"]).toBeUndefined();
  });

  it("parses fixture 01 into two ordered ledger entries", () => {
    const bytes = readFileSync(
      join(__dirname, "..", "fixtures", "01_receipt_with_allocations.xml"),
    );
    const root = parseXmlTree(decodeDocument(bytes).text);
    expect(root.name).toBe("ENVELOPE");
    const voucher = firstChild(
      firstChild(firstChild(firstChild(root, "BODY")!, "DATA")!, "COLLECTION")!,
      "VOUCHER",
    )!;
    const entries = childrenNamed(voucher, "ALLLEDGERENTRIES.LIST");
    expect(entries.map((e) => childText(e, "LEDGERNAME"))).toEqual([
      "Demo Bank",
      "Demo Customer",
    ]);
    expect(entries.map((e) => childText(e, "AMOUNT"))).toEqual([
      "1250.00",
      "-1250.00",
    ]);
  });
});

describe("parseXmlTree security and errors", () => {
  it("rejects a plain DOCTYPE", () => {
    expect(caught(() => parseXmlTree("<!DOCTYPE a><a/>"))).toMatchObject({
      code: "UNSUPPORTED_DOCUMENT",
    });
  });

  it("rejects external entity (XXE) definitions", () => {
    const xml =
      '<?xml version="1.0"?><!DOCTYPE a [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><a>&xxe;</a>';
    const err = caught(() => parseXmlTree(xml)) as { code: string };
    expect(["UNSUPPORTED_DOCUMENT", "INVALID_XML"]).toContain(err.code);
  });

  it("rejects entity-expansion (billion laughs) definitions", () => {
    const xml =
      '<?xml version="1.0"?><!DOCTYPE l [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;">]><l>&b;</l>';
    const err = caught(() => parseXmlTree(xml)) as { code: string };
    expect(["UNSUPPORTED_DOCUMENT", "INVALID_XML"]).toContain(err.code);
  });

  it("rejects references to undefined entities", () => {
    expect(caught(() => parseXmlTree("<a>&xxe;</a>"))).toMatchObject({
      code: "INVALID_XML",
    });
  });

  it("reports malformed XML with line and column only", () => {
    const err = caught(() => parseXmlTree("<a>\n  <b></a>")) as {
      code: string;
      status: number;
      details: Record<string, unknown>;
      message: string;
    };
    expect(err).toMatchObject({ code: "INVALID_XML", status: 422 });
    expect(err.details).toEqual({
      line: expect.any(Number),
      column: expect.any(Number),
    });
    expect(err.message).not.toContain("<b>");
  });

  it("rejects empty input and multiple roots", () => {
    expect(caught(() => parseXmlTree(""))).toMatchObject({
      code: "INVALID_XML",
    });
    expect(caught(() => parseXmlTree("<a/><b/>"))).toMatchObject({
      code: "INVALID_XML",
    });
  });

  it("enforces depth and element limits", () => {
    const deep = "<a>".repeat(5) + "</a>".repeat(5);
    expect(
      caught(() => parseXmlTree(deep, { maxDepth: 3, maxElements: 100 })),
    ).toMatchObject({ code: "UNSUPPORTED_DOCUMENT" });

    const wide = "<r>" + "<i/>".repeat(10) + "</r>";
    expect(
      caught(() => parseXmlTree(wide, { maxDepth: 10, maxElements: 5 })),
    ).toMatchObject({ code: "UNSUPPORTED_DOCUMENT" });
  });
});
