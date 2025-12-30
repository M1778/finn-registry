import { createClient } from "@libsql/client";

const client = createClient({
  url: process.env.DATABASE_URL || "file:local.db",
});

async function migrate() {
  try {
    console.log("Starting dashboard migration...");
    
    // Users columns
    const columns = ["email", "name", "bio", "location", "blog"];
    for (const col of columns) {
      try {
        await client.execute(`ALTER TABLE users ADD COLUMN ${col} TEXT;`);
        console.log(`Added ${col} to users`);
      } catch (e) {
        console.log(`Column ${col} might already exist`);
      }
    }

    // Logins table
    try {
      await client.execute(`
        CREATE TABLE logins (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id),
          ip_address TEXT,
          user_agent TEXT,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
      `);
      console.log("Created logins table");
    } catch (e) {
      console.log("logins table might already exist");
    }

    // Package stats table
    try {
      await client.execute(`
        CREATE TABLE package_stats (
          id TEXT PRIMARY KEY,
          package_id TEXT NOT NULL REFERENCES packages(id),
          date TEXT NOT NULL,
          downloads INTEGER DEFAULT 0
        );
      `);
      console.log("Created package_stats table");
    } catch (e) {
      console.log("package_stats table might already exist");
    }

    console.log("Migration finished.");
    process.exit(0);
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  }
}

migrate();
