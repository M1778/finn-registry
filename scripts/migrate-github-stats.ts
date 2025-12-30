import { createClient } from "@libsql/client";

async function migrate() {
  const client = createClient({
    url: "file:local.db",
  });

  console.log("Starting GitHub stats migration...");

  try {
    const tableInfo = await client.execute("PRAGMA table_info(users)");
    const columns = tableInfo.rows.map(row => row.name);

    if (!columns.includes('github_stars')) {
      console.log("Adding github_stars to users table...");
      await client.execute("ALTER TABLE users ADD COLUMN github_stars INTEGER DEFAULT 0");
    }

    if (!columns.includes('github_forks')) {
      console.log("Adding github_forks to users table...");
      await client.execute("ALTER TABLE users ADD COLUMN github_forks INTEGER DEFAULT 0");
    }

    if (!columns.includes('github_languages')) {
      console.log("Adding github_languages to users table...");
      await client.execute("ALTER TABLE users ADD COLUMN github_languages TEXT");
    }

    console.log("Migration completed successfully!");
  } catch (error) {
    console.error("Migration failed:", error);
  }
}

migrate();
