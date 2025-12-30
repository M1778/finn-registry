import { createClient } from "@libsql/client";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

async function main() {
  const client = createClient({
    url: "file:local.db",
  });

  // 1. Initialize schema
  const schemaSql = `
DROP TABLE IF EXISTS versions;
DROP TABLE IF EXISTS packages;
DROP TABLE IF EXISTS users;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  github_id INTEGER UNIQUE NOT NULL,
  login TEXT NOT NULL,
  avatar_url TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE packages (
  id TEXT PRIMARY KEY,
  name TEXT UNIQUE NOT NULL,
  description TEXT,
  repo_url TEXT,
  homepage TEXT,
  owner_id TEXT NOT NULL REFERENCES users(id),
  downloads INTEGER DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE versions (
  id TEXT PRIMARY KEY,
  package_id TEXT NOT NULL REFERENCES packages(id),
  version TEXT NOT NULL,
  readme_content TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
  `;

  console.log("Initializing database schema...");
  const statements = schemaSql.split(";").filter((s) => s.trim().length > 0);
  for (const statement of statements) {
    await client.execute(statement);
  }

  // 2. Seed dummy data
  console.log("Seeding dummy data...");
  
  const userId = "user_default";
  await client.execute({
    sql: "INSERT INTO users (id, github_id, login, avatar_url) VALUES (?, ?, ?, ?)",
    args: [userId, 123456, "finn_dev", "https://github.com/identicons/finn.png"]
  });

  const packagesData = [
    { name: "http", desc: "A robust HTTP client for Finn", downloads: 1250 },
    { name: "json", desc: "Fast JSON parsing and serialization", downloads: 850 },
    { name: "auth", desc: "Security and authentication utilities", downloads: 420 },
    { name: "sqlite", desc: "Native SQLite driver for Finn", downloads: 310 },
    { name: "logger", desc: "Minimalist logging library", downloads: 150 },
  ];

  for (const pkg of packagesData) {
    const pkgId = "pkg_" + pkg.name;
    await client.execute({
      sql: "INSERT INTO packages (id, name, description, owner_id, downloads) VALUES (?, ?, ?, ?, ?)",
      args: [pkgId, pkg.name, pkg.desc, userId, pkg.downloads]
    });

    await client.execute({
      sql: "INSERT INTO versions (id, package_id, version, readme_content) VALUES (?, ?, ?, ?)",
      args: [
        "ver_" + pkg.name + "_100",
        pkgId,
        "1.0.0",
        `# ${pkg.name}\n\n${pkg.desc}\n\n## Installation\n\n\`\`\`bash\nfinn add ${pkg.name}\n\`\`\``
      ]
    });
  }

  console.log("Database initialized and seeded.");
}

main().catch(console.error);
