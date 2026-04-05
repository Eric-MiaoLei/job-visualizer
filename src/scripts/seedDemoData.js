import { createStore } from "../store/index.js";
import { JobSyncService } from "../services/jobSyncService.js";
import { seedDemoData } from "../services/seedService.js";

async function main() {
  const store = await createStore();
  const service = new JobSyncService(store);
  const result = await seedDemoData(service);
  console.log("seed result:", result);
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
