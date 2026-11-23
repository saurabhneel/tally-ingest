export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/**
 * Schema design (hybrid: relational for the voucher tree, JSON for diagnostics)
 *
 *   imports 1─1 import_sources            (raw bytes kept apart from metadata)
 *   imports 1─* vouchers
 *   vouchers 1─* ledger_entries 1─* bill_allocations
 *                               1─* bank_allocations
 *   vouchers 1─* inventory_entries 1─* batch_allocations
 *                                  1─* accounting_allocations
 *   rate_details belongs to exactly ONE of: ledger_entry, inventory_entry,
 *                                           accounting_allocation
 *
 * Rules applied everywhere:
 *   - Every repeated child has a `position` (0-based source order) and
 *     UNIQUE(parent_id, position). Equal values never merge; position is identity.
 *   - Money, quantities, rates and dates are TEXT, exactly as in the source.
 *     No REAL columns exist, so binary floating point cannot touch money.
 *   - Idempotency is enforced by UNIQUE(imports.content_hash), not by
 *     check-then-insert.
 */
export const migrations: Migration[] = [
  {
    version: 1,
    name: "initial_schema",
    sql: `
CREATE TABLE imports (
  id                    TEXT PRIMARY KEY,
  content_hash          TEXT NOT NULL UNIQUE
                        CHECK (length(content_hash) = 64
                               AND content_hash NOT GLOB '*[^0-9a-f]*'),
  original_filename     TEXT,
  byte_size             INTEGER NOT NULL CHECK (byte_size >= 0),
  detected_encoding     TEXT NOT NULL,
  document_type         TEXT NOT NULL
                        CHECK (document_type IN ('voucherExport', 'tallyResponse')),
  status                TEXT NOT NULL
                        CHECK (status IN ('completed', 'partial', 'failed')),
  voucher_count         INTEGER NOT NULL DEFAULT 0,
  ledger_entry_count    INTEGER NOT NULL DEFAULT 0,
  inventory_entry_count INTEGER NOT NULL DEFAULT 0,
  warning_count         INTEGER NOT NULL DEFAULT 0,
  error_count           INTEGER NOT NULL DEFAULT 0,
  warnings_json         TEXT NOT NULL DEFAULT '[]',
  errors_json           TEXT NOT NULL DEFAULT '[]',
  tally_response_json   TEXT,
  created_at            TEXT NOT NULL
                        DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE import_sources (
  import_id    TEXT PRIMARY KEY REFERENCES imports(id) ON DELETE CASCADE,
  raw_content  BLOB NOT NULL
) STRICT;

CREATE TABLE vouchers (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id          TEXT NOT NULL REFERENCES imports(id) ON DELETE CASCADE,
  voucher_index      INTEGER NOT NULL CHECK (voucher_index >= 0),
  attributes_json    TEXT NOT NULL DEFAULT '{}',
  date               TEXT,
  voucher_type       TEXT,
  voucher_number     TEXT,
  party_ledger_name  TEXT,
  narration          TEXT,
  warnings_json      TEXT NOT NULL DEFAULT '[]',
  UNIQUE (import_id, voucher_index)
) STRICT;

CREATE TABLE ledger_entries (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_id         INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  position           INTEGER NOT NULL CHECK (position >= 0),
  source_tag         TEXT NOT NULL
                     CHECK (source_tag IN ('ALLLEDGERENTRIES.LIST', 'LEDGERENTRIES.LIST')),
  ledger_name        TEXT,
  is_deemed_positive TEXT,
  amount             TEXT,
  UNIQUE (voucher_id, position)
) STRICT;

CREATE TABLE bill_allocations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_entry_id  INTEGER NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL CHECK (position >= 0),
  name             TEXT,
  bill_type        TEXT,
  amount           TEXT,
  UNIQUE (ledger_entry_id, position)
) STRICT;

CREATE TABLE bank_allocations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_entry_id  INTEGER NOT NULL REFERENCES ledger_entries(id) ON DELETE CASCADE,
  position         INTEGER NOT NULL CHECK (position >= 0),
  date             TEXT,
  name             TEXT,
  transaction_type TEXT,
  amount           TEXT,
  UNIQUE (ledger_entry_id, position)
) STRICT;

CREATE TABLE inventory_entries (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  voucher_id         INTEGER NOT NULL REFERENCES vouchers(id) ON DELETE CASCADE,
  position           INTEGER NOT NULL CHECK (position >= 0),
  source_tag         TEXT NOT NULL CHECK (source_tag IN ('ALLINVENTORYENTRIES.LIST')),
  stock_item_name    TEXT,
  is_deemed_positive TEXT,
  actual_qty         TEXT,
  billed_qty         TEXT,
  rate               TEXT,
  amount             TEXT,
  UNIQUE (voucher_id, position)
) STRICT;

CREATE TABLE batch_allocations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  inventory_entry_id  INTEGER NOT NULL REFERENCES inventory_entries(id) ON DELETE CASCADE,
  position            INTEGER NOT NULL CHECK (position >= 0),
  godown_name         TEXT,
  batch_name          TEXT,
  actual_qty          TEXT,
  billed_qty          TEXT,
  amount              TEXT,
  UNIQUE (inventory_entry_id, position)
) STRICT;

CREATE TABLE accounting_allocations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  inventory_entry_id  INTEGER NOT NULL REFERENCES inventory_entries(id) ON DELETE CASCADE,
  position            INTEGER NOT NULL CHECK (position >= 0),
  ledger_name         TEXT,
  is_deemed_positive  TEXT,
  amount              TEXT,
  UNIQUE (inventory_entry_id, position)
) STRICT;

-- A rate detail has exactly one owner. Three nullable foreign keys plus a CHECK
-- give real referential integrity and cascading deletes, which a generic
-- (owner_type, owner_id) pair cannot.
CREATE TABLE rate_details (
  id                       INTEGER PRIMARY KEY AUTOINCREMENT,
  ledger_entry_id          INTEGER REFERENCES ledger_entries(id) ON DELETE CASCADE,
  inventory_entry_id       INTEGER REFERENCES inventory_entries(id) ON DELETE CASCADE,
  accounting_allocation_id INTEGER REFERENCES accounting_allocations(id) ON DELETE CASCADE,
  position                 INTEGER NOT NULL CHECK (position >= 0),
  duty_head                TEXT,
  rate                     TEXT,
  CHECK ((ledger_entry_id IS NOT NULL)
       + (inventory_entry_id IS NOT NULL)
       + (accounting_allocation_id IS NOT NULL) = 1)
) STRICT;

CREATE UNIQUE INDEX uq_rate_details_ledger
  ON rate_details (ledger_entry_id, position) WHERE ledger_entry_id IS NOT NULL;
CREATE UNIQUE INDEX uq_rate_details_inventory
  ON rate_details (inventory_entry_id, position) WHERE inventory_entry_id IS NOT NULL;
CREATE UNIQUE INDEX uq_rate_details_accounting
  ON rate_details (accounting_allocation_id, position) WHERE accounting_allocation_id IS NOT NULL;
`,
  },
];
