export type ErrorCode =
  | "BAD_REQUEST"
  | "FILE_REQUIRED"
  | "PAYLOAD_TOO_LARGE"
  | "INVALID_XML"
  | "UNSUPPORTED_DOCUMENT"
  | "UNSUPPORTED_ENCODING"
  | "NOT_FOUND"
  | "INTERNAL_ERROR";

/**
 * An error that is safe to show to API clients.
 * `message` and `details` must never contain stack traces, file paths,
 * SQL, or fragments of the uploaded document.
 */
export class AppError extends Error {
  readonly status: number;
  readonly code: ErrorCode;
  readonly details?: Record<string, string | number | boolean>;

  constructor(
    status: number,
    code: ErrorCode,
    message: string,
    details?: Record<string, string | number | boolean>,
  ) {
    super(message);
    this.name = "AppError";
    this.status = status;
    this.code = code;
    if (details) this.details = details;
  }
}

export const Errors = {
  badRequest: (message = "The request is invalid.") =>
    new AppError(400, "BAD_REQUEST", message),

  fileRequired: () =>
    new AppError(
      400,
      "FILE_REQUIRED",
      'A multipart/form-data request with a single file in the "file" field is required.',
    ),

  payloadTooLarge: (maxBytes: number) =>
    new AppError(
      413,
      "PAYLOAD_TOO_LARGE",
      "The uploaded file exceeds the size limit.",
      {
        maxBytes,
      },
    ),

  invalidXml: (location?: { line: number; column: number }) =>
    new AppError(
      422,
      "INVALID_XML",
      "The uploaded document is not well-formed XML.",
      location ? { line: location.line, column: location.column } : undefined,
    ),

  unsupportedDocument: (reason: string) =>
    new AppError(422, "UNSUPPORTED_DOCUMENT", reason),

  unsupportedEncoding: () =>
    new AppError(
      422,
      "UNSUPPORTED_ENCODING",
      "The uploaded document could not be decoded. Supported encodings: UTF-8, UTF-8 with BOM, UTF-16 with BOM.",
    ),

  notFound: (what = "Resource") =>
    new AppError(404, "NOT_FOUND", `${what} not found.`),
};

export interface ErrorResponseBody {
  error: {
    code: ErrorCode;
    message: string;
    details?: Record<string, string | number | boolean>;
  };
}

/** Convert any thrown value into a safe HTTP status and body. */
export function toErrorResponse(err: unknown): {
  status: number;
  body: ErrorResponseBody;
} {
  if (err instanceof AppError) {
    return {
      status: err.status,
      body: {
        error: {
          code: err.code,
          message: err.message,
          ...(err.details ? { details: err.details } : {}),
        },
      },
    };
  }
  return {
    status: 500,
    body: {
      error: {
        code: "INTERNAL_ERROR",
        message: "An unexpected error occurred.",
      },
    },
  };
}
