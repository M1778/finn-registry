import { createClient } from "@libsql/client";
import * as dotenv from "dotenv";

dotenv.config();

async function main() {
  const client = createClient({
    url: process.env.DATABASE_URL || "file:local.db",
  });

  console.log("Initializing database schema...");

  // Disable foreign keys temporarily for clean drop
  await client.execute("PRAGMA foreign_keys = OFF");

  const tables = [
    "dependencies", "package_stats", "versions", "packages", 
    "organization_members", "organizations", "sessions", 
    "auth_codes", "logins", "users"
  ];

  for (const table of tables) {
    try {
      await client.execute(`DROP TABLE IF EXISTS ${table}`);
      console.log(`Dropped table: ${table}`);
    } catch (e) {
      console.error(`Failed to drop table ${table}:`, e);
    }
  }

  await client.execute("PRAGMA foreign_keys = ON");

  console.log("Creating tables...");

  // Users
  await client.execute(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      github_id INTEGER UNIQUE NOT NULL,
      login TEXT NOT NULL,
      email TEXT,
      name TEXT,
      bio TEXT,
      location TEXT,
      blog TEXT,
      avatar_url TEXT,
      api_key TEXT,
      api_key_scopes TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // Sessions
  await client.execute(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token TEXT UNIQUE NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Auth Codes
  await client.execute(`
    CREATE TABLE auth_codes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      code TEXT UNIQUE NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Organizations
  await client.execute(`
    CREATE TABLE organizations (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      display_name TEXT,
      avatar_url TEXT,
      description TEXT,
      owner_id TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (owner_id) REFERENCES users(id)
    )
  `);

  // Organization Members
  await client.execute(`
    CREATE TABLE organization_members (
      id TEXT PRIMARY KEY,
      organization_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT DEFAULT 'member',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (organization_id) REFERENCES organizations(id),
      FOREIGN KEY (user_id) REFERENCES users(id)
    )
  `);

  // Packages
  await client.execute(`
    CREATE TABLE packages (
      id TEXT PRIMARY KEY,
      name TEXT UNIQUE NOT NULL,
      description TEXT,
      repo_url TEXT,
      homepage TEXT,
      owner_id TEXT NOT NULL,
      organization_id TEXT,
      downloads INTEGER DEFAULT 0,
      stars INTEGER DEFAULT 0,
      category TEXT DEFAULT 'Utilities',
      is_verified INTEGER DEFAULT 0,
      is_deprecated INTEGER DEFAULT 0,
      deprecation_message TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (owner_id) REFERENCES users(id),
      FOREIGN KEY (organization_id) REFERENCES organizations(id)
    )
  `);

  // Versions
  await client.execute(`
    CREATE TABLE versions (
      id TEXT PRIMARY KEY,
      package_id TEXT NOT NULL,
      version TEXT NOT NULL,
      readme_content TEXT,
      checksum TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (package_id) REFERENCES packages(id)
    )
  `);

  // Dependencies
  await client.execute(`
    CREATE TABLE dependencies (
      id TEXT PRIMARY KEY,
      version_id TEXT NOT NULL,
      dependency_name TEXT NOT NULL,
      version_range TEXT NOT NULL,
      FOREIGN KEY (version_id) REFERENCES versions(id)
    )
  `);

  // Package Stats
  await client.execute(`
    CREATE TABLE package_stats (
      id TEXT PRIMARY KEY,
      package_id TEXT NOT NULL,
      date TEXT NOT NULL,
      downloads INTEGER DEFAULT 0,
      FOREIGN KEY (package_id) REFERENCES packages(id)
    )
  `);

  // Logins
  await client.execute(`
    CREATE TABLE logins (
      id TEXT PRIMARY KEY,
      userId TEXT NOT NULL,
      ipAddress TEXT,
      userAgent TEXT,
      createdAt TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (userId) REFERENCES users(id)
    )
  `);

  console.log("Database initialized successfully with all tables.");
}

main().catch(console.error);
