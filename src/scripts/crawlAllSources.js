import { createStore } from "../store/index.js";
import { AutoCrawlService } from "../services/autoCrawlServiceClean.js";
import { JobSyncService } from "../services/jobSyncService.js";

async function main() {
  const store = await createStore();
  const crawlService = new AutoCrawlService();
  const syncService = new JobSyncService(store);
  const crawlOptions = {
    maxDurationMs: Number(process.env.CRAWL_MAX_DURATION_MS || 20000),
    requestTimeoutMs: Number(process.env.CRAWL_REQUEST_TIMEOUT_MS || 2500),
    verificationConcurrency: Number(process.env.CRAWL_VERIFICATION_CONCURRENCY || 3),
    discoveryConcurrency: Number(process.env.CRAWL_DISCOVERY_CONCURRENCY || 2),
    interChunkDelayMs: Number(process.env.CRAWL_INTER_CHUNK_DELAY_MS || 100),
    discoverNewJobs: process.env.CRAWL_DISCOVER_NEW_JOBS !== "false"
  };

  const crawlResult = await crawlService.crawlAllSources(crawlOptions);
  const syncResult = await syncService.syncJobs(
    crawlResult.jobs,
    `auto-crawl:${crawlResult.outputPath}`,
    { closedJobs: crawlResult.closedJobs }
  );

  console.log(
    JSON.stringify(
      {
        ...crawlResult,
        sync: syncResult
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
