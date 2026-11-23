import type { ErrorRequestHandler, RequestHandler } from "express";
import { AppError, Errors, toErrorResponse } from "../errors";
import type { AppLogger } from "../logger";

/** Any unmatched route returns the same structured 404 as a missing import. */
export function notFoundHandler(): RequestHandler {
  return (_req, _res, next) => {
    next(Errors.notFound("Route"));
  };
}

/**
 * Express and its middleware (for example body parsers) throw errors carrying
 * an HTTP status. Map 4xx ones onto our own fixed messages, because their
 * messages can contain request details.
 */
function fromHttpStatus(err: unknown): AppError | null {
  if (typeof err !== "object" || err === null) return null;
  const e = err as { status?: unknown; statusCode?: unknown };
  const status = typeof e.status === "number" ? e.status : e.statusCode;
  if (
    typeof status !== "number" ||
    !Number.isInteger(status) ||
    status < 400 ||
    status > 499
  ) {
    return null;
  }
  if (status === 413) {
    return new AppError(
      413,
      "PAYLOAD_TOO_LARGE",
      "The request body exceeds the size limit.",
    );
  }
  return Errors.badRequest();
}

export function createErrorHandler(logger: AppLogger): ErrorRequestHandler {
  // Express identifies error handlers by their four parameters, so `_next`
  // must stay in the signature even though it is only used when headers
  // have already been sent.
  return (err, req, res, next) => {
    const known = err instanceof AppError ? err : fromHttpStatus(err);

    if (known) {
      // Expected client errors: metadata only, at warn level.
      logger.warn(
        {
          code: known.code,
          status: known.status,
          method: req.method,
          path: req.path,
        },
        "request rejected",
      );
    } else {
      // Unexpected. The err serializer truncates the message and, in
      // production, leaves out the stack. Request content is never logged.
      logger.error(
        { err, method: req.method, path: req.path },
        "unhandled error",
      );
    }

    if (res.headersSent) {
      // The response is already partly written; the only safe move is to let
      // Express close the connection.
      next(err);
      return;
    }

    const { status, body } = toErrorResponse(known ?? err);
    res.status(status).json(body);
  };
}
