// Loads site/.env if present. Real environment variables win over the file.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENV_FILE = join(dirname(fileURLToPath(import.meta.url)), ".env");

try {
  process.loadEnvFile(ENV_FILE);
} catch {
  // no .env: every variable it would supply is optional
}
