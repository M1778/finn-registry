import { getDb } from "./src/lib/db";
import { sql } from "drizzle-orm";

async function migrate() {
  const db = getDb();
  console.log("Starting migration...");
  
  const tables = [
    "logins", "api_keys", "sessions", "auth_codes", 
    "packages", "package_stats", "versions", "dependencies", 
    "organizations", "organization_members"
  ];
  
  for (const table of tables) {
    try {
      if (table === "logins" || table === "api_keys" || table === "sessions" || table === "auth_codes" || table === "organization_members") {
        await db.run(sql.raw(`ALTER TABLE ${table} ADD COLUMN user_id TEXT`));
        console.log(`Added user_id to ${table}`);
      }
      if (table === "packages") {
        await db.run(sql.raw(`ALTER TABLE packages ADD COLUMN owner_id TEXT`));
        await db.run(sql.raw(`ALTER TABLE packages ADD COLUMN organization_id TEXT`));
        console.log(`Added owner_id, organization_id to packages`);
      }
      if (table === "package_stats" || table === "versions") {
        await db.run(sql.raw(`ALTER TABLE ${table} ADD COLUMN package_id TEXT`));
        console.log(`Added package_id to ${table}`);
      }
      if (table === "dependencies") {
        await db.run(sql.raw(`ALTER TABLE dependencies ADD COLUMN version_id TEXT`));
        console.log(`Added version_id to dependencies`);
      }
      if (table === "organizations") {
        await db.run(sql.raw(`ALTER TABLE organizations ADD COLUMN owner_id TEXT`));
        console.log(`Added owner_id to organizations`);
      }
      if (table === "organization_members") {
         await db.run(sql.raw(`ALTER TABLE organization_members ADD COLUMN organization_id TEXT`));
         console.log(`Added organization_id to organization_members`);
      }
    } catch (e: any) {
      console.log(`Skipping ${table}: ${e.message}`);
    }
  }
  console.log("Migration finished.");
}

migrate().catch(console.error);
