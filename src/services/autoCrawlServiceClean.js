import http from "http";
import https from "https";
import { URL } from "url";
import {
  loadSkillReport,
  resolveLatestSkillJson,
  resolveLatestSkillOutputDir,
  writeCanonicalSkillReport
} from "./skillOutputSyncService.js";

const DEFAULT_TIMEOUT_MS = 2500;
const DEFAULT_CRAWL_BUDGET_MS = 20000;
const DEFAULT_VERIFICATION_CONCURRENCY = 3;
const DEFAULT_DISCOVERY_CONCURRENCY = 2;
const DEFAULT_INTER_CHUNK_DELAY_MS = 100;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 JPHRJobCrawler/3.0";

const CLOSED_REGEXES = [
  /this job is no longer available/i,
  /this position is closed and is no longer accepting applications/i,
  /this (job|role|position) is closed/i,
  /no longer available/i,
  /no longer accepting applications/i,
  /applications? (have been )?closed/i,
  /position filled/i,
  /role (has been )?filled/i,
  /vacancy filled/i,
  /\u52df\u96c6\u7d42\u4e86/i,
  /\u63b2\u8f09\u7d42\u4e86/i,
  /\u5fdc\u52df\u7d42\u4e86/i,
  /\u53d7\u4ed8\u7d42\u4e86/i,
  /\u5fdc\u52df\u53d7\u4ed8\u3092\u7d42\u4e86/i,
  /\u5fdc\u52df\u53d7\u4ed8\u7d42\u4e86/i,
  /\u73fe\u5728\u52df\u96c6\u3057\u3066\u304a\u308a\u307e\u305b\u3093/i,
  /\u3053\u306e\u6c42\u4eba\u306e\u52df\u96c6\u306f\u7d42\u4e86\u3057\u3066\u3044\u307e\u3059/i,
  /\u5145\u8db3/i
];

const OPEN_REGEXES = [
  /accepting applications/i,
  /currently hiring/i,
  /apply now/i,
  /open role/i,
  /\u52df\u96c6\u4e2d/i,
  /\u63a1\u7528\u4e2d/i,
  /\u5fdc\u52df\u53d7\u4ed8\u4e2d/i,
  /\u30a8\u30f3\u30c8\u30ea\u30fc\u53d7\u4ed8\u4e2d/i,
  /\u7a4d\u6975\u63a1\u7528\u4e2d/i
];

const ROLE_PATTERNS = {
  qa: [
    /qa/i,
    /quality assurance/i,
    /sdet/i,
    /test engineer/i,
    /tester/i,
    /\u54c1\u8cea\u4fdd\u8a3c/i,
    /qa\u30a8\u30f3\u30b8\u30cb\u30a2/i,
    /\u30c6\u30b9\u30c8\u30a8\u30f3\u30b8\u30cb\u30a2/i,
    /\u81ea\u52d5\u30c6\u30b9\u30c8/i
  ],
  backend: [
    /backend/i,
    /back-end/i,
    /server-side/i,
    /server side/i,
    /platform engineer/i,
    /api engineer/i,
    /\u30d0\u30c3\u30af\u30a8\u30f3\u30c9/i,
    /\u30b5\u30fc\u30d0\u30fc\u30b5\u30a4\u30c9/i,
    /\u57fa\u76e4/i
  ],
  frontend: [
    /frontend/i,
    /front-end/i,
    /front end/i,
    /ui engineer/i,
    /react engineer/i,
    /\u30d5\u30ed\u30f3\u30c8\u30a8\u30f3\u30c9/i,
    /\u30d5\u30ed\u30f3\u30c8\u30a8\u30f3\u30c9\u30a8\u30f3\u30b8\u30cb\u30a2/i,
    /web\u30a8\u30f3\u30b8\u30cb\u30a2/i
  ]
};

const SOURCE_OPEN_HINTS = {
  Wantedly: [
    "\u8a71\u3092\u805e\u304d\u306b\u884c\u304d\u305f\u3044",
    "\u307e\u305a\u306f\u8a71\u3092\u805e\u3044\u3066\u307f\u305f\u3044",
    "\u4eca\u3059\u3050\u4e00\u7dd2\u306b\u50cd\u304f"
  ],
  Green: [
    "\u3053\u306e\u6c42\u4eba\u306b\u5fdc\u52df",
    "\u5fdc\u52df\u30d5\u30a9\u30fc\u30e0\u3078",
    "\u8a71\u3092\u805e\u3044\u3066\u307f\u305f\u3044"
  ],
  "Forkwell Jobs": [
    "\u5fdc\u52df\u3059\u308b",
    "\u3053\u306e\u6c42\u4eba\u306b\u5fdc\u52df",
    "\u30ab\u30b8\u30e5\u30a2\u30eb\u9762\u8ac7"
  ],
  TokyoDev: ["apply now", "get this job"],
  JapanDev: ["apply now", "view job", "job details"]
};

function withPageQuery(baseUrl, page) {
  return `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}page=${page}`;
}

const DISCOVERY_SOURCES = [
  {
    source: "TokyoDev",
    listingUrls: ["https://www.tokyodev.com/jobs", withPageQuery("https://www.tokyodev.com/jobs", 2)],
    detailPattern: /^https:\/\/www\.tokyodev\.com\/companies\/[^/]+\/jobs\/[^/?#]+/i,
    maxCandidates: 4
  },
  {
    source: "JapanDev",
    listingUrls: [
      "https://japan-dev.com/jobs",
      "https://japan-dev.com/front-end-jobs-in-japan",
      "https://japan-dev.com/backend-jobs-in-japan",
      "https://japan-dev.com/qa-jobs-in-japan"
    ],
    detailPattern: /^https:\/\/japan-dev\.com\/jobs\/[^?#]+/i,
    maxCandidates: 6
  },
  {
    source: "Wantedly",
    listingUrls: ["https://www.wantedly.com/projects", withPageQuery("https://www.wantedly.com/projects", 2)],
    detailPattern: /^https:\/\/www\.wantedly\.com\/projects\/\d+/i,
    maxCandidates: 4
  },
  {
    source: "Forkwell Jobs",
    listingUrls: [
      "https://jobs.forkwell.com/jobs",
      "https://jobs.forkwell.com/professions/front-end-engineer",
      "https://jobs.forkwell.com/professions/server-side-engineer",
      "https://jobs.forkwell.com/professions/qa-engineer"
    ],
    detailPattern: /^https:\/\/jobs\.forkwell\.com\/[^/]+\/jobs\/\d+/i,
    maxCandidates: 6
  },
  {
    source: "Green",
    listingUrls: [
      "https://www.green-japan.com/jobtype-l/190101",
      "https://www.green-japan.com/jobtype-l/190100",
      "https://www.green-japan.com/jobtype-l/190220"
    ],
    detailPattern: /^https:\/\/www\.green-japan\.com\/company\/\d+\/job\/\d+/i,
    maxCandidates: 4
  }
];

const DETAIL_PATTERN_BY_SOURCE = new Map(DISCOVERY_SOURCES.map((item) => [item.source, item.detailPattern]));

function nowDateText() {
  return new Date().toISOString().slice(0, 10);
}

function decodeHtmlEntities(value) {
  return String(value || "")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&nbsp;", " ")
    .trim();
}

function extractMetaContent(html, pattern) {
  const match = html.match(pattern);
  return match ? decodeHtmlEntities(match[1]) : "";
}

function extractTitleFromHtml(html) {
  return (
    extractMetaContent(html, /<meta\s+property=["']og:title["']\s+content=["']([^"']+)["']/i) ||
    extractMetaContent(html, /<meta\s+name=["']twitter:title["']\s+content=["']([^"']+)["']/i) ||
    extractMetaContent(html, /<title>([^<]+)<\/title>/i)
  );
}

function extractDescriptionFromHtml(html) {
  return (
    extractMetaContent(html, /<meta\s+property=["']og:description["']\s+content=["']([^"']+)["']/i) ||
    extractMetaContent(html, /<meta\s+name=["']description["']\s+content=["']([^"']+)["']/i)
  );
}

function normalizePageText(html) {
  return decodeHtmlEntities(String(html || ""))
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function hasBudgetRemaining(deadline) {
  return !deadline || Date.now() < deadline;
}

function getBudgetMessage(deadline) {
  if (!deadline) {
    return "";
  }

  const remainingMs = Math.max(deadline - Date.now(), 0);
  return `about ${Math.ceil(remainingMs / 1000)}s left`;
}

function shouldRetainOnHttpError(status) {
  return [401, 403, 408, 429, 500, 502, 503, 504].includes(status);
}

function sleep(ms) {
  if (!ms || ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function mapWithConcurrency(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function runWorker() {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex], currentIndex);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => runWorker()));
  return results;
}

function requestUrl(targetUrl, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(targetUrl);
    const transport = parsed.protocol === "https:" ? https : http;
    const request = transport.request(
      parsed,
      {
        method: "GET",
        headers: {
          "user-agent": USER_AGENT,
          accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "accept-language": "ja,en-US;q=0.9,en;q=0.8"
        }
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolve({
            status: response.statusCode || 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8")
          });
        });
      }
    );

    request.setTimeout(timeoutMs, () => request.destroy(new Error("Request timed out")));
    request.on("error", reject);
    request.end();
  });
}

async function fetchWithTimeout(targetUrl, timeoutMs = DEFAULT_TIMEOUT_MS, redirectCount = 0) {
  if (redirectCount > 5) {
    throw new Error("Too many redirects");
  }

  const response = await requestUrl(targetUrl, timeoutMs);
  const location = response.headers.location;

  if (location && [301, 302, 303, 307, 308].includes(response.status)) {
    const nextUrl = new URL(location, targetUrl).toString();
    return fetchWithTimeout(nextUrl, timeoutMs, redirectCount + 1);
  }

  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    url: targetUrl,
    text: async () => response.body
  };
}

function extractResolvedLinks(html, pageUrl) {
  const links = [];
  const hrefPattern = /href=["']([^"'#]+)["']/gi;
  let match;

  while ((match = hrefPattern.exec(html)) !== null) {
    try {
      links.push(new URL(match[1], pageUrl).toString());
    } catch {
      // Ignore malformed links.
    }
  }

  return links;
}

function hasStrongOpenSignal(job, haystack) {
  const sourceKey = String(job?.source || "").trim();
  const signals = SOURCE_OPEN_HINTS[sourceKey] || [];
  const normalized = haystack.toLowerCase();
  return signals.some((signal) => normalized.includes(String(signal).toLowerCase()));
}

function wasRedirectedAwayFromDetail(job, finalUrl) {
  const sourceKey = String(job?.source || "").trim();
  const detailPattern = DETAIL_PATTERN_BY_SOURCE.get(sourceKey);
  const originalUrl = String(job?.source_url || job?.url || "").trim();
  const resolvedFinalUrl = String(finalUrl || "").trim();

  if (!detailPattern || !originalUrl || !resolvedFinalUrl || originalUrl === resolvedFinalUrl) {
    return false;
  }

  return detailPattern.test(originalUrl) && !detailPattern.test(resolvedFinalUrl);
}

function hasClosedMarkerInHtml(html) {
  return CLOSED_REGEXES.some((pattern) => pattern.test(String(html || "")));
}

function looksClosed(job, response, pageText, html) {
  if (!response.ok && !shouldRetainOnHttpError(response.status)) {
    return true;
  }

  const combinedText = `${pageText} ${response.url}`;
  const closed = CLOSED_REGEXES.some((pattern) => pattern.test(combinedText));
  const open = OPEN_REGEXES.some((pattern) => pattern.test(combinedText)) || hasStrongOpenSignal(job, combinedText);

  if (hasClosedMarkerInHtml(html)) {
    return true;
  }

  if (closed && !open) {
    return true;
  }

  if (wasRedirectedAwayFromDetail(job, response.url)) {
    return true;
  }

  return false;
}

function inferJobFamily(text) {
  const haystack = String(text || "");

  if (ROLE_PATTERNS.qa.some((pattern) => pattern.test(haystack))) {
    return "qa";
  }

  if (ROLE_PATTERNS.backend.some((pattern) => pattern.test(haystack))) {
    return "backend";
  }

  if (ROLE_PATTERNS.frontend.some((pattern) => pattern.test(haystack))) {
    return "frontend";
  }

  return null;
}

function looksRelevantRole(text) {
  return inferJobFamily(text) !== null;
}

function inferEmploymentType(text) {
  const haystack = String(text || "");
  if (/intern/i.test(haystack) || /\u30a4\u30f3\u30bf\u30fc\u30f3/.test(haystack)) {
    return "Internship";
  }
  if (/contract/i.test(haystack) || /\u696d\u52d9\u59d4\u8a17/.test(haystack)) {
    return "Contract";
  }
  return "Full-time";
}

function fallbackCompanyFromUrl(jobUrl) {
  try {
    const parsed = new URL(jobUrl);
    const segments = parsed.pathname.split("/").filter(Boolean);

    if (parsed.hostname === "japan-dev.com" && segments[0] === "jobs" && segments[1]) {
      return segments[1]
        .split("-")
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join(" ");
    }

    if (parsed.hostname === "jobs.forkwell.com" && segments[0]) {
      return segments[0];
    }
  } catch {
    // Ignore malformed URLs.
  }

  return "Unknown";
}

function extractCompanyFromTitle(title, source, jobUrl) {
  const rawTitle = String(title || "");
  const patternsBySource = {
    TokyoDev: [/ at (.+?) \| TokyoDev/i, / - (.+?) \| TokyoDev/i],
    JapanDev: [/ at (.+?) in Japan/i, / - (.+?) \| Japan Dev/i],
    Wantedly: [/ - (.+?) - Wantedly/i],
    "Forkwell Jobs": [/ - (.+?) - Forkwell Jobs/i],
    Green: [/ - (.+?) - Green/i]
  };

  const patterns = patternsBySource[source] || [];
  for (const pattern of patterns) {
    const match = rawTitle.match(pattern);
    if (match?.[1]) {
      return decodeHtmlEntities(match[1]).trim();
    }
  }

  return fallbackCompanyFromUrl(jobUrl);
}

function buildDiscoveredJob(detailUrl, source, html) {
  const title = extractTitleFromHtml(html) || "Unknown";
  const description = extractDescriptionFromHtml(html);
  const combined = `${title} ${description}`;
  const jobFamily = inferJobFamily(combined);

  if (!looksRelevantRole(combined) || !jobFamily) {
    return null;
  }

  return {
    title,
    company: extractCompanyFromTitle(title, source, detailUrl),
    location: "Unknown",
    work_mode: "Unknown",
    employment_type: inferEmploymentType(combined),
    salary: "Unknown",
    japanese_level: "Unknown",
    english_level: "Unknown",
    visa_support: "Unknown",
    tech_stack: "Unknown",
    company_size: "Unknown",
    benefits: [],
    education_requirements: "Unknown",
    experience_requirements: "Unknown",
    other_requirements: "Unknown",
    summary: description || `Auto-discovered from ${source}.`,
    url: detailUrl,
    source,
    source_url: detailUrl,
    source_date: nowDateText(),
    first_posted_at: nowDateText(),
    job_family: jobFamily,
    match_score: 6.5,
    notes: `Auto-discovered from ${source} listing pages on ${nowDateText()}.`
  };
}

function sanitizeBaseJob(job) {
  return {
    title: job?.title || "",
    company: job?.company || "",
    job_family: job?.job_family || "",
    first_posted_at: job?.first_posted_at || "",
    company_size: job?.company_size || "",
    location: job?.location || "",
    work_mode: job?.work_mode || "",
    employment_type: job?.employment_type || "",
    salary: job?.salary || "",
    japanese_level: job?.japanese_level || "",
    english_level: job?.english_level || "",
    visa_support: job?.visa_support || "",
    tech_stack: job?.tech_stack || "",
    benefits: Array.isArray(job?.benefits) ? [...job.benefits] : [],
    education_requirements: job?.education_requirements || "",
    experience_requirements: job?.experience_requirements || "",
    other_requirements: job?.other_requirements || "",
    summary: job?.summary || "",
    url: job?.url || "",
    source: job?.source || "",
    source_url: job?.source_url || job?.url || "",
    source_date: job?.source_date || "",
    hiring_status: job?.hiring_status || "",
    status_reason: job?.status_reason || "",
    match_score: Number(job?.match_score || 0),
    notes: job?.notes || "",
    lastSeenAt: job?.lastSeenAt || "",
    firstSeenAt: job?.firstSeenAt || ""
  };
}

function stripTransientCrawlFields(job) {
  const { verification_skipped, ...rest } = job || {};
  return rest;
}

function getVerificationPriority(job) {
  const timestamp =
    Date.parse(String(job?.lastSeenAt || "").trim()) ||
    Date.parse(String(job?.firstSeenAt || "").trim()) ||
    Date.parse(String(job?.source_date || "").trim()) ||
    0;

  return Number.isFinite(timestamp) ? timestamp : 0;
}

function balanceJobsBySource(jobs) {
  const queues = new Map();

  for (const job of jobs) {
    const sourceKey = String(job?.source || "Unknown").trim() || "Unknown";
    if (!queues.has(sourceKey)) {
      queues.set(sourceKey, []);
    }
    queues.get(sourceKey).push(job);
  }

  for (const queue of queues.values()) {
    queue.sort((left, right) => getVerificationPriority(left) - getVerificationPriority(right));
  }

  const sourceKeys = [...queues.keys()];
  const balancedJobs = [];

  while (sourceKeys.some((sourceKey) => (queues.get(sourceKey)?.length || 0) > 0)) {
    for (const sourceKey of sourceKeys) {
      const queue = queues.get(sourceKey);
      if (!queue?.length) {
        continue;
      }
      balancedJobs.push(queue.shift());
    }
  }

  return balancedJobs;
}

function normalizeRuleValue(value) {
  return String(value || "").trim().toLowerCase();
}

function matchesManualInvalidation(rule, job) {
  if (!rule) {
    return false;
  }

  const matchedFields = Array.isArray(rule.matchedFields) && rule.matchedFields.length
    ? rule.matchedFields
    : ["jobKey"];
  const snapshot = rule.fieldSnapshot || {};
  const jobKey = normalizeRuleValue(job.url || job.source_url || "");

  return matchedFields.every((field) => {
    if (field === "jobKey" || field === "url") {
      return jobKey === normalizeRuleValue(rule.jobKey || snapshot.url);
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

async function processDiscoveredDetailPage(sourceConfig, link, requestTimeoutMs) {
  try {
    const detailResponse = await fetchWithTimeout(link, requestTimeoutMs);
    if (!detailResponse.ok && shouldRetainOnHttpError(detailResponse.status)) {
      return {
        type: "log",
        payload: {
          source: sourceConfig.source,
          listingUrl: link,
          reason: `Detail HTTP ${detailResponse.status}`
        }
      };
    }

    const detailHtml = await detailResponse.text();
    const pageText = normalizePageText(detailHtml);
    if (looksClosed({ source: sourceConfig.source, url: link, source_url: link }, detailResponse, pageText, detailHtml)) {
      return null;
    }

    const discoveredJob = buildDiscoveredJob(link, sourceConfig.source, detailHtml);
    if (!discoveredJob) {
      return null;
    }

    return {
      type: "job",
      payload: discoveredJob
    };
  } catch (error) {
    return {
      type: "log",
      payload: {
        source: sourceConfig.source,
        listingUrl: link,
        reason: error instanceof Error ? error.message : "Unknown detail discovery error"
      }
    };
  }
}

function createDiscoverySourceStats() {
  return Object.fromEntries(
    DISCOVERY_SOURCES.map((sourceConfig) => [
      sourceConfig.source,
      {
        listingPagesScanned: 0,
        detailPagesScanned: 0,
        discovered: 0,
        errors: 0
      }
    ])
  );
}

async function discoverCandidateJobs(existingJobs, onProgress = () => {}, deadline = null, options = {}) {
  const existingUrls = new Set(existingJobs.map((job) => String(job.url || "").trim().toLowerCase()));
  const discoveredJobs = [];
  const discoveredUrls = new Set();
  const discoveryLog = [];
  const discoveryConcurrency = options.discoveryConcurrency || DEFAULT_DISCOVERY_CONCURRENCY;
  const requestTimeoutMs = options.requestTimeoutMs || DEFAULT_TIMEOUT_MS;
  const sourceStats = createDiscoverySourceStats();
  let stoppedByBudget = false;

  const sourceStates = DISCOVERY_SOURCES.map((sourceConfig) => ({
    sourceConfig,
    nextListingIndex: 0,
    sourceCount: 0
  }));

  while (hasBudgetRemaining(deadline)) {
    let madeProgressThisRound = false;

    for (const [sourceIndex, sourceState] of sourceStates.entries()) {
      const { sourceConfig } = sourceState;

      if (
        sourceState.sourceCount >= sourceConfig.maxCandidates ||
        sourceState.nextListingIndex >= sourceConfig.listingUrls.length
      ) {
        continue;
      }

      if (!hasBudgetRemaining(deadline)) {
        stoppedByBudget = true;
        break;
      }

      madeProgressThisRound = true;
      const listingUrl = sourceConfig.listingUrls[sourceState.nextListingIndex];
      sourceState.nextListingIndex += 1;
      sourceStats[sourceConfig.source].listingPagesScanned += 1;

      onProgress({
        stage: "discovering",
        current: sourceIndex + 1,
        total: DISCOVERY_SOURCES.length,
        source: sourceConfig.source,
        discovered: discoveredJobs.length,
        message: `Scanning ${sourceConfig.source} (${sourceStats[sourceConfig.source].listingPagesScanned}/${sourceConfig.listingUrls.length} listing pages, ${getBudgetMessage(deadline)})`
      });

      try {
        const response = await fetchWithTimeout(listingUrl, requestTimeoutMs);
        if (!response.ok) {
          sourceStats[sourceConfig.source].errors += 1;
          discoveryLog.push({
            source: sourceConfig.source,
            listingUrl,
            reason: `Listing HTTP ${response.status}`
          });
          continue;
        }

        const html = await response.text();
        const links = extractResolvedLinks(html, listingUrl);
        const remainingSlots = sourceConfig.maxCandidates - sourceState.sourceCount;
        const detailCandidates = [...new Set(
          links.filter((link) => {
            if (!sourceConfig.detailPattern.test(link)) {
              return false;
            }

            const normalized = link.toLowerCase();
            return !existingUrls.has(normalized) && !discoveredUrls.has(normalized);
          })
        )].slice(0, Math.max(remainingSlots * 2, 6));

        for (let index = 0; index < detailCandidates.length; index += discoveryConcurrency) {
          if (!hasBudgetRemaining(deadline)) {
            stoppedByBudget = true;
            break;
          }

          const chunk = detailCandidates.slice(index, index + discoveryConcurrency);
          sourceStats[sourceConfig.source].detailPagesScanned += chunk.length;

          const discoveredFromPage = await mapWithConcurrency(chunk, discoveryConcurrency, async (link) =>
            processDiscoveredDetailPage(sourceConfig, link, requestTimeoutMs)
          );

          for (const result of discoveredFromPage) {
            if (!result) {
              continue;
            }

            if (result.type === "log") {
              sourceStats[sourceConfig.source].errors += 1;
              discoveryLog.push(result.payload);
              continue;
            }

            if (result.type === "job" && result.payload) {
              const normalized = String(result.payload.url || "").toLowerCase();
              if (!normalized || existingUrls.has(normalized) || discoveredUrls.has(normalized)) {
                continue;
              }

              discoveredJobs.push(result.payload);
              discoveredUrls.add(normalized);
              sourceState.sourceCount += 1;
              sourceStats[sourceConfig.source].discovered += 1;

              if (sourceState.sourceCount >= sourceConfig.maxCandidates) {
                break;
              }
            }
          }

          if (sourceState.sourceCount >= sourceConfig.maxCandidates || stoppedByBudget) {
            break;
          }
        }
      } catch (error) {
        sourceStats[sourceConfig.source].errors += 1;
        discoveryLog.push({
          source: sourceConfig.source,
          listingUrl,
          reason: error instanceof Error ? error.message : "Unknown listing discovery error"
        });
      }
    }

    if (!madeProgressThisRound) {
      break;
    }
  }

  return {
    discoveredJobs,
    discoveryLog,
    stoppedByBudget,
    sourceStats
  };
}

function enrichVerifiedJob(job, html, finalUrl) {
  const extractedTitle = extractTitleFromHtml(html);
  const nextTitle =
    job.title && !/\?{2,}/.test(job.title) && !/^unknown$/i.test(job.title)
      ? job.title
      : extractedTitle || job.title;

  return {
    ...job,
    title: nextTitle,
    source_url: job.source_url || finalUrl || job.url,
    source_date: nowDateText(),
    first_posted_at: job.first_posted_at || job.source_date || nowDateText()
  };
}

async function verifyJob(job, manualInvalidations = [], requestTimeoutMs = DEFAULT_TIMEOUT_MS) {
  const manualRule = Array.isArray(manualInvalidations)
    ? manualInvalidations.find((rule) => matchesManualInvalidation(rule, job))
    : null;

  const crawlUrl = job.source_url || job.url;
  if (!crawlUrl) {
    return {
      type: "failed",
      payload: {
        url: "",
        source: job.source || "Unknown",
        reason: "Missing crawl URL"
      },
      job
    };
  }

  try {
    const response = await fetchWithTimeout(crawlUrl, requestTimeoutMs);
    const html = await response.text();
    const pageText = normalizePageText(html);

    if (!response.ok && shouldRetainOnHttpError(response.status)) {
      return {
        type: "failed",
        payload: {
          url: crawlUrl,
          source: job.source || "Unknown",
          reason: `HTTP ${response.status}`
        },
        job
      };
    }

    if (looksClosed(job, response, pageText, html)) {
      return {
        type: "closed",
        payload: {
          url: crawlUrl,
          source: job.source || "Unknown",
          reason: manualRule?.reason || "Detected closed or removed listing"
        },
        job
      };
    }

    return {
      type: "verified",
      job: enrichVerifiedJob(job, html, response.url)
    };
  } catch (error) {
    return {
      type: "failed",
      payload: {
        url: crawlUrl,
        source: job.source || "Unknown",
        reason: error instanceof Error ? error.message : "Unknown fetch error"
      },
      job
    };
  }
}

export class AutoCrawlService {
  async crawlAllSources(options = {}) {
    const onProgress = typeof options.onProgress === "function" ? options.onProgress : () => {};
    const maxDurationMs = Number.isFinite(options.maxDurationMs) ? options.maxDurationMs : DEFAULT_CRAWL_BUDGET_MS;
    const requestTimeoutMs = Number.isFinite(options.requestTimeoutMs) ? options.requestTimeoutMs : DEFAULT_TIMEOUT_MS;
    const verificationConcurrency = Number.isFinite(options.verificationConcurrency)
      ? Math.max(1, Math.min(8, Math.trunc(options.verificationConcurrency)))
      : DEFAULT_VERIFICATION_CONCURRENCY;
    const discoveryConcurrency = Number.isFinite(options.discoveryConcurrency)
      ? Math.max(1, Math.min(4, Math.trunc(options.discoveryConcurrency)))
      : DEFAULT_DISCOVERY_CONCURRENCY;
    const interChunkDelayMs = Number.isFinite(options.interChunkDelayMs)
      ? Math.max(0, Math.trunc(options.interChunkDelayMs))
      : DEFAULT_INTER_CHUNK_DELAY_MS;
    const discoverNewJobs = options.discoverNewJobs !== false;
    const manualInvalidations = Array.isArray(options.manualInvalidations) ? options.manualInvalidations : [];
    const deadline = Date.now() + Math.max(5000, maxDurationMs);

    onProgress({
      stage: "loading",
      message: `Loading canonical jobs.json (${getBudgetMessage(deadline)})`
    });

    const inputPath = await resolveLatestSkillJson();
    const outputDir = await resolveLatestSkillOutputDir();
    const existingReport = await loadSkillReport(inputPath);
    const baseJobs = (Array.isArray(existingReport.jobs) ? existingReport.jobs : []).map(sanitizeBaseJob);

    let discoveredJobs = [];
    let discoveryLog = [];
    let discoverySourceStats = {};
    let discoveryStoppedByBudget = false;

    if (discoverNewJobs && hasBudgetRemaining(deadline)) {
      const discoveryResult = await discoverCandidateJobs(baseJobs, onProgress, deadline, {
        discoveryConcurrency,
        requestTimeoutMs
      });
      discoveredJobs = discoveryResult.discoveredJobs;
      discoveryLog = discoveryResult.discoveryLog;
      discoverySourceStats = discoveryResult.sourceStats;
      discoveryStoppedByBudget = discoveryResult.stoppedByBudget;
    }

    const crawlJobs = balanceJobsBySource([...baseJobs, ...discoveredJobs]);
    const verifiedJobs = [];
    const closedJobs = [];
    const failedJobs = [];
    let processed = 0;
    let verificationStoppedByBudget = false;

    onProgress({
      stage: "verifying",
      current: 0,
      total: crawlJobs.length,
      discovered: discoveredJobs.length,
      message: `Verifying ${crawlJobs.length} jobs with concurrency ${verificationConcurrency} (${getBudgetMessage(deadline)})`
    });

    for (let index = 0; index < crawlJobs.length; index += verificationConcurrency) {
      if (!hasBudgetRemaining(deadline)) {
        verificationStoppedByBudget = true;
        break;
      }

      const chunk = crawlJobs.slice(index, index + verificationConcurrency);
      const verificationResults = await mapWithConcurrency(chunk, verificationConcurrency, (job) =>
        verifyJob(job, manualInvalidations, requestTimeoutMs)
      );

      for (const result of verificationResults) {
        processed += 1;

        if (!result) {
          continue;
        }

        if (result.type === "verified" && result.job) {
          verifiedJobs.push(result.job);
        } else if (result.type === "closed" && result.payload) {
          closedJobs.push(result.payload);
        } else if (result.type === "failed" && result.payload) {
          failedJobs.push(result.payload);
          if (result.job) {
            verifiedJobs.push(result.job);
          }
        }

        onProgress({
          stage: "verifying",
          current: processed,
          total: crawlJobs.length,
          discovered: discoveredJobs.length,
          retainedOnError: failedJobs.length,
          removedClosed: closedJobs.length,
          message: `Verified ${processed}/${crawlJobs.length} (${getBudgetMessage(deadline)})`
        });
      }

      if (interChunkDelayMs > 0 && index + verificationConcurrency < crawlJobs.length && hasBudgetRemaining(deadline)) {
        await sleep(interChunkDelayMs);
      }
    }

    if (verificationStoppedByBudget) {
      const verifiedUrls = new Set(verifiedJobs.map((job) => String(job.url || "").toLowerCase()));
      for (const job of baseJobs) {
        const normalized = String(job.url || "").toLowerCase();
        if (!normalized || verifiedUrls.has(normalized)) {
          continue;
        }

        verifiedJobs.push({
          ...job,
          verification_skipped: true
        });
      }
    }

    const stoppedByBudget = discoveryStoppedByBudget || verificationStoppedByBudget;
    const shouldPersistResults = processed > 0 || discoveredJobs.length > 0 || closedJobs.length > 0;

    if (!shouldPersistResults) {
      return {
        inputPath,
        outputPath: inputPath,
        scanned: crawlJobs.length,
        processed,
        discovered: discoveredJobs.length,
        discoveryLog,
        discoverySourceStats,
        verified: 0,
        retainedOnError: failedJobs.length,
        removedClosed: closedJobs.length,
        closedJobs,
        failedJobs,
        jobs: baseJobs,
        partial: true,
        skippedSync: true,
        skipReason: "no-jobs-verified",
        maxDurationMs,
        requestTimeoutMs,
        verificationConcurrency
      };
    }

    const nextReport = {
      ...existingReport,
      created_at: nowDateText(),
      methodology: `${existingReport.methodology || "Verified against live sources."} Revalidated source URLs on ${nowDateText()} using a fast crawl budget.${stoppedByBudget ? " This run stopped after the configured time budget and retained existing jobs for remaining URLs." : ""}`,
      jobs: verifiedJobs.map((job) => stripTransientCrawlFields(job))
    };

    onProgress({
      stage: "writing",
      current: processed,
      total: crawlJobs.length,
      discovered: discoveredJobs.length,
      retainedOnError: failedJobs.length,
      removedClosed: closedJobs.length,
      message: "Writing canonical jobs.json"
    });

    const outputPath = await writeCanonicalSkillReport(nextReport, outputDir);

    return {
      inputPath,
      outputPath,
      scanned: crawlJobs.length,
      processed,
      discovered: discoveredJobs.length,
      discoveryLog,
      discoverySourceStats,
      verified: verifiedJobs.length - failedJobs.length,
      retainedOnError: failedJobs.length,
      removedClosed: closedJobs.length,
      closedJobs,
      failedJobs,
      jobs: verifiedJobs,
      partial: stoppedByBudget,
      maxDurationMs,
      requestTimeoutMs,
      verificationConcurrency
    };
  }
}
