import type { ImportWarning } from "../warnings";

export interface SanitizeResult {
  /** Text safe to hand to a strict XML 1.0 parser. */
  text: string;
  warnings: ImportWarning[];
}

const MAX_LISTED_CODE_POINTS = 10;

// XML 1.0 "Char" production:
//   #x9 | #xA | #xD | [#x20-#xD7FF] | [#xE000-#xFFFD] | [#x10000-#x10FFFF]
function isLegalXmlCodePoint(cp: number): boolean {
  return (
    cp === 0x9 ||
    cp === 0xa ||
    cp === 0xd ||
    (cp >= 0x20 && cp <= 0xd7ff) ||
    (cp >= 0xe000 && cp <= 0xfffd) ||
    (cp >= 0x10000 && cp <= 0x10ffff)
  );
}

function label(cp: number): string {
  if (!Number.isFinite(cp) || cp > 0x10ffff) return "out-of-range";
  return `U+${cp.toString(16).toUpperCase().padStart(4, "0")}`;
}

class Tally {
  count = 0;
  private readonly seen = new Set<string>();

  add(cp: number): void {
    this.count++;
    this.seen.add(label(cp));
  }

  /** Sorted and capped, so the warning stays small however bad the input is. */
  listed(): string[] {
    return [...this.seen].sort().slice(0, MAX_LISTED_CODE_POINTS);
  }
}

const NUMERIC_REFERENCE = /&#(?:[xX]([0-9A-Fa-f]+)|([0-9]+));/g;
// Literal control characters that XML 1.0 also forbids (tab, LF, CR are legal).
// eslint-disable-next-line no-control-regex
const RAW_ILLEGAL_CHARS =
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g;

/**
 * Remove characters that are illegal in XML 1.0, and report what was removed.
 *
 * Only the parse copy is changed. The caller keeps the original uploaded bytes,
 * so the decision can always be investigated later.
 *
 * Known limitation: this is a text-level pass, so a reference inside a CDATA
 * section or comment is treated like any other. A character that is illegal
 * in XML is illegal there too once a strict parser is involved, so the result
 * is still parseable.
 */
export function sanitizeXmlText(input: string): SanitizeResult {
  const references = new Tally();
  const rawChars = new Tally();

  let text = input.replace(
    NUMERIC_REFERENCE,
    (match: string, hex: string | undefined, dec: string | undefined) => {
      const cp =
        hex !== undefined ? parseInt(hex, 16) : parseInt(dec ?? "", 10);
      if (isLegalXmlCodePoint(cp)) return match;
      references.add(cp);
      return "";
    },
  );

  text = text.replace(RAW_ILLEGAL_CHARS, (ch: string) => {
    rawChars.add(ch.charCodeAt(0));
    return "";
  });

  const warnings: ImportWarning[] = [];

  if (references.count > 0) {
    warnings.push({
      code: "ILLEGAL_XML_CHARACTER_REFERENCE_REMOVED",
      message:
        `Removed ${references.count} numeric character reference(s) that are illegal in XML 1.0 ` +
        `so the document could be parsed. The original upload is retained unchanged.`,
      details: { count: references.count, codePoints: references.listed() },
    });
  }

  if (rawChars.count > 0) {
    warnings.push({
      code: "ILLEGAL_XML_CHARACTER_REMOVED",
      message:
        `Removed ${rawChars.count} control character(s) that are illegal in XML 1.0 ` +
        `so the document could be parsed. The original upload is retained unchanged.`,
      details: { count: rawChars.count, codePoints: rawChars.listed() },
    });
  }

  return { text, warnings };
}
