import express from "express";
import path from "path";
import { fileURLToPath } from "url";
import { config } from "./config.js";
import { AutoCrawlService } from "./services/autoCrawlServiceClean.js";
import { DailyFreshCrawlScheduler } from "./services/dailyFreshCrawlScheduler.js";
import { DailyValidationScheduler } from "./services/dailyValidationScheduler.js";
import { seedDemoData } from "./services/seedService.js";
import { JobSyncService } from "./services/jobSyncService.js";
import { loadJobsFromSkillOutput, resolveLatestSkillJson } from "./services/skillOutputSyncService.js";
import { createStore } from "./store/index.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function asyncHandler(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}

async function main() {
  const store = await createStore();
  const jobSyncService = new JobSyncService(store);
  const autoCrawlService = new AutoCrawlService();
  let crawlStatus = {
    state: "idle",
    startedAt: null,
    finishedAt: null,
    summary: null,
    error: null,
    progress: null
  };
  let dailyFreshCrawlScheduler;
  const dailyValidationScheduler = new DailyValidationScheduler({
    jobSyncService,
    autoCrawlService,
    options: {
      enabled: config.dailyValidationEnabled,
      hour: config.dailyValidationHour,
      minute: config.dailyValidationMinute,
      maxDurationMs: config.dailyValidationMaxDurationMs,
      concurrency: config.dailyValidationConcurrency,
      interChunkDelayMs: config.dailyValidationInterChunkDelayMs,
      isBlocked: () => crawlStatus.state === "running" || dailyFreshCrawlScheduler?.getState().running
    }
  });
  dailyFreshCrawlScheduler = new DailyFreshCrawlScheduler({
    jobSyncService,
    autoCrawlService,
    options: {
      enabled: config.dailyCrawlEnabled,
      hour: config.dailyCrawlHour,
      minute: config.dailyCrawlMinute,
      maxDurationMs: config.dailyCrawlMaxDurationMs,
      concurrency: config.dailyCrawlConcurrency,
      interChunkDelayMs: config.dailyCrawlInterChunkDelayMs,
      isBlocked: () => crawlStatus.state === "running" || dailyValidationScheduler.getState().running
    }
  });

  if (config.autoSeed) {
    await seedDemoData(jobSyncService);
  }

  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, "../public")));

  app.get("/api/dashboard", asyncHandler(async (_req, res) => {
    const payload = await jobSyncService.getDashboardData();
    res.json(payload);
  }));

  app.get("/api/jobs", asyncHandler(async (_req, res) => {
    const jobs = await jobSyncService.getJobs();
    res.json(jobs);
  }));

  app.get("/api/validation/status", (_req, res) => {
    res.json(dailyValidationScheduler.getState());
  });

  app.get("/api/discovery/status", (_req, res) => {
    res.json(dailyFreshCrawlScheduler.getState());
  });

  app.post("/api/jobs/favorite", asyncHandler(async (req, res) => {
    const jobKey = String(req.body?.jobKey || "").trim().toLowerCase();
    if (!jobKey) {
      throw new Error("jobKey is required");
    }

    const job = await jobSyncService.toggleFavorite(jobKey, req.body?.favorite);
    res.json({ job });
  }));

  app.post("/api/jobs/manual-close", asyncHandler(async (req, res) => {
    const jobKey = String(req.body?.jobKey || "").trim().toLowerCase();
    if (!jobKey) {
      throw new Error("jobKey is required");
    }

    const result = await jobSyncService.submitManualClosure(jobKey, {
      matchedFields: req.body?.matchedFields,
      reason: req.body?.reason,
      evidenceText: req.body?.evidenceText
    });
    res.json(result);
  }));

  app.post("/api/jobs/reopen", asyncHandler(async (req, res) => {
    const jobKey = String(req.body?.jobKey || "").trim().toLowerCase();
    if (!jobKey) {
      throw new Error("jobKey is required");
    }

    const job = await jobSyncService.reopenJob(jobKey);
    res.json({ job });
  }));

  app.post("/api/sync", asyncHandler(async (req, res) => {
    const jobs = Array.isArray(req.body.jobs) ? req.body.jobs : [];
    const batchLabel = req.body.batchLabel || `api-${Date.now()}`;
    const result = await jobSyncService.syncJobs(jobs, batchLabel);
    res.json(result);
  }));

  app.post("/api/sync/latest", asyncHandler(async (_req, res) => {
    const inputPath = await resolveLatestSkillJson();
    const jobs = await loadJobsFromSkillOutput(inputPath);
    const result = await jobSyncService.syncJobs(jobs, `skill-output:${inputPath}`);
    res.json({
      inputPath,
      ...result
    });
  }));

  app.get("/api/crawl/status", (_req, res) => {
    const normalizedStatus =
      crawlStatus?.state === "error" &&
      /Missing canonical jobs\.json in latest output directory/i.test(String(crawlStatus.error || ""))
        ? {
            ...crawlStatus,
            error:
              "The running server process is still holding an old crawl error. Restart the job-visualizer server so it can use the new fallback that selects the latest dated directory containing a canonical jobs.json."
          }
        : crawlStatus;

    res.json(normalizedStatus);
  });

  app.post("/api/crawl/all", asyncHandler(async (req, res) => {
    if (crawlStatus.state === "running") {
      res.status(202).json({
        started: false,
        status: crawlStatus
      });
      return;
    }

    crawlStatus = {
      state: "running",
      startedAt: new Date().toISOString(),
      finishedAt: null,
      summary: null,
      error: null,
      progress: {
        stage: "starting",
        current: 0,
        total: 0,
        message: "Starting full-site crawl..."
      }
    };

    void (async () => {
      try {
        const manualInvalidations = await jobSyncService.getManualInvalidations();
        const baseJobs = await jobSyncService.getJobs();
        const crawlResult = await autoCrawlService.crawlAllSources({
          maxDurationMs: Number(req.body?.maxDurationMs) || config.dailyCrawlMaxDurationMs,
          baseJobs,
          manualInvalidations,
          verificationConcurrency: Number(req.body?.verificationConcurrency) || config.dailyCrawlConcurrency,
          interChunkDelayMs: Number(req.body?.interChunkDelayMs) || config.dailyCrawlInterChunkDelayMs,
          onProgress(progress) {
            crawlStatus = {
              ...crawlStatus,
              progress: {
                ...crawlStatus.progress,
                ...progress
              }
            };
          }
        });

        crawlStatus = {
          ...crawlStatus,
          progress: {
            stage: "syncing",
            current: crawlResult.verified,
            total: crawlResult.scanned,
            discovered: crawlResult.discovered,
            retainedOnError: crawlResult.retainedOnError,
            removedClosed: crawlResult.removedClosed,
            message: "Crawl data refreshed, syncing to MongoDB..."
          }
        };

        const syncResult = crawlResult.skippedSync
          ? {
              skipped: true,
              reason: crawlResult.skipReason,
              totalAfterSync: (await jobSyncService.getJobs()).length
            }
          : await jobSyncService.syncJobs(
            crawlResult.jobs,
            `auto-crawl:${crawlResult.outputPath}`,
            {
              closedJobs: crawlResult.closedJobs,
              manualInvalidations,
              allowManualReopenOnVerifiedOpen: true
            }
          );

        const discoveredCandidates = Number(crawlResult.discovered || 0);
        const insertedIntoDatabase = Number(syncResult?.added || 0);
        const updatedExistingJobs = Number(syncResult?.updated || 0);
        const closedBeforeSync = Number(crawlResult.closedJobs?.length || 0);
        const failedBeforeSync = Number(crawlResult.failedJobs?.length || 0);
        const skippedByBudget = Math.max(
          Number(crawlResult.scanned || 0) - Number(crawlResult.processed || 0),
          0
        );
        const unresolvedDiscovered = Math.max(
          discoveredCandidates - insertedIntoDatabase - closedBeforeSync - failedBeforeSync,
          0
        );

        crawlStatus = {
          state: "completed",
          startedAt: crawlStatus.startedAt,
          finishedAt: new Date().toISOString(),
          error: null,
          progress: null,
          summary: {
            inputPath: crawlResult.inputPath,
            outputPath: crawlResult.outputPath,
            scanned: crawlResult.scanned,
            discovered: crawlResult.discovered,
            discoverySourceStats: crawlResult.discoverySourceStats || {},
            verified: crawlResult.verified,
            processed: crawlResult.processed,
            retainedOnError: crawlResult.retainedOnError,
            removedClosed: crawlResult.removedClosed,
            closedCount: crawlResult.closedJobs.length,
            failedCount: crawlResult.failedJobs.length,
            ingestBreakdown: {
              discoveredCandidates,
              insertedIntoDatabase,
              updatedExistingJobs,
              closedBeforeSync,
              failedBeforeSync,
              skippedByBudget,
              unresolvedDiscovered
            },
            partial: crawlResult.partial,
            skippedSync: Boolean(crawlResult.skippedSync),
            skipReason: crawlResult.skipReason || null,
            maxDurationMs: crawlResult.maxDurationMs,
            sync: syncResult
          }
        };
      } catch (error) {
        crawlStatus = {
          state: "error",
          startedAt: crawlStatus.startedAt,
          finishedAt: new Date().toISOString(),
          summary: null,
          error: error instanceof Error ? error.message : "Unknown crawl error",
          progress: null
        };
      }
    })();

    res.status(202).json({
      started: true,
      status: crawlStatus
    });
  }));

  app.use((error, req, res, next) => {
    if (res.headersSent) {
      next(error);
      return;
    }

    const message = error instanceof Error ? error.message : "Unknown server error";
    const statusCode = /Missing canonical jobs\.json|No dated skill output directories/i.test(message)
      ? 404
      : /Unsupported jobs payload|must be a jobs array|Unexpected token/i.test(message)
        ? 400
        : 500;

    if (req.path.startsWith("/api/")) {
      res.status(statusCode).json({ error: message });
      return;
    }

    res.status(statusCode).send(message);
  });

  app.get("*", (_req, res) => {
    res.sendFile(path.join(__dirname, "../public/index.html"));
  });

  app.listen(config.port, () => {
    dailyFreshCrawlScheduler.start();
    dailyValidationScheduler.start();
    console.log(`Job visualizer running at http://localhost:${config.port}`);
    console.log(`Store mode: ${config.storeMode}`);
    console.log(
      `Daily crawl: ${config.dailyCrawlEnabled ? `enabled at ${String(config.dailyCrawlHour).padStart(2, "0")}:${String(config.dailyCrawlMinute).padStart(2, "0")} with concurrency ${config.dailyCrawlConcurrency} and ${config.dailyCrawlInterChunkDelayMs}ms pacing` : "disabled"}`
    );
    console.log(
      `Daily validation: ${config.dailyValidationEnabled ? `enabled at ${String(config.dailyValidationHour).padStart(2, "0")}:${String(config.dailyValidationMinute).padStart(2, "0")} with concurrency ${config.dailyValidationConcurrency} and ${config.dailyValidationInterChunkDelayMs}ms pacing` : "disabled"}`
    );
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

