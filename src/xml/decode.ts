import { createHash } from "node:crypto";
import { Errors } from "../errors";

export type DetectedEncoding = "UTF-8" | "UTF-8-BOM" | "UTF-16LE" | "UTF-16BE";

export interface DecodedDocument {
  /** Decoded text with any BOM removed. */
  text: string;
  detectedEncoding: DetectedEncoding;
  /** Value of encoding="..." in the XML declaration, if present (informational). */
  declaredEncoding: string | null;
}

/** Content identity: lowercase 64-char hex SHA-256 of the exact uploaded bytes. */
export function sha256Hex(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

interface Detection {
  encoding: DetectedEncoding;
  /** Number of leading BOM bytes to skip. */
  bomLength: number;
}

function detectEncoding(bytes: Uint8Array): Detection {
  const [b0, b1, b2, b3] = bytes;

  // UTF-32 BOMs begin with the UTF-16 ones (FF FE 00 00), so check them first.
  // They are out of scope; reject rather than mis-decode as UTF-16.
  if (
    (b0 === 0xff && b1 === 0xfe && b2 === 0x00 && b3 === 0x00) ||
    (b0 === 0x00 && b1 === 0x00 && b2 === 0xfe && b3 === 0xff)
  ) {
    throw Errors.unsupportedEncoding();
  }

  if (b0 === 0xef && b1 === 0xbb && b2 === 0xbf) {
    return { encoding: "UTF-8-BOM", bomLength: 3 };
  }
  if (b0 === 0xff && b1 === 0xfe) return { encoding: "UTF-16LE", bomLength: 2 };
  if (b0 === 0xfe && b1 === 0xff) return { encoding: "UTF-16BE", bomLength: 2 };

  // No BOM. Valid XML text never starts with a NUL byte, so a NUL in the first
  // bytes means BOM-less UTF-16/32. Only BOM-marked UTF-16 is supported, and
  // strict UTF-8 decoding would accept NULs, so reject explicitly.
  for (let i = 0; i < Math.min(4, bytes.length); i++) {
    if (bytes[i] === 0x00) throw Errors.unsupportedEncoding();
  }

  return { encoding: "UTF-8", bomLength: 0 };
}

const XML_DECLARED_ENCODING =
  /^\s*<\?xml[^>]*\sencoding\s*=\s*["']([A-Za-z0-9._-]+)["']/;

/**
 * Decode uploaded bytes. Throws AppError(UNSUPPORTED_ENCODING) when the bytes
 * cannot be decoded strictly (invalid UTF-8, truncated UTF-16, lone surrogates).
 * Failing loudly beats silently inserting U+FFFD replacement characters into
 * accounting data.
 */
export function decodeDocument(bytes: Buffer): DecodedDocument {
  const { encoding, bomLength } = detectEncoding(bytes);
  const body = bytes.subarray(bomLength);

  let text: string;
  try {
    if (encoding === "UTF-8" || encoding === "UTF-8-BOM") {
      text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
        body,
      );
    } else {
      if (body.length % 2 !== 0) throw new Error("odd UTF-16 byte length");
      let le: Uint8Array = body;
      if (encoding === "UTF-16BE") {
        // Copy before swapping: swap16 mutates in place and `body` is a view
        // into the caller's buffer, which is also the stored raw source.
        const copy = Buffer.from(body);
        copy.swap16();
        le = copy;
      }
      text = new TextDecoder("utf-16le", {
        fatal: true,
        ignoreBOM: true,
      }).decode(le);
    }
  } catch {
    throw Errors.unsupportedEncoding();
  }

  const declared = XML_DECLARED_ENCODING.exec(text.slice(0, 256));
  return {
    text,
    detectedEncoding: encoding,
    declaredEncoding: declared?.[1] ?? null,
  };
}
