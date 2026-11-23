import { loadConfig } from "../config";
import { createLogger, type AppLogger } from "../logger";
import { openDatabase, type Db } from "./connection";
import { migrations as allMigrations, type Migration } from "./migrations";

function assertValid(list: Migration[]): void {
  list.forEach((m, i) => {
    if (m.version !== i + 1) {
      throw new Error(
        `Migrations must be numbered 1..N without gaps; found version ${m.version} at index ${i}.`,
      );
    }
  });
}

/** Apply all pending migrations. Returns the versions applied by this call. */
export function runMigrations(
  db: Db,
  list: Migration[] = allMigrations,
  logger?: AppLogger,
): number[] {
  assertValid(list);

  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ) STRICT;
  `);

  const readApplied = db.prepare("SELECT version FROM schema_migrations");
  const markApplied = db.prepare(
    "INSERT INTO schema_migrations (version, name) VALUES (?, ?)",
  );

  const applied: number[] = [];

  for (const migration of list) {
    // IMMEDIATE takes the write lock up front. The "already applied?" check runs
    // inside it, so a second process cannot apply the same migration twice.
    const apply = db.transaction(() => {
      const done = new Set(
        (readApplied.all() as { version: number }[]).map((r) => r.version),
      );
      if (done.has(migration.version)) return false;
      db.exec(migration.sql);
      markApplied.run(migration.version, migration.name);
      return true;
    });

    if (apply.immediate()) {
      applied.push(migration.version);
      logger?.info(
        { version: migration.version, name: migration.name },
        "migration applied",
      );
    }
  }

  return applied;
}

// CLI entry: `npm run migrate`
if (require.main === module) {
  const config = loadConfig();
  const logger = createLogger(config);
  const db = openDatabase(config.DATABASE_PATH);
  try {
    const applied = runMigrations(db, allMigrations, logger);
    logger.info(
      { applied },
      applied.length ? "migrations complete" : "database already up to date",
    );
  } catch (err) {
    logger.error({ err }, "migration failed");
    process.exitCode = 1;
  } finally {
    db.close();
  }
}
