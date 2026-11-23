import type { RequestHandler } from "express";
import multer, { MulterError } from "multer";
import { AppError, Errors } from "../errors";

const FIELD_NAME = "file";

/**
 * Multipart framing (boundaries, headers) adds a little to the body size.
 * Used only by the early Content-Length check; the exact per-file limit is
 * enforced by the parser while streaming.
 */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

function mapUploadError(err: unknown, maxBytes: number): AppError {
  if (err instanceof MulterError) {
    switch (err.code) {
      case "LIMIT_FILE_SIZE":
        return Errors.payloadTooLarge(maxBytes);
      case "LIMIT_UNEXPECTED_FILE":
      case "LIMIT_FILE_COUNT":
        return Errors.badRequest(
          `Upload exactly one file in the "${FIELD_NAME}" field.`,
        );
      default:
        return Errors.badRequest(
          "The multipart request exceeds an upload limit.",
        );
    }
  }
  // Anything else raised while parsing the body is a malformed multipart request.
  // The underlying message is deliberately dropped.
  return Errors.badRequest("The multipart request could not be parsed.");
}

/**
 * Accepts exactly one file in the multipart field "file" and leaves it on
 * req.file (memory storage, so the exact uploaded bytes are in req.file.buffer).
 */
export function createUploadMiddleware(maxBytes: number): RequestHandler {
  const parser = multer({
    storage: multer.memoryStorage(),
    limits: {
      fileSize: maxBytes,
      files: 1,
      fields: 5,
      fieldSize: 1024,
      parts: 6,
    },
  }).single(FIELD_NAME);

  return (req, res, next) => {
    const declared = Number(req.headers["content-length"]);
    if (
      Number.isFinite(declared) &&
      declared > maxBytes + MULTIPART_OVERHEAD_BYTES
    ) {
      // Do not read a body we have already decided to refuse.
      res.setHeader("Connection", "close");
      next(Errors.payloadTooLarge(maxBytes));
      return;
    }

    parser(req, res, (err: unknown) => {
      if (err) {
        next(mapUploadError(err, maxBytes));
        return;
      }
      if (!req.file) {
        next(Errors.fileRequired());
        return;
      }
      next();
    });
  };
}
