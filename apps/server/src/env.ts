import path from "node:path";
import { fileURLToPath } from "node:url";

/** Load the repo-root .env (if present) before other modules read process.env. */
const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../.env");
try {
  process.loadEnvFile(envPath);
} catch {
  // No .env — rely on the real environment.
}
