import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeXmlText } from "../src/xml/sanitize";
import { decodeDocument } from "../src/xml/decode";

describe("sanitizeXmlText", () => {
  it("returns the input unchanged and no warnings for clean text", () => {
    const xml = '<a x="1">Tom &amp; Jerry &#65; &#x41; &#9;&#10;&#13;</a>';
    const r = sanitizeXmlText(xml);
    expect(r.text).toBe(xml);
    expect(r.warnings).toEqual([]);
  });

  it("removes an illegal decimal reference and records a warning", () => {
    const r = sanitizeXmlText("<n>a&#4;b</n>");
    expect(r.text).toBe("<n>ab</n>");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({
      code: "ILLEGAL_XML_CHARACTER_REFERENCE_REMOVED",
      details: { count: 1, codePoints: ["U+0004"] },
    });
  });

  it("removes hex references in either case and counts them", () => {
    const r = sanitizeXmlText("<n>&#x1F;&#X0b;&#4;&#4;</n>");
    expect(r.text).toBe("<n></n>");
    expect(r.warnings[0]?.details).toMatchObject({
      count: 4,
      codePoints: ["U+0004", "U+000B", "U+001F"],
    });
  });

  it("treats NUL, surrogates, noncharacters and out-of-range references as illegal", () => {
    const r = sanitizeXmlText(
      "<n>&#0;&#xD800;&#xFFFE;&#1114112;&#" + "9".repeat(400) + ";</n>",
    );
    expect(r.text).toBe("<n></n>");
    expect(r.warnings[0]?.details).toMatchObject({ count: 5 });
    expect(r.warnings[0]?.details?.codePoints).toContain("out-of-range");
  });

  it("removes literal illegal control characters with a separate warning", () => {
    const r = sanitizeXmlText("<n>a\u0004b\tc\nd</n>");
    expect(r.text).toBe("<n>ab\tc\nd</n>");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]).toMatchObject({
      code: "ILLEGAL_XML_CHARACTER_REMOVED",
      details: { count: 1, codePoints: ["U+0004"] },
    });
  });

  it("never puts document text into warnings", () => {
    const r = sanitizeXmlText("<n>SECRET-LEDGER&#4;</n>");
    expect(JSON.stringify(r.warnings)).not.toContain("SECRET-LEDGER");
  });

  it("recovers fixture 04 (UTF-16 with an illegal reference)", () => {
    const bytes = readFileSync(
      join(__dirname, "..", "fixtures", "04_utf16_invalid_control_ref.xml"),
    );
    const decoded = decodeDocument(bytes);
    expect(decoded.text).toContain("&#4;");

    const r = sanitizeXmlText(decoded.text);
    expect(r.text).not.toContain("&#4;");
    expect(r.text).toContain("Recoverable control reference  in UTF-16 input");
    expect(r.warnings).toHaveLength(1);
    expect(r.warnings[0]?.code).toBe("ILLEGAL_XML_CHARACTER_REFERENCE_REMOVED");
  });
});
