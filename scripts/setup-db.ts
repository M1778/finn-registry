import { createClient } from "@libsql/client";
import { readFileSync } from "fs";

async function setup() {
  console.log("Starting database setup...");
  const client = createClient({ url: "file:local.db" });

  try {
    // 1. Drop old tables if necessary or just create new ones
    console.log("Creating tables...");
    
    await client.execute(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        github_id INTEGER UNIQUE NOT NULL,
        login TEXT NOT NULL,
        email TEXT,
        name TEXT,
        bio TEXT,
        location TEXT,
        blog TEXT,
        avatar_url TEXT,
        github_stars INTEGER DEFAULT 0,
        github_forks INTEGER DEFAULT 0,
        github_languages TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.execute(`
      CREATE TABLE IF NOT EXISTS api_keys (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        name TEXT NOT NULL,
        description TEXT,
        key TEXT UNIQUE NOT NULL,
        scopes TEXT DEFAULT 'read,publish,delete',
        last_used_at TEXT,
        expires_at TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.execute(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        token TEXT UNIQUE NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.execute(`
      CREATE TABLE IF NOT EXISTS logins (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL REFERENCES users(id),
        ip_address TEXT,
        user_agent TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Add user_id column to logins if it doesn't exist (handle legacy table)
    try {
      await client.execute(`ALTER TABLE logins ADD COLUMN user_id TEXT`);
    } catch (e) {
      // Column might already exist or table might be new
    }

    await client.execute(`
      CREATE TABLE IF NOT EXISTS packages (
        id TEXT PRIMARY KEY,
        name TEXT UNIQUE NOT NULL,
        description TEXT,
        repo_url TEXT,
        homepage TEXT,
        owner_id TEXT NOT NULL REFERENCES users(id),
        organization_id TEXT,
        downloads INTEGER DEFAULT 0,
        stars INTEGER DEFAULT 0,
        category TEXT DEFAULT 'Utilities',
        is_verified INTEGER DEFAULT 0,
        is_deprecated INTEGER DEFAULT 0,
        deprecation_message TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.execute(`
      CREATE TABLE IF NOT EXISTS versions (
        id TEXT PRIMARY KEY,
        package_id TEXT NOT NULL REFERENCES packages(id),
        version TEXT NOT NULL,
        readme_content TEXT,
        checksum TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
      )
    `);

    console.log("Database setup completed successfully.");
  } catch (err) {
    console.error("Database setup failed:", err);
    process.exit(1);
  }
}

setup();
