import { createApp } from "./app";
import { loadConfig, type Config } from "./config";
import { openDatabase, type Db } from "./db/connection";
import { runMigrations } from "./db/migrate";
import { createLogger, type AppLogger } from "./logger";

// Time for a client to send complete request headers.
const HEADERS_TIMEOUT_MS = 15_000;
// Time for a client to send the complete request, body included. Bounds slow uploads.
const REQUEST_TIMEOUT_MS = 60_000;
// Must stay below HEADERS_TIMEOUT_MS. Keep-alive is kept short on purpose.
const KEEP_ALIVE_TIMEOUT_MS = 5_000;
// How long in-flight requests get to finish after a shutdown signal.
const SHUTDOWN_GRACE_MS = 10_000;

function main(): void {
  let config: Config;
  try {
    config = loadConfig();
  } catch (err) {
    // The logger needs the config, so this is the one place that uses console.
    console.error(err instanceof Error ? err.message : "Invalid configuration");
    process.exit(1);
  }

  const logger = createLogger(config);

  let db: Db;
  try {
    db = openDatabase(config.DATABASE_PATH);
    const applied = runMigrations(db, undefined, logger);
    if (applied.length > 0) logger.info({ applied }, "migrations applied");
  } catch (err) {
    logger.fatal({ err }, "database initialisation failed");
    process.exit(1);
  }

  const app = createApp({ config, logger, db });
  const server = app.listen(config.PORT, () => {
    logger.info(
      {
        port: config.PORT,
        env: config.NODE_ENV,
        maxUploadBytes: config.MAX_UPLOAD_BYTES,
      },
      "server listening",
    );
  });

  server.headersTimeout = HEADERS_TIMEOUT_MS;
  server.requestTimeout = REQUEST_TIMEOUT_MS;
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;

  server.on("error", (err: NodeJS.ErrnoException) => {
    logger.fatal({ err, code: err.code }, "server error");
    process.exit(1);
  });

  registerShutdown(server, db, logger);
}

function registerShutdown(
  server: ReturnType<ReturnType<typeof createApp>["listen"]>,
  db: Db,
  logger: AppLogger,
): void {
  let shuttingDown = false;

  const shutdown = (reason: string, exitCode: number): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ reason }, "shutting down");

    // If in-flight requests do not finish in time, exit anyway.
    const force = setTimeout(() => {
      logger.error("graceful shutdown timed out, forcing exit");
      process.exit(1);
    }, SHUTDOWN_GRACE_MS);
    force.unref();

    // Stop accepting new connections; the callback runs once all have ended.
    server.close((err) => {
      if (err) logger.error({ err }, "error while closing the server");
      try {
        db.close();
      } catch (closeErr) {
        logger.error({ err: closeErr }, "error while closing the database");
      }
      logger.info("shutdown complete");
      process.exit(exitCode);
    });
    // Idle keep-alive sockets would otherwise delay server.close().
    server.closeIdleConnections();
  };

  process.on("SIGTERM", () => shutdown("SIGTERM", 0));
  process.on("SIGINT", () => shutdown("SIGINT", 0));

  process.on("uncaughtException", (err) => {
    logger.fatal({ err }, "uncaught exception");
    shutdown("uncaughtException", 1);
  });
  process.on("unhandledRejection", (reason) => {
    logger.fatal({ err: reason }, "unhandled promise rejection");
    shutdown("unhandledRejection", 1);
  });
}

if (require.main === module) {
  main();
}
