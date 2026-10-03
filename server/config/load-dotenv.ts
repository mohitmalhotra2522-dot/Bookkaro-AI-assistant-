/** Side-effect module: imported FIRST by server/main.ts so .env values exist before any config is read. */
import { loadEnvFile } from './env-file';
loadEnvFile();
