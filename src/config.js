import fs from "fs";
import path from "path";

export const ROOT_DIR = path.resolve(process.cwd());
export const DATA_DIR = path.join(ROOT_DIR, "data");
export const SNAPSHOT_DIR = path.join(DATA_DIR, "snapshots");
export const STORAGE_DIR = path.join(DATA_DIR, "storage");
export const SKILL_OUTPUT_ROOT = path.join(
  ROOT_DIR,
  "..",
  "skills",
  "jphr",
  "outputs",
  "japan-frontend-jobs"
);

const envPath = path.join(ROOT_DIR, ".env");

if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separatorIndex = trimmed.indexOf("=");
    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();

    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

export const config = {
  port: Number(process.env.PORT || 3000),
  storeMode: process.env.STORE_MODE || "file",
  mongodbUri: process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/jphr_jobs",
  autoSeed: process.env.AUTO_SEED !== "false",
  skillOutputRoot: process.env.SKILL_OUTPUT_ROOT || SKILL_OUTPUT_ROOT,
  dailyCrawlEnabled: process.env.DAILY_CRAWL_ENABLED !== "false",
  dailyCrawlHour: Number(process.env.DAILY_CRAWL_HOUR || 2),
  dailyCrawlMinute: Number(process.env.DAILY_CRAWL_MINUTE || 0),
  dailyCrawlMaxDurationMs: Number(process.env.DAILY_CRAWL_MAX_DURATION_MS || 55000),
  dailyCrawlConcurrency: Number(process.env.DAILY_CRAWL_CONCURRENCY || 4),
  dailyCrawlInterChunkDelayMs: Number(process.env.DAILY_CRAWL_INTER_CHUNK_DELAY_MS || 250),
  dailyValidationEnabled: process.env.DAILY_VALIDATION_ENABLED !== "false",
  dailyValidationHour: Number(process.env.DAILY_VALIDATION_HOUR || 3),
  dailyValidationMinute: Number(process.env.DAILY_VALIDATION_MINUTE || 0),
  dailyValidationMaxDurationMs: Number(process.env.DAILY_VALIDATION_MAX_DURATION_MS || 55000),
  dailyValidationConcurrency: Number(process.env.DAILY_VALIDATION_CONCURRENCY || 4),
  dailyValidationInterChunkDelayMs: Number(process.env.DAILY_VALIDATION_INTER_CHUNK_DELAY_MS || 250)
};
