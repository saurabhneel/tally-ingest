import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeDocument, sha256Hex } from "../src/xml/decode";

const fixture = (name: string) =>
  readFileSync(join(__dirname, "..", "fixtures", name));

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("decodeDocument", () => {
  it("decodes plain UTF-8", () => {
    const d = decodeDocument(fixture("01_receipt_with_allocations.xml"));
    expect(d.detectedEncoding).toBe("UTF-8");
    expect(d.declaredEncoding).toBe("UTF-8");
    expect(d.text.startsWith("<?xml")).toBe(true);
  });

  it("detects UTF-8 BOM and strips it from the text", () => {
    const d = decodeDocument(fixture("07_utf8_bom_payment.xml"));
    expect(d.detectedEncoding).toBe("UTF-8-BOM");
    expect(d.text.startsWith("<?xml")).toBe(true);
    expect(d.text).toContain("PAY-DEMO-UTF8-BOM");
  });

  it("decodes UTF-16LE with BOM and leaves the illegal reference for the sanitizer", () => {
    const d = decodeDocument(fixture("04_utf16_invalid_control_ref.xml"));
    expect(d.detectedEncoding).toBe("UTF-16LE");
    expect(d.declaredEncoding).toBe("UTF-16");
    expect(d.text).toContain("JRN-DEMO-UTF16");
    expect(d.text).toContain("&#4;");
  });

  it("decodes UTF-16BE with BOM without mutating the input buffer", () => {
    const le = Buffer.from("<a>é</a>", "utf16le");
    const be = Buffer.from(le);
    be.swap16();
    const input = Buffer.concat([Buffer.from([0xfe, 0xff]), be]);
    const before = Buffer.from(input);

    const d = decodeDocument(input);
    expect(d.detectedEncoding).toBe("UTF-16BE");
    expect(d.text).toBe("<a>é</a>");
    expect(input.equals(before)).toBe(true);
  });

  it("rejects invalid UTF-8 instead of inserting replacement characters", () => {
    const err = caught(() =>
      decodeDocument(Buffer.from([0x3c, 0x61, 0xff, 0xfe, 0x3e])),
    );
    expect(err).toMatchObject({ code: "UNSUPPORTED_ENCODING", status: 422 });
  });

  it("rejects UTF-16 without a BOM", () => {
    const err = caught(() => decodeDocument(Buffer.from("<a/>", "utf16le")));
    expect(err).toMatchObject({ code: "UNSUPPORTED_ENCODING" });
  });

  it("rejects truncated UTF-16", () => {
    const err = caught(() => decodeDocument(Buffer.from([0xff, 0xfe, 0x3c])));
    expect(err).toMatchObject({ code: "UNSUPPORTED_ENCODING" });
  });
});

describe("sha256Hex", () => {
  it("matches a known vector, lowercase hex", () => {
    expect(sha256Hex(Buffer.from("abc"))).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is identical for byte-identical fixtures and differs for different content", () => {
    const a = sha256Hex(fixture("01_receipt_with_allocations.xml"));
    const dup = sha256Hex(fixture("06_duplicate_receipt.xml"));
    const other = sha256Hex(fixture("07_utf8_bom_payment.xml"));
    expect(a).toBe(dup);
    expect(a).not.toBe(other);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});
