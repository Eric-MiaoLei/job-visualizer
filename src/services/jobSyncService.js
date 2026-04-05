import { buildJobKey, normalizeJob, nowIso, sortJobs } from "../utils.js";

function normalizeRuleValue(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeManualClosureReason(value) {
  const raw = String(value || "").trim();
  const normalized = raw.toLowerCase();

  if (["1", "已关闭", "closed"].includes(raw) || normalized === "closed") {
    return "已关闭";
  }

  if (["2", "已填补", "filled", "position filled"].includes(raw) || /(filled|position filled)/.test(normalized)) {
    return "已填补";
  }

  if (
    ["3", "不再空缺", "no longer hiring", "no longer open", "not open"].includes(raw) ||
    /(no longer hiring|no longer open|not open)/.test(normalized)
  ) {
    return "不再空缺";
  }

  return "已关闭";
}

function inferManualInvalidationFields(job) {
  if (String(job?.url || job?.source_url || "").trim()) {
    return ["url"];
  }

  if (String(job?.title || "").trim() && String(job?.company || "").trim() && String(job?.source || "").trim()) {
    return ["title", "company", "source"];
  }

  if (String(job?.title || "").trim() && String(job?.company || "").trim()) {
    return ["title", "company"];
  }

  return ["jobKey"];
}

function matchManualInvalidation(rule, job, jobKey) {
  if (!rule) {
    return false;
  }

  const matchedFields = Array.isArray(rule.matchedFields) && rule.matchedFields.length
    ? rule.matchedFields
    : ["jobKey"];
  const snapshot = rule.fieldSnapshot || {};

  return matchedFields.every((field) => {
    if (field === "jobKey") {
      return normalizeRuleValue(jobKey) === normalizeRuleValue(rule.jobKey);
    }

    if (field === "url") {
      return normalizeRuleValue(job.url || job.source_url) === normalizeRuleValue(snapshot.url);
    }

    if (field === "title") {
      return normalizeRuleValue(job.title) === normalizeRuleValue(snapshot.title);
    }

    if (field === "company") {
      return normalizeRuleValue(job.company) === normalizeRuleValue(snapshot.company);
    }

    if (field === "source") {
      return normalizeRuleValue(job.source) === normalizeRuleValue(snapshot.source);
    }

    return false;
  });
}

function parseSalary(salary) {
  const raw = String(salary || "");
  if (!raw || /unknown/i.test(raw)) {
    return { min: null, max: null };
  }

  const numbers = [...raw.matchAll(/\d[\d,]*/g)]
    .map((match) => Number(match[0].replace(/,/g, "")))
    .filter((value) => Number.isFinite(value));

  if (!numbers.length) {
    return { min: null, max: null };
  }

  if (numbers.length === 1) {
    return { min: numbers[0], max: numbers[0] };
  }

  const sorted = numbers.sort((a, b) => a - b);
  return {
    min: sorted[0],
    max: sorted[sorted.length - 1]
  };
}

function parseDateValue(value) {
  const raw = String(value || "").trim();
  if (!raw || /unknown/i.test(raw)) {
    return null;
  }

  const timestamp = Date.parse(raw);
  return Number.isNaN(timestamp) ? null : timestamp;
}

function stableArrayValue(value) {
  if (!Array.isArray(value)) {
    return [];
  }

  return [...value].map((item) => String(item || "").trim());
}

function getMaterialSyncSnapshot(job, overrides = {}) {
  const next = {
    ...job,
    ...overrides
  };

  return {
    title: String(next.title || ""),
    company: String(next.company || ""),
    job_family: String(next.job_family || ""),
    first_posted_at: String(next.first_posted_at || ""),
    company_size: String(next.company_size || ""),
    location: String(next.location || ""),
    work_mode: String(next.work_mode || ""),
    employment_type: String(next.employment_type || ""),
    salary: String(next.salary || ""),
    japanese_level: String(next.japanese_level || ""),
    english_level: String(next.english_level || ""),
    visa_support: String(next.visa_support || ""),
    tech_stack: String(next.tech_stack || ""),
    benefits: stableArrayValue(next.benefits),
    education_requirements: String(next.education_requirements || ""),
    experience_requirements: String(next.experience_requirements || ""),
    other_requirements: String(next.other_requirements || ""),
    summary: String(next.summary || ""),
    url: String(next.url || ""),
    source: String(next.source || ""),
    source_url: String(next.source_url || ""),
    hiring_status: String(next.hiring_status || ""),
    status_reason: String(next.status_reason || ""),
    match_score: Number(next.match_score || 0)
  };
}

function hasMaterialSyncChanges(existing, normalized, overrides = {}) {
  const before = JSON.stringify(getMaterialSyncSnapshot(existing));
  const after = JSON.stringify(getMaterialSyncSnapshot(normalized, overrides));
  return before !== after;
}

function normalizeTechStack(techStack) {
  return String(techStack || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function deriveLocationBucket(location) {
  const normalized = String(location || "").toLowerCase();

  if (/remote in japan/.test(normalized)) {
    return "Remote in Japan";
  }

  if (/remote/.test(normalized)) {
    return "Remote";
  }

  if (/tokyo/.test(normalized)) {
    return "Tokyo";
  }

  if (/osaka/.test(normalized)) {
    return "Osaka";
  }

  if (/fukuoka/.test(normalized)) {
    return "Fukuoka";
  }

  if (/kyoto/.test(normalized)) {
    return "Kyoto";
  }

  return "其他";
}

function deriveRoleFamily(job) {
  const explicitFamily = String(job.job_family || "").trim().toLowerCase();

  if (["frontend", "front-end", "fe"].includes(explicitFamily)) {
    return "前端";
  }

  if (["backend", "back-end", "be"].includes(explicitFamily)) {
    return "后端";
  }

  if (["qa", "test", "testing", "sdet"].includes(explicitFamily)) {
    return "测试 / QA";
  }

  if (["fullstack", "full-stack", "full stack"].includes(explicitFamily)) {
    return "全栈";
  }

  const title = String(job.title || "").toLowerCase();
  const summary = String(job.summary || "").toLowerCase();
  const stack = String(job.tech_stack || "").toLowerCase();
  const titleAndSummary = `${title} ${summary}`;
  const titleAndStack = `${title} ${stack}`;

  if (/(^|\b)(qa|quality assurance|sdet|test automation|test engineer|automation engineer)(\b|$)/.test(titleAndSummary) || /(playwright|cypress|selenium)/.test(titleAndStack)) {
    return "测试 / QA";
  }

  if (/full.?stack/.test(titleAndSummary)) {
    return "全栈";
  }

  if (/(frontend|front-end|web ui|react|vue|nuxt|next\.js)/.test(titleAndStack)) {
    return "前端";
  }

  if (/(backend|back-end|server-side|platform engineer|api engineer|api |golang|go,|python|java|kubernetes|postgresql|node\.js)/.test(titleAndStack)) {
    return "后端";
  }

  return "其他";
}

function enrichJob(job) {
  const salary = parseSalary(job.salary);
  const location = String(job.location || "");

  return {
    ...job,
    parsedSalaryMin: salary.min,
    parsedSalaryMax: salary.max,
    parsedFirstPostedAt: parseDateValue(job.first_posted_at || job.firstSeenAt || job.source_date),
    isRemoteFriendly: /remote/i.test(String(job.work_mode || "")) || /remote/i.test(location),
    techStackTokens: normalizeTechStack(job.tech_stack),
    locationBucket: deriveLocationBucket(location),
    roleFamily: deriveRoleFamily(job)
  };
}

export class JobSyncService {
  constructor(store) {
    this.store = store;
  }

  async getJobs() {
    return sortJobs((await this.store.getAllJobs()).map(enrichJob));
  }

  async toggleFavorite(jobKey, favorite) {
    const existing = await this.store.getJobByKey(jobKey);
    if (!existing) {
      throw new Error("Job not found");
    }

    const nextFavorite = typeof favorite === "boolean" ? favorite : !existing.isFavorite;
    const updated = await this.store.updateJob(jobKey, {
      isFavorite: nextFavorite,
      favoritedAt: nextFavorite ? nowIso() : ""
    });
    return enrichJob(updated);
  }

  async submitManualClosure(jobKey, payload = {}) {
    const existing = await this.store.getJobByKey(jobKey);
    if (!existing) {
      throw new Error("Job not found");
    }

    const matchedFields = inferManualInvalidationFields(existing);
    const reason = normalizeManualClosureReason(payload.reason);
    const evidenceText = String(payload.evidenceText || "").trim();
    const ruleKey = `${jobKey}::${[...matchedFields].sort().join("|")}`;
    const fieldSnapshot = {
      url: existing.url,
      title: existing.title,
      company: existing.company,
      source: existing.source
    };

    const rule = await this.store.upsertManualInvalidation({
      ruleKey,
      jobKey,
      matchedFields,
      fieldSnapshot,
      reason,
      evidenceText
    });

    const updated = await this.store.updateJob(jobKey, {
      hiring_status: "closed",
      status_reason: reason,
      closedAt: existing.closedAt || nowIso(),
      manuallyClosed: true,
      manualInvalidationRuleId: rule.ruleKey,
      manualInvalidationMatchedFields: matchedFields
    });

    return {
      job: enrichJob(updated),
      rule
    };
  }

  async reopenJob(jobKey) {
    const existing = await this.store.getJobByKey(jobKey);
    if (!existing) {
      throw new Error("Job not found");
    }

    if (existing.manualInvalidationRuleId) {
      await this.store.deleteManualInvalidation(existing.manualInvalidationRuleId);
    }

    const updated = await this.store.updateJob(jobKey, {
      hiring_status: "open",
      status_reason: "",
      closedAt: "",
      manuallyClosed: false,
      manualInvalidationRuleId: "",
      manualInvalidationMatchedFields: []
    });

    return enrichJob(updated);
  }

  async getManualInvalidations() {
    return this.store.getManualInvalidations();
  }

  async getDashboardData() {
    const jobs = await this.getJobs();
    const activeJobs = jobs.filter((job) => job.hiring_status !== "closed");
    const closedJobs = jobs.filter((job) => job.hiring_status === "closed");

    return {
      jobs,
      stats: {
        total: jobs.length,
        active: activeJobs.length,
        closed: closedJobs.length,
        remoteFriendly: jobs.filter((job) => job.isRemoteFriendly).length,
        withSalary: jobs.filter((job) => job.parsedSalaryMax !== null).length,
        roleFamilies: {
          frontend: jobs.filter((job) => job.roleFamily === "前端").length,
          backend: jobs.filter((job) => job.roleFamily === "后端").length,
          qa: jobs.filter((job) => job.roleFamily === "测试 / QA").length,
          fullstack: jobs.filter((job) => job.roleFamily === "全栈").length
        }
      }
    };
  }

  async syncJobs(incomingJobs, batchLabel = `manual-${Date.now()}`, options = {}) {
    const existingJobs = await this.store.getAllJobs();
    const existingMap = new Map(existingJobs.map((job) => [job.jobKey, job]));
    const timestamp = nowIso();
    const closedJobsInput = Array.isArray(options.closedJobs) ? options.closedJobs : [];
    const manualInvalidations = Array.isArray(options.manualInvalidations)
      ? options.manualInvalidations
      : await this.getManualInvalidations();
    const allowManualReopenOnVerifiedOpen = options.allowManualReopenOnVerifiedOpen === true;
    const explicitClosedByKey = new Map(
      closedJobsInput
        .map((item) => {
          const normalized = normalizeJob(item);
          const closedJobKey = buildJobKey(normalized);
          return closedJobKey ? [closedJobKey, item] : null;
        })
        .filter(Boolean)
    );

    let added = 0;
    let updated = 0;
    let removed = 0;
    let closed = 0;

    const nextMap = new Map();

    for (const rawJob of incomingJobs) {
      const normalized = normalizeJob(rawJob);
      const jobKey = buildJobKey(normalized);
      const verificationSkipped = rawJob?.verification_skipped === true;

      if (!jobKey) {
        continue;
      }

      const existing = existingMap.get(jobKey);
      const explicitlyClosed = explicitClosedByKey.get(jobKey);
      const matchedManualRule = manualInvalidations.find((rule) => matchManualInvalidation(rule, normalized, jobKey));
      const shouldPreserveManualClosure = Boolean(matchedManualRule) && !allowManualReopenOnVerifiedOpen;
      const nextHiringStatus =
        normalized.hiring_status === "closed" || explicitlyClosed || shouldPreserveManualClosure ? "closed" : "open";
      const nextStatusReason =
        explicitlyClosed?.reason ||
        matchedManualRule?.reason ||
        normalized.status_reason ||
        (nextHiringStatus === "closed" ? "Closed in latest import" : "");

      if (!existing) {
        added += 1;
        if (nextHiringStatus === "closed") {
          closed += 1;
        }
        nextMap.set(jobKey, {
          ...normalized,
          jobKey,
          hiring_status: nextHiringStatus,
          status_reason: nextStatusReason,
          closedAt: nextHiringStatus === "closed" ? timestamp : "",
          isFavorite: false,
          favoritedAt: "",
          manuallyClosed: Boolean(matchedManualRule) && !explicitlyClosed && normalized.hiring_status !== "closed",
          manualInvalidationRuleId: matchedManualRule?.ruleKey || "",
          manualInvalidationMatchedFields: matchedManualRule?.matchedFields || [],
          version: 1,
          firstSeenAt: timestamp,
          lastSeenAt: timestamp,
          lastImportBatch: batchLabel
        });
        continue;
      }

      if (
        nextHiringStatus === "open" &&
        existing.manuallyClosed &&
        existing.manualInvalidationRuleId &&
        allowManualReopenOnVerifiedOpen &&
        typeof this.store.deleteManualInvalidation === "function"
      ) {
        await this.store.deleteManualInvalidation(existing.manualInvalidationRuleId);
      }

      updated += 1;
      if (nextHiringStatus === "closed" && existing.hiring_status !== "closed") {
        closed += 1;
      }
      const materialChanged = hasMaterialSyncChanges(existing, normalized, {
        hiring_status: nextHiringStatus,
        status_reason: nextStatusReason
      });
      nextMap.set(jobKey, {
        ...existing,
        ...normalized,
        jobKey,
        hiring_status: nextHiringStatus,
        status_reason: nextStatusReason,
        closedAt: nextHiringStatus === "closed" ? (existing.closedAt || timestamp) : "",
        isFavorite: Boolean(existing.isFavorite),
        favoritedAt: existing.favoritedAt || "",
        manuallyClosed: nextHiringStatus === "closed"
          ? (shouldPreserveManualClosure ? true : Boolean(existing.manuallyClosed && !allowManualReopenOnVerifiedOpen))
          : false,
        manualInvalidationRuleId: nextHiringStatus === "closed"
          ? (shouldPreserveManualClosure ? matchedManualRule?.ruleKey || existing.manualInvalidationRuleId || "" : existing.manualInvalidationRuleId || "")
          : "",
        manualInvalidationMatchedFields: nextHiringStatus === "closed"
          ? (shouldPreserveManualClosure ? matchedManualRule?.matchedFields || existing.manualInvalidationMatchedFields || [] : existing.manualInvalidationMatchedFields || [])
          : [],
        version: materialChanged ? Number(existing.version || 1) + 1 : Number(existing.version || 1),
        firstSeenAt: existing.firstSeenAt || timestamp,
        lastSeenAt: verificationSkipped ? (existing.lastSeenAt || "") : timestamp,
        lastImportBatch: batchLabel
      });
    }

    for (const existing of existingJobs) {
      if (nextMap.has(existing.jobKey)) {
        continue;
      }

      const explicitClosed = explicitClosedByKey.get(existing.jobKey);

      if (explicitClosed) {
        removed += 1;
        if (existing.hiring_status !== "closed") {
          closed += 1;
        }

        nextMap.set(existing.jobKey, {
          ...existing,
          hiring_status: "closed",
          status_reason: explicitClosed?.reason || existing.status_reason || "Closed by explicit verification result",
          closedAt: existing.closedAt || timestamp,
          lastSeenAt: timestamp,
          lastImportBatch: batchLabel
        });
        continue;
      }

      // Preserve previously known jobs when a crawl is partial or misses a source.
      // Only explicit closure evidence should transition a job to closed.
      nextMap.set(existing.jobKey, {
        ...existing
      });
    }

    const nextJobs = sortJobs([...nextMap.values()]);
    await this.store.replaceAllJobs(nextJobs);

    return {
      added,
      updated,
      removed,
      closed,
      totalAfterSync: nextJobs.length
    };
  }
}
