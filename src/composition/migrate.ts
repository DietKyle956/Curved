import { runMigrations } from "../adapters/postgres/migrate.ts";
import { ServiceError } from "../domain/errors.ts";
import { loadConfig } from "./config.ts";

try {
  const applied = await runMigrations({
    databaseUrl: loadConfig().databaseUrl,
  });
  if (applied.length === 0) {
    console.log("already up to date");
  } else {
    for (const version of applied) {
      console.log(`applied ${version}`);
    }
  }
} catch (error) {
  const message =
    error instanceof ServiceError
      ? `${error.code}: ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  console.error(message);
  process.exitCode = 1;
}
