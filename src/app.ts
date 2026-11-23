import { performance } from "node:perf_hooks";
import express, { type Express } from "express";
import helmet from "helmet";
import type { Config } from "./config";
import type { Db } from "./db/connection";
import type { AppLogger } from "./logger";
import { createErrorHandler, notFoundHandler } from "./middleware/errors";
import { ImportRepository } from "./repo/importRepo";
import { createHealthRouter } from "./routes/health";
import { createImportsRouter } from "./routes/imports";
import { ImportService } from "./services/importService";

export interface AppDeps {
  config: Config;
  logger: AppLogger;
  db: Db;
}

export function createApp({ config, logger, db }: AppDeps): Express {
  const app = express();

  app.disable("x-powered-by");
  // Responses are never cacheable (see routes), so ETags add nothing.
  app.set("etag", false);

  app.use(helmet());

  // One access-log line per request: method, path (no query string, which could
  // carry identifiers), status and duration. Never headers, bodies or files.
  app.use((req, res, next) => {
    const started = performance.now();
    res.on("finish", () => {
      const level = req.path === "/health" ? "debug" : "info";
      logger[level](
        {
          method: req.method,
          path: req.path,
          status: res.statusCode,
          durationMs: Math.round(performance.now() - started),
        },
        "request completed",
      );
    });
    next();
  });

  const repo = new ImportRepository(db);
  const service = new ImportService(repo, logger);

  app.use(createHealthRouter(db, logger));
  app.use(
    "/api/tally/imports",
    createImportsRouter(service, config.MAX_UPLOAD_BYTES),
  );

  app.use(notFoundHandler());
  app.use(createErrorHandler(logger));

  return app;
}
