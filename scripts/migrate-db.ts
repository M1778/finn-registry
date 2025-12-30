import { getDb } from "../src/lib/db";

async function main() {
  const db = getDb();
  console.log("Migrating database...");

  try {
    // 1. Drop existing api_keys table
    console.log("Dropping old api_keys table...");
    await db.run("DROP TABLE IF EXISTS api_keys");

    // 2. Create new api_keys table with all columns
    console.log("Creating new api_keys table...");
    await db.run(`
      CREATE TABLE api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,
        description TEXT,
        key TEXT NOT NULL UNIQUE,
        scopes TEXT DEFAULT 'read,publish,delete',
        last_used_at TEXT,
        expires_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log("Migration complete!");
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  }
  process.exit(0);
}

main();