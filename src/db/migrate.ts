import { loadEnvFile } from "node:process";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { createDatabase } from "./client.js";

try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
}

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error("DATABASE_URL is required");
}

const database = createDatabase(databaseUrl);
try {
  await migrate(database.db, { migrationsFolder: "./drizzle" });
  console.log("control-api migrations applied");
} finally {
  await database.close();
}
