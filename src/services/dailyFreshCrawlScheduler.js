function pad2(value) {
  return String(value).padStart(2, "0");
}

function clampInteger(value, min, max, fallback) {
  if (!Number.isFinite(value)) {
    return fallback;
  }

  return Math.min(Math.max(Math.trunc(value), min), max);
}

function buildNextRunAt(hour, minute) {
  const now = new Date();
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);

  if (next <= now) {
    next.setDate(next.getDate() + 1);
  }

  return next;
}

export class DailyFreshCrawlScheduler {
  constructor({ jobSyncService, autoCrawlService, options = {} }) {
    this.jobSyncService = jobSyncService;
    this.autoCrawlService = autoCrawlService;
    this.enabled = options.enabled !== false;
    this.hour = clampInteger(options.hour, 0, 23, 2);
    this.minute = clampInteger(options.minute, 0, 59, 0);
    this.maxDurationMs = Math.max(5000, Number(options.maxDurationMs) || 55000);
    this.concurrency = clampInteger(options.concurrency, 1, 12, 4);
    this.interChunkDelayMs = clampInteger(options.interChunkDelayMs, 0, 5000, 250);
    this.isBlocked = typeof options.isBlocked === "function" ? options.isBlocked : () => false;
    this.timer = null;
    this.state = {
      enabled: this.enabled,
      schedule: `${pad2(this.hour)}:${pad2(this.minute)}`,
      policy: {
        strategy: "round-robin-by-source",
        concurrency: this.concurrency,
        interChunkDelayMs: this.interChunkDelayMs,
        maxDurationMs: this.maxDurationMs,
        discoverNewJobs: true
      },
      running: false,
      trigger: null,
      nextRunAt: null,
      lastStartedAt: null,
      lastFinishedAt: null,
      lastResult: null,
      lastError: null,
      lastSkippedReason: null,
      progress: null
    };
  }

  getState() {
    return {
      ...this.state
    };
  }

  start() {
    if (!this.enabled) {
      this.state.nextRunAt = null;
      return;
    }

    this.scheduleNextRun();
  }

  stop() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.state.nextRunAt = null;
  }

  scheduleNextRun() {
    this.stop();

    if (!this.enabled) {
      return;
    }

    const nextRunAt = buildNextRunAt(this.hour, this.minute);
    this.state.nextRunAt = nextRunAt.toISOString();

    const delayMs = Math.max(nextRunAt.getTime() - Date.now(), 1000);
    this.timer = setTimeout(() => {
      void this.runCrawl("scheduled");
    }, delayMs);
  }

  async runCrawl(trigger = "manual") {
    if (this.state.running) {
      return {
        started: false,
        reason: "already-running",
        state: this.getState()
      };
    }

    if (this.isBlocked()) {
      this.state.lastSkippedReason = "blocked-by-other-task";
      if (this.enabled) {
        this.scheduleNextRun();
      }
      return {
        started: false,
        reason: "blocked-by-other-task",
        state: this.getState()
      };
    }

    this.state.running = true;
    this.state.trigger = trigger;
    this.state.lastStartedAt = new Date().toISOString();
    this.state.lastError = null;
    this.state.lastSkippedReason = null;
    this.state.progress = {
      stage: "starting",
      message: "Preparing daily full-site crawl..."
    };

    try {
      const manualInvalidations = await this.jobSyncService.getManualInvalidations();
      const baseJobs = await this.jobSyncService.getJobs();
      const crawlResult = await this.autoCrawlService.crawlAllSources({
        maxDurationMs: this.maxDurationMs,
        baseJobs,
        manualInvalidations,
        discoverNewJobs: true,
        verificationConcurrency: this.concurrency,
        interChunkDelayMs: this.interChunkDelayMs,
        onProgress: (progress) => {
          this.state.progress = {
            ...this.state.progress,
            ...progress
          };
        }
      });

      this.state.progress = {
        stage: "syncing",
        current: crawlResult.verified,
        total: crawlResult.scanned,
        message: "Daily crawl finished, syncing data to storage..."
      };

      const syncResult = crawlResult.skippedSync
        ? {
            skipped: true,
            reason: crawlResult.skipReason,
            totalAfterSync: (await this.jobSyncService.getJobs()).length
          }
        : await this.jobSyncService.syncJobs(
          crawlResult.jobs,
          `daily-crawl:${crawlResult.outputPath}`,
          {
            closedJobs: crawlResult.closedJobs,
            manualInvalidations,
            allowManualReopenOnVerifiedOpen: true
          }
        );

      this.state.lastFinishedAt = new Date().toISOString();
      this.state.lastResult = {
        trigger,
        inputPath: crawlResult.inputPath,
        outputPath: crawlResult.outputPath,
        scanned: crawlResult.scanned,
        processed: crawlResult.processed,
        discovered: crawlResult.discovered,
        verified: crawlResult.verified,
        retainedOnError: crawlResult.retainedOnError,
        removedClosed: crawlResult.removedClosed,
        partial: crawlResult.partial,
        skippedSync: Boolean(crawlResult.skippedSync),
        skipReason: crawlResult.skipReason || null,
        verificationConcurrency: crawlResult.verificationConcurrency,
        interChunkDelayMs: crawlResult.interChunkDelayMs,
        loadBalancingStrategy: crawlResult.loadBalancingStrategy || "round-robin-by-source",
        maxDurationMs: crawlResult.maxDurationMs,
        sync: syncResult
      };
      this.state.progress = null;

      return {
        started: true,
        result: this.state.lastResult
      };
    } catch (error) {
      this.state.lastFinishedAt = new Date().toISOString();
      this.state.lastError = error instanceof Error ? error.message : "Unknown daily crawl error";
      this.state.progress = null;
      throw error;
    } finally {
      this.state.running = false;
      if (this.enabled) {
        this.scheduleNextRun();
      }
    }
  }
}
