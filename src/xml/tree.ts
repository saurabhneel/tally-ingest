import { SaxesParser } from "saxes";
import { AppError, Errors } from "../errors";

export interface XmlElement {
  name: string;
  /** Null-prototype object, so an attribute named "__proto__" cannot pollute anything. */
  attributes: Record<string, string>;
  /** Direct child elements, in source order. */
  children: XmlElement[];
  /**
   * Direct text and CDATA content, exactly as in the source (entities decoded,
   * nothing trimmed). For elements with children this is normally just
   * whitespace and should be ignored.
   */
  text: string;
}

export interface XmlLimits {
  maxDepth: number;
  maxElements: number;
}

export const DEFAULT_XML_LIMITS: XmlLimits = {
  maxDepth: 64,
  maxElements: 1_000_000,
};

/**
 * Parse XML text into an ordered element tree.
 *
 * Security posture:
 *  - Any <!DOCTYPE ...> is rejected, so no DTD, no internal entity definitions
 *    (billion laughs) and no external entities (XXE). saxes also never resolves
 *    external resources, and it errors on undefined entity references.
 *  - Depth and element-count limits bound memory and recursion.
 *  - Errors are mapped to our own messages. Parser messages are never returned.
 */
export function parseXmlTree(
  text: string,
  limits: XmlLimits = DEFAULT_XML_LIMITS,
): XmlElement {
  const parser = new SaxesParser({ position: true });
  const stack: XmlElement[] = [];
  // Held in an object because assignments inside callbacks are invisible to
  // TypeScript's control-flow analysis.
  const state: { root: XmlElement | null; elementCount: number } = {
    root: null,
    elementCount: 0,
  };

  parser.on("doctype", () => {
    throw Errors.unsupportedDocument(
      "DOCTYPE and DTD declarations are not allowed.",
    );
  });

  parser.on("opentag", (tag) => {
    state.elementCount++;
    if (state.elementCount > limits.maxElements) {
      throw Errors.unsupportedDocument(
        "The XML document contains too many elements.",
      );
    }
    if (stack.length >= limits.maxDepth) {
      throw Errors.unsupportedDocument(
        "The XML document is nested too deeply.",
      );
    }

    const attributes: Record<string, string> = Object.create(null);
    for (const [key, value] of Object.entries(tag.attributes)) {
      // Plain strings without namespace mode; objects with a .value with it.
      attributes[key] = typeof value === "string" ? value : value.value;
    }

    const element: XmlElement = {
      name: tag.name,
      attributes,
      children: [],
      text: "",
    };
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(element);
    else state.root = element;
    stack.push(element);
  });

  parser.on("closetag", () => {
    stack.pop();
  });

  const appendText = (data: string) => {
    const top = stack[stack.length - 1];
    if (top) top.text += data;
  };
  parser.on("text", appendText);
  parser.on("cdata", appendText);

  try {
    parser.write(text);
    parser.close();
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw Errors.invalidXml({ line: parser.line, column: parser.column });
  }

  if (!state.root) throw Errors.invalidXml();
  return state.root;
}

// ---- Direct-child helpers --------------------------------------------------
// Deliberately no descendant search. Callers navigate one level at a time.

/** Direct children with this exact name, in source order. */
export function childrenNamed(el: XmlElement, name: string): XmlElement[] {
  return el.children.filter((c) => c.name === name);
}

/** First direct child with this exact name, or undefined. */
export function firstChild(
  el: XmlElement,
  name: string,
): XmlElement | undefined {
  return el.children.find((c) => c.name === name);
}

/**
 * Text of the first direct child whose name is in `names` (document order), or
 * null when no such child exists. An empty element returns "", which is
 * different from absent (null). The text is exactly the source text.
 */
export function childText(
  el: XmlElement,
  names: string | readonly string[],
): string | null {
  const wanted = typeof names === "string" ? [names] : names;
  const child = el.children.find((c) => wanted.includes(c.name));
  return child ? child.text : null;
}
