import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { decodeDocument } from "../src/xml/decode";
import { parseXmlTree } from "../src/xml/tree";
import { normalizeTallyResponse } from "../src/normalize/response";

const run = (xml: string) => normalizeTallyResponse(parseXmlTree(xml));
const wrap = (inner: string) => `<RESPONSE>${inner}</RESPONSE>`;

function caught(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  return undefined;
}

describe("fixture 03: Tally error response", () => {
  const bytes = readFileSync(
    join(__dirname, "..", "fixtures", "03_tally_error_response.xml"),
  );
  const { tallyResponse, warnings } = normalizeTallyResponse(
    parseXmlTree(decodeDocument(bytes).text),
  );

  it("is a business failure with the exact counters and line error", () => {
    expect(tallyResponse).toEqual({
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
    expect(warnings).toEqual([]);
  });
});

describe("businessStatus rules", () => {
  const ok =
    "<CREATED>1</CREATED><ALTERED>0</ALTERED><DELETED>0</DELETED><IGNORED>0</IGNORED><ERRORS>0</ERRORS>";

  it("succeeds when ERRORS is 0 and there is no LINEERROR", () => {
    const r = run(wrap(ok));
    expect(r.tallyResponse.businessStatus).toBe("succeeded");
    expect(r.tallyResponse.lineError).toBeNull();
  });

  it("fails when ERRORS > 0 even without LINEERROR", () => {
    const r = run(wrap("<ERRORS>2</ERRORS>"));
    expect(r.tallyResponse.businessStatus).toBe("failed");
    expect(r.tallyResponse.lineError).toBeNull();
  });

  it("fails when LINEERROR is non-empty even if ERRORS is 0", () => {
    const r = run(
      wrap("<ERRORS>0</ERRORS><LINEERROR>Something broke</LINEERROR>"),
    );
    expect(r.tallyResponse.businessStatus).toBe("failed");
    expect(r.tallyResponse.lineError).toBe("Something broke");
  });

  it("does not fail on an empty or whitespace-only LINEERROR", () => {
    const r = run(wrap("<ERRORS>0</ERRORS><LINEERROR>  </LINEERROR>"));
    expect(r.tallyResponse.businessStatus).toBe("succeeded");
    expect(r.tallyResponse.lineError).toBe("  ");
  });

  it("joins several non-empty LINEERROR elements in source order", () => {
    const r = run(
      wrap(
        "<LINEERROR>first</LINEERROR><LINEERROR></LINEERROR><LINEERROR>second</LINEERROR>",
      ),
    );
    expect(r.tallyResponse.lineError).toBe("first\nsecond");
    expect(r.tallyResponse.businessStatus).toBe("failed");
  });

  it("compares large counters losslessly", () => {
    const r = run(wrap("<ERRORS>99999999999999999999999999</ERRORS>"));
    expect(r.tallyResponse.businessStatus).toBe("failed");
    expect(r.tallyResponse.counters.ERRORS).toBe("99999999999999999999999999");
  });

  it("keeps absent counters as null and trims counter whitespace", () => {
    const r = run(wrap("<CREATED> 3 </CREATED>"));
    expect(r.tallyResponse.counters).toEqual({
      CREATED: "3",
      ALTERED: null,
      DELETED: null,
      IGNORED: null,
      ERRORS: null,
    });
    expect(r.tallyResponse.businessStatus).toBe("succeeded");
  });

  it("treats a blank ERRORS element as absent", () => {
    const r = run(wrap("<ERRORS></ERRORS>"));
    expect(r.tallyResponse.businessStatus).toBe("succeeded");
    expect(r.warnings).toEqual([]);
  });

  it("treats an uninterpretable ERRORS value as failed and warns", () => {
    const r = run(wrap("<ERRORS>abc</ERRORS>"));
    expect(r.tallyResponse.businessStatus).toBe("failed");
    expect(r.warnings).toEqual([
      expect.objectContaining({
        code: "INVALID_TALLY_COUNTER",
        path: "RESPONSE/ERRORS",
      }),
    ]);
    expect(JSON.stringify(r.warnings)).not.toContain("abc");
  });

  it("warns but does not fail on an uninterpretable non-ERRORS counter", () => {
    const r = run(wrap("<CREATED>many</CREATED><ERRORS>0</ERRORS>"));
    expect(r.tallyResponse.businessStatus).toBe("succeeded");
    expect(r.warnings[0]).toMatchObject({
      code: "INVALID_TALLY_COUNTER",
      path: "RESPONSE/CREATED",
    });
  });
});

describe("structure", () => {
  it("reads only direct children", () => {
    const r = run(
      wrap("<WRAPPER><ERRORS>5</ERRORS><LINEERROR>decoy</LINEERROR></WRAPPER>"),
    );
    expect(r.tallyResponse.businessStatus).toBe("succeeded");
    expect(r.tallyResponse.counters.ERRORS).toBeNull();
    expect(r.tallyResponse.lineError).toBeNull();
    expect(r.warnings[0]).toMatchObject({
      code: "UNKNOWN_ELEMENT_NOT_NORMALIZED",
      path: "RESPONSE/WRAPPER",
    });
  });

  it("rejects a non-RESPONSE root", () => {
    expect(caught(() => run("<ENVELOPE/>"))).toMatchObject({
      code: "UNSUPPORTED_DOCUMENT",
    });
  });
});
