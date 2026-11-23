import { performance } from "node:perf_hooks";
import { AppError, Errors } from "../errors";
import type { AppLogger } from "../logger";
import { normalizeTallyResponse } from "../normalize/response";
import { normalizeVoucherExport } from "../normalize/voucher";
import {
  ImportRepository,
  type ImportRecord,
  type NewImport,
  type SaveResult,
  type VoucherItem,
} from "../repo/importRepo";
import type { ImportWarning } from "../warnings";
import {
  decodeDocument,
  sha256Hex,
  type DetectedEncoding,
} from "../xml/decode";
import { sanitizeXmlText } from "../xml/sanitize";
import { parseXmlTree, type XmlLimits } from "../xml/tree";

export interface ImportInput {
  /** The exact uploaded bytes. */
  bytes: Buffer;
  /** Client-supplied name. Audit only: never used for identity or paths. */
  filename?: string | null;
}

const MAX_FILENAME_LENGTH = 255;

/** Keep only the final path segment, drop control characters, cap the length. */
function sanitizeFilename(name: string | null | undefined): string | null {
  if (!name) return null;
  const base = name.split(/[\\/]/).pop() ?? "";
  // eslint-disable-next-line no-control-regex
  const cleaned = base.replace(/[\u0000-\u001F\u007F]/g, "").trim();
  return cleaned ? cleaned.slice(0, MAX_FILENAME_LENGTH) : null;
}

const UTF8_NAMES = new Set(["utf-8", "utf8", "us-ascii", "ascii"]);
const UTF16_ANY = ["utf-16", "utf16"];

function declarationAgrees(
  declared: string | null,
  detected: DetectedEncoding,
): boolean {
  if (declared === null) return true;
  const d = declared.toLowerCase().replace(/_/g, "-");
  switch (detected) {
    case "UTF-8":
    case "UTF-8-BOM":
      return UTF8_NAMES.has(d);
    case "UTF-16LE":
      return [...UTF16_ANY, "utf-16le", "utf16le"].includes(d);
    case "UTF-16BE":
      return [...UTF16_ANY, "utf-16be", "utf16be"].includes(d);
  }
}

export class ImportService {
  constructor(
    private readonly repo: ImportRepository,
    private readonly logger: AppLogger,
    private readonly xmlLimits?: XmlLimits,
  ) {}

  /**
   * Import one uploaded document.
   *
   * Rejects (structured 4xx AppError) documents that cannot be decoded, are not
   * well-formed XML, use a DTD, or are neither an ENVELOPE nor a RESPONSE.
   * Everything else is persisted with status "completed". That status means
   * "decoded, parsed and stored". It says nothing about Tally's business outcome.
   */
  importDocument(input: ImportInput): SaveResult {
    const started = performance.now();
    const contentHash = sha256Hex(input.bytes);

    // Fast path for an exact-byte repeat. Not the guarantee: see saveImport.
    const existing = this.repo.findByContentHash(contentHash);
    if (existing) {
      this.logImport(existing, true, input.bytes.length, started);
      return { record: existing, duplicate: true };
    }

    let prepared: NewImport;
    try {
      prepared = this.prepare(input, contentHash);
    } catch (err) {
      if (err instanceof AppError) {
        // Metadata only. The document itself is never logged.
        this.logger.warn(
          { code: err.code, contentHash, bytes: input.bytes.length },
          "import rejected",
        );
      }
      throw err;
    }

    const result = this.repo.saveImport(prepared);
    this.logImport(
      result.record,
      result.duplicate,
      input.bytes.length,
      started,
    );
    return result;
  }

  getImportDetails(importId: string): ImportRecord {
    const record = this.repo.getImport(importId);
    if (!record) throw Errors.notFound("Import");
    return record;
  }

  getVouchers(importId: string): VoucherItem[] {
    const items = this.repo.getVouchers(importId);
    if (!items) throw Errors.notFound("Import");
    return items;
  }

  // ---------------------------------------------------------------------------

  private prepare(input: ImportInput, contentHash: string): NewImport {
    const decoded = decodeDocument(input.bytes);
    const sanitized = sanitizeXmlText(decoded.text);
    const root = parseXmlTree(sanitized.text, this.xmlLimits);

    const warnings: ImportWarning[] = [];
    if (
      !declarationAgrees(decoded.declaredEncoding, decoded.detectedEncoding)
    ) {
      warnings.push({
        code: "ENCODING_DECLARATION_MISMATCH",
        message:
          "The XML declaration names an encoding that differs from the detected byte encoding. The detected encoding was used.",
        details: { detectedEncoding: decoded.detectedEncoding },
      });
    }
    warnings.push(...sanitized.warnings);

    const common = {
      contentHash,
      originalFilename: sanitizeFilename(input.filename),
      rawContent: input.bytes,
      detectedEncoding: decoded.detectedEncoding,
      status: "completed" as const,
      errors: [],
    };

    if (root.name === "ENVELOPE") {
      const result = normalizeVoucherExport(root);
      warnings.push(...result.warnings);
      return {
        ...common,
        documentType: "voucherExport",
        warnings,
        summary: {
          vouchers: result.vouchers.length,
          ledgerEntries: result.vouchers.reduce(
            (n, v) => n + v.data.ledgerEntries.length,
            0,
          ),
          inventoryEntries: result.vouchers.reduce(
            (n, v) => n + v.data.inventoryEntries.length,
            0,
          ),
          warnings: warnings.length,
          errors: 0,
        },
        tallyResponse: null,
        vouchers: result.vouchers,
      };
    }

    if (root.name === "RESPONSE") {
      const result = normalizeTallyResponse(root);
      warnings.push(...result.warnings);
      return {
        ...common,
        documentType: "tallyResponse",
        warnings,
        summary: {
          vouchers: 0,
          ledgerEntries: 0,
          inventoryEntries: 0,
          warnings: warnings.length,
          // Pipeline errors only. Tally's own ERRORS counter lives in tallyResponse.
          errors: 0,
        },
        tallyResponse: result.tallyResponse,
        vouchers: [],
      };
    }

    throw Errors.unsupportedDocument(
      "Unsupported document. Expected an ENVELOPE (voucher export) or RESPONSE (Tally response) root element.",
    );
  }

  private logImport(
    record: ImportRecord,
    duplicate: boolean,
    bytes: number,
    started: number,
  ): void {
    // Identifiers, sizes and counts only. Never document content.
    this.logger.info(
      {
        importId: record.importId,
        contentHash: record.contentHash,
        documentType: record.documentType,
        status: record.status,
        duplicate,
        bytes,
        summary: record.summary,
        durationMs: Math.round(performance.now() - started),
      },
      duplicate ? "import deduplicated" : "import stored",
    );
  }
}
