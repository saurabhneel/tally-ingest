import { Errors } from "../errors";
import type { ImportWarning } from "../warnings";
import { childText, childrenNamed, type XmlElement } from "../xml/tree";

export const COUNTER_TAGS = [
  "CREATED",
  "ALTERED",
  "DELETED",
  "IGNORED",
  "ERRORS",
] as const;
export type CounterName = (typeof COUNTER_TAGS)[number];

export type BusinessStatus = "succeeded" | "failed";

export interface TallyResponseDetails {
  businessStatus: BusinessStatus;
  /** Source strings (trimmed), consistently. Null when the element is absent. */
  counters: Record<CounterName, string | null>;
  /** Text of LINEERROR as sent by Tally. Null when the element is absent. */
  lineError: string | null;
}

export interface TallyResponseResult {
  tallyResponse: TallyResponseDetails;
  warnings: ImportWarning[];
}

const KNOWN_CHILDREN: ReadonlySet<string> = new Set([
  ...COUNTER_TAGS,
  "LINEERROR",
]);
const MAX_NAME_LENGTH = 100;
const INTEGER = /^[+-]?\d+$/;

/**
 * Normalize a RESPONSE document (the result of a Tally operation).
 *
 * businessStatus is "failed" when ERRORS > 0 or LINEERROR is non-empty,
 * otherwise "succeeded". Counters are compared with BigInt, so a huge value
 * cannot lose precision or overflow.
 *
 * Assumption (documented in the README): an ERRORS value that is neither blank
 * nor an integer cannot be interpreted. A false "succeeded" is the costly
 * mistake when money is involved, so it is treated as "failed" and a warning is
 * recorded. A blank ERRORS element counts as absent.
 */
export function normalizeTallyResponse(root: XmlElement): TallyResponseResult {
  if (root.name !== "RESPONSE") {
    throw Errors.unsupportedDocument("Expected a RESPONSE root element.");
  }

  const warnings: ImportWarning[] = [];

  // Direct children only. The first occurrence of each counter is used.
  const counters = {} as Record<CounterName, string | null>;
  for (const tag of COUNTER_TAGS) {
    const raw = childText(root, tag);
    counters[tag] = raw === null ? null : raw.trim();
  }

  let errorsPositive = false;
  let errorsUninterpretable = false;
  for (const tag of COUNTER_TAGS) {
    const value = counters[tag];
    if (value === null || value === "") continue;
    if (!INTEGER.test(value)) {
      warnings.push({
        code: "INVALID_TALLY_COUNTER",
        message: `The ${tag} counter is not an integer and could not be interpreted.`,
        path: `RESPONSE/${tag}`,
      });
      if (tag === "ERRORS") errorsUninterpretable = true;
    } else if (tag === "ERRORS" && BigInt(value) > 0n) {
      errorsPositive = true;
    }
  }

  // LINEERROR may legitimately appear more than once; any non-empty one counts.
  const lineErrorTexts = childrenNamed(root, "LINEERROR").map((el) => el.text);
  const nonEmptyLineErrors = lineErrorTexts.filter((t) => t.trim() !== "");
  const lineError =
    nonEmptyLineErrors.length > 0
      ? nonEmptyLineErrors.join("\n")
      : (lineErrorTexts[0] ?? null);

  const failed =
    errorsPositive || errorsUninterpretable || nonEmptyLineErrors.length > 0;

  // Anything else directly under RESPONSE is retained only in the raw upload.
  const unknownCounts = new Map<string, number>();
  for (const child of root.children) {
    if (!KNOWN_CHILDREN.has(child.name)) {
      unknownCounts.set(child.name, (unknownCounts.get(child.name) ?? 0) + 1);
    }
  }
  for (const [name, count] of unknownCounts) {
    const shown =
      name.length > MAX_NAME_LENGTH
        ? `${name.slice(0, MAX_NAME_LENGTH)}…`
        : name;
    warnings.push({
      code: "UNKNOWN_ELEMENT_NOT_NORMALIZED",
      message:
        "An element outside the normalized contract was found. It is retained only in the raw upload and was not normalized.",
      path: `RESPONSE/${shown}`,
      details: { count },
    });
  }

  return {
    tallyResponse: {
      businessStatus: failed ? "failed" : "succeeded",
      counters,
      lineError,
    },
    warnings,
  };
}
