import fs from "fs/promises";
import path from "path";
import { SNAPSHOT_DIR } from "../config.js";

async function readSnapshot(name) {
  const raw = await fs.readFile(path.join(SNAPSHOT_DIR, name), "utf8");
  return JSON.parse(raw);
}

export async function seedDemoData(jobSyncService) {
  const existing = await jobSyncService.getJobs();
  if (existing.length > 0) {
    return { skipped: true };
  }

  const initial = await readSnapshot("initial-snapshot.json");
  const latest = await readSnapshot("latest-snapshot.json");

  await jobSyncService.syncJobs(initial.jobs, initial.name);
  const result = await jobSyncService.syncJobs(latest.jobs, latest.name);

  return { skipped: false, ...result };
}
