import { createStore } from "../store/index.js";
import { JobSyncService } from "../services/jobSyncService.js";
import { loadJobsFromSkillOutput, resolveLatestSkillJson } from "../services/skillOutputSyncService.js";

async function main() {
  const store = await createStore();
  const service = new JobSyncService(store);
  const inputPath = await resolveLatestSkillJson();
  const jobs = await loadJobsFromSkillOutput(inputPath);
  const result = await service.syncJobs(jobs, `skill-output:${inputPath}`);

  console.log(
    JSON.stringify(
      {
        inputPath,
        ...result
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
