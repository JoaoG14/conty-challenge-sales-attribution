import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";

export function openDatabase(path = ":memory:"): DatabaseSync {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS orders (
      id TEXT PRIMARY KEY,
      total_cents INTEGER NOT NULL CHECK (total_cents > 0),
      status TEXT NOT NULL CHECK (status = 'paid'),
      coupon TEXT,
      utm_content TEXT,
      creator_id TEXT,
      attribution_source TEXT CHECK (attribution_source IN ('coupon', 'utm')),
      received_at TEXT NOT NULL
    );

    -- Sem FK: o estorno pode chegar antes do pedido.
    CREATE TABLE IF NOT EXISTS refunds (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL,
      order_id TEXT NOT NULL,
      amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
      applied_cents INTEGER CHECK (applied_cents >= 0 AND applied_cents <= amount_cents),
      received_at TEXT NOT NULL,
      applied_at TEXT,
      UNIQUE (order_id, id)
    );
  `);
  return db;
}

export function transaction<T>(db: DatabaseSync, action: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = action();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
