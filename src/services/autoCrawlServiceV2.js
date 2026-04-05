import http from "http";
import https from "https";
import { URL } from "url";
import { loadSkillReport, resolveLatestSkillJson, resolveLatestSkillOutputDir, writeCanonicalSkillReport } from "./skillOutputSyncService.js";

const DEFAULT_TIMEOUT_MS = 5000;
const CRAWL_CONCURRENCY = 6;
const DISCOVERY_DETAIL_CONCURRENCY = 4;
const DEFAULT_CRAWL_BUDGET_MS = 55000;
const MIN_DISCOVERY_RESERVE_MS = 8000;
const MAX_DISCOVERY_RESERVE_MS = 20000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 JPHRJobCrawler/2.0";

const CLOSED_PATTERNS = [
  "job not found",
  "page not found",
  "not available",
  "募集終了",
  "掲載終了",
  "受付終了",
  "応募受付を終了",
  "この求人は終了",
  "求人は見つかりません"
];

const CLOSED_REGEXES = [
  /\u52df\u96c6\u7d42\u4e86/i,
  /\u5fdc\u52df\u53d7\u4ed8\u7d42\u4e86/i,
  /\u63b2\u8f09\u7d42\u4e86/i,
  /\u516c\u958b\u7d42\u4e86/i,
  /\u5145\u8db3\u3057\u307e\u3057\u305f/i,
  /\u5b9a\u54e1\u306b\u9054\u3057\u305f/i,
  /\u73fe\u5728.*\u52df\u96c6.*\u3042\u308a\u307e\u305b\u3093/i,
  /\u3053\u306e\u6c42\u4eba.*\u7d42\u4e86/i,
  /\u3053\u306e\u6c42\u4eba.*\u9589\u3058/i,
  /position filled/i,
  /no longer hiring/i,
  /applications closed/i,
  /job closed/i
];

const ACTIVE_HINTS = {
  Wantedly: ["話を聞きに行きたい", "wantedly", "募集"],
  Green: ["気になる", "この求人に応募", "green"],
  "Forkwell Jobs": ["応募する", "気になる", "forkwell jobs"],
  TokyoDev: ["apply now", "get this job", "tokyodev"],
  JapanDev: ["apply now", "salary", "remote", "japan dev"]
};

function withPageQuery(baseUrl, page) {
  return `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}page=${page}`;
}

const DISCOVERY_SOURCES = [
  {
    source: "TokyoDev",
    listingUrls: ["https://www.tokyodev.com/jobs", withPageQuery("https://www.tokyodev.com/jobs", 2)],
    detailPattern: /^https:\/\/www\.tokyodev\.com\/companies\/[^/]+\/jobs\/[^/?#]+/i,
    maxCandidates: 12
  },
  {
    source: "JapanDev",
    listingUrls: [
      "https://japan-dev.com/jobs",
      withPageQuery("https://japan-dev.com/jobs", 2),
      "https://japan-dev.com/front-end-jobs-in-japan",
      withPageQuery("https://japan-dev.com/front-end-jobs-in-japan", 2),
      "https://japan-dev.com/backend-jobs-in-japan",
      withPageQuery("https://japan-dev.com/backend-jobs-in-japan", 2),
      "https://japan-dev.com/qa-jobs-in-japan",
      withPageQuery("https://japan-dev.com/qa-jobs-in-japan", 2),
      "https://japan-dev.com/react-jobs-in-japan",
      withPageQuery("https://japan-dev.com/react-jobs-in-japan", 2),
      "https://japan-dev.com/javascript-jobs-in-japan",
      withPageQuery("https://japan-dev.com/javascript-jobs-in-japan", 2)
    ],
    detailPattern: /^https:\/\/japan-dev\.com\/jobs\/[^?#]+/i,
    maxCandidates: 24
  },
  {
    source: "Wantedly",
    listingUrls: [
      "https://www.wantedly.com/projects",
      withPageQuery("https://www.wantedly.com/projects", 2),
      withPageQuery("https://www.wantedly.com/projects", 3)
    ],
    detailPattern: /^https:\/\/www\.wantedly\.com\/projects\/\d+/i,
    maxCandidates: 12
  },
  {
    source: "Forkwell Jobs",
    listingUrls: [
      "https://jobs.forkwell.com/jobs",
      withPageQuery("https://jobs.forkwell.com/jobs", 2),
      withPageQuery("https://jobs.forkwell.com/jobs", 3),
      "https://jobs.forkwell.com/professions/front-end-engineer",
      "https://jobs.forkwell.com/professions/server-side-engineer",
      "https://jobs.forkwell.com/professions/qa-engineer"
    ],
    detailPattern: /^https:\/\/jobs\.forkwell\.com\/[^/]+\/jobs\/\d+/i,
    maxCandidates: 16
  },
  {
    source: "Green",
    listingUrls: [
      "https://www.green-japan.com/jobtype-l/190101",
      "https://www.green-japan.com/jobtype-l/190101/01",
      "https://www.green-japan.com/jobtype-l/190101/02",
      "https://www.green-japan.com/jobtype-l/190100",
      "https://www.green-japan.com/jobtype-l/190100/01",
      "https://www.green-japan.com/jobtype-l/190100/02",
      "https://www.green-japan.com/jobtype-l/190220",
      "https://www.green-japan.com/jobtype-l/190220/01",
      "https://www.green-japan.com/search/area/98/job/190101"
    ],
    detailPattern: /^https:\/\/www\.green-japan\.com\/company\/\d+\/job\/\d+/i,
    maxCandidates: 14
  }
];

const STRICT_CLOSED_PATTERNS = [
  "job not found",
  "page not found",
  "not available",
  "募集終了",
  "掲載終了",
  "受付終了",
  "応募受付を終了",
  "この求人は終了",
  "求人は見つかりません"
];

const STRICT_CLOSED_REGEXES = [
  /\u52df\u96c6\u7d42\u4e86/i,
  /\u52df\u96c6\u3092\u7d42\u4e86/i,
  /\u5fdc\u52df\u53d7\u4ed8\u7d42\u4e86/i,
  /\u5fdc\u52df\u53d7\u4ed8\u3092\u7d42\u4e86/i,
  /\u63b2\u8f09\u7d42\u4e86/i,
  /\u63b2\u8f09\u304c\u7d42\u4e86/i,
  /\u63b2\u8f09\u671f\u9593\u7d42\u4e86/i,
  /\u516c\u958b\u7d42\u4e86/i,
  /\u5145\u8db3\u3057\u307e\u3057\u305f/i,
  /\u5b9a\u54e1\u306b\u9054\u3057\u305f/i,
  /\u73fe\u5728.*\u52df\u96c6.*\u3042\u308a\u307e\u305b\u3093/i,
  /\u73fe\u5728.*\u5fdc\u52df.*\u53d7\u3051\u4ed8\u3051.*\u3042\u308a\u307e\u305b\u3093/i,
  /\u3053\u306e\u6c42\u4eba.*\u7d42\u4e86/i,
  /\u3053\u306e\u6c42\u4eba.*\u9589\u3058/i,
  /\u5fdc\u52df\u53d7\u4ed8\u7d42\u4e86\u3057\u307e\u3057\u305f/i,
  /\u6b8b\u5ff5\u306a\u304c\u3089.*\u52df\u96c6.*\u7d42\u4e86/i,
  /position filled/i,
  /role (has been )?filled/i,
  /vacancy filled/i,
  /no longer hiring/i,
  /no longer open/i,
  /no longer available/i,
  /applications closed/i,
  /application(s)? (have been )?closed/i,
  /no longer accepting applications/i,
  /job closed/i
];

const ACTIVE_OPEN_SIGNALS = {
  Wantedly: ["\u8a71\u3092\u805e\u304d\u306b\u884c\u304d\u305f\u3044", "\u307e\u305a\u306f\u8a71\u3092\u805e\u3044\u3066\u307f\u305f\u3044", "\u4eca\u3059\u3050\u4e00\u7dd2\u306b\u50cd\u304f"],
  Green: ["\u3053\u306e\u6c42\u4eba\u306b\u5fdc\u52df", "\u5fdc\u52df\u30d5\u30a9\u30fc\u30e0\u3078", "\u8a71\u3092\u805e\u3044\u3066\u307f\u305f\u3044"],
  "Forkwell Jobs": ["\u5fdc\u52df\u3059\u308b", "\u3053\u306e\u6c42\u4eba\u306b\u5fdc\u52df", "\u30ab\u30b8\u30e5\u30a2\u30eb\u9762\u8ac7"],
  TokyoDev: ["apply now", "get this job"],
  JapanDev: ["apply now", "view job", "job details"]
};

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
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeHtmlForDetection(html) {
  return decodeHtmlEntities(String(html || ""))
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function shouldRetainOnHttpError(status) {
  return [401, 403, 408, 429, 500, 502, 503, 504].includes(status);
}

function hasStrongOpenSignal(job, haystack) {
  const sourceKey = String(job?.source || "").trim();
  const signals = ACTIVE_OPEN_SIGNALS[sourceKey] || [];
  return signals.some((signal) => haystack.includes(String(signal).toLowerCase()));
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
  const normalizedHtml = normalizeHtmlForDetection(html);
  const markerPatterns = [
    /this position is closed and is no longer accepting applications/i,
    /this position is closed/i,
    /this (job|role|position) is closed/i,
    /no longer accepting applications/i,
    /applications? (have been )?closed/i,
    /position filled/i,
    /role (has been )?filled/i,
    /vacancy filled/i,
    /募集終了/i,
    /掲載終了/i,
    /応募受付(を)?終了/i,
    /現在.*応募.*受け付け.*ありません/i,
    /alert[\s\S]{0,240}(closed|filled|募集終了|掲載終了|応募受付終了)/i,
    /dialog[\s\S]{0,320}(closed|filled|募集終了|掲載終了|応募受付終了)/i,
    /modal[\s\S]{0,320}(closed|filled|募集終了|掲載終了|応募受付終了)/i,
    /banner[\s\S]{0,320}(closed|filled|募集終了|掲載終了|応募受付終了)/i,
    /notice[\s\S]{0,320}(closed|filled|募集終了|掲載終了|応募受付終了)/i,
    /status[\s\S]{0,240}(closed|filled|募集終了|掲載終了|応募受付終了)/i,
    /aria-label=["'][^"']*(closed|filled|募集終了|掲載終了|応募受付終了)[^"']*["']/i,
    /role=["']alert["'][\s\S]{0,320}(closed|filled|募集終了|掲載終了|応募受付終了)/i
  ];

  return markerPatterns.some((pattern) => pattern.test(normalizedHtml));
}

function looksClosed(job, response, pageText, html) {
  if (!response.ok) {
    return true;
  }

  const haystack = `${pageText} ${response.url}`.toLowerCase();
  const rawHaystack = `${pageText} ${response.url}`;
  const closedByKeyword =
    STRICT_CLOSED_PATTERNS.some((pattern) => haystack.includes(pattern.toLowerCase())) ||
    STRICT_CLOSED_REGEXES.some((pattern) => pattern.test(rawHaystack));

  // Explicit close banners in the raw HTML win over any other open-looking copy on the page.
  if (hasClosedMarkerInHtml(html)) {
    return true;
  }

  if (closedByKeyword && !hasStrongOpenSignal(job, haystack)) {
    return true;
  }

  if (wasRedirectedAwayFromDetail(job, response.url)) {
    return true;
  }

  return false;
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

function sleep(ms) {
  if (!ms || ms <= 0) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function clampConcurrency(value, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(1, Math.min(12, Math.trunc(parsed)));
}

function hasBudgetRemaining(deadline) {
  return !deadline || Date.now() < deadline;
}

function reserveVerificationBudget(maxDurationMs, discoverNewJobs) {
  if (!discoverNewJobs) {
    return 0;
  }

  const candidate = Math.floor(maxDurationMs * 0.35);
  return Math.min(MAX_DISCOVERY_RESERVE_MS, Math.max(MIN_DISCOVERY_RESERVE_MS, candidate));
}

function getBudgetMessage(deadline) {
  if (!deadline) {
    return "";
  }

  const remainingMs = Math.max(deadline - Date.now(), 0);
  const seconds = Math.ceil(remainingMs / 1000);
  return `剩余约 ${seconds} 秒`;
}

function extractResolvedLinks(html, pageUrl) {
  const links = [];
  const hrefPattern = /href=["']([^"'#]+)["']/gi;
  let match;

  while ((match = hrefPattern.exec(html)) !== null) {
    try {
      links.push(new URL(match[1], pageUrl).toString());
    } catch {
      // Ignore malformed hrefs.
    }
  }

  return links;
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

function looksRelevantRole(text) {
  const haystack = String(text || "").toLowerCase();
  return /(frontend|front-end|front end|ui engineer|backend|back-end|server-side|server side|api engineer|platform engineer|qa|quality assurance|test engineer|tester|sdet|フロントエンド|バックエンド|サーバーサイド|qaエンジニア|テストエンジニア|品質保証|自動テスト)/i.test(
    haystack
  );
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

function inferJobFamily(text) {
  const haystack = String(text || "").toLowerCase();

  if (/(qa|quality assurance|sdet|test engineer|tester|品質保証|qaエンジニア|テストエンジニア)/i.test(haystack)) {
    return "qa";
  }

  if (/(frontend|front-end|front end|ui engineer|フロントエンド|web frontend)/i.test(haystack)) {
    return "frontend";
  }

  if (/(backend|back-end|server-side|server side|platform engineer|api engineer|バックエンド|サーバーサイド)/i.test(haystack)) {
    return "backend";
  }

  return null;
}

function inferEmploymentType(text) {
  const haystack = String(text || "").toLowerCase();
  if (/intern/i.test(haystack) || /インターン/.test(text || "")) {
    return "Internship";
  }
  if (/contract/i.test(haystack) || /業務委託/.test(text || "")) {
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
    // Ignore URL parsing issues.
  }

  return "Unknown";
}

function extractCompanyFromTitle(title, source, jobUrl) {
  const rawTitle = String(title || "");
  const patternsBySource = {
    TokyoDev: [/ at (.+?) \| TokyoDev/i, / - (.+?) \| TokyoDev/i],
    JapanDev: [/ at (.+?) in Japan/i, / - (.+?) \| Japan Dev/i],
    Wantedly: [/ - (.+?)の採用/i, / - (.+?)の求人/i, / - (.+?) - Wantedly/i],
    "Forkwell Jobs": [/ - (.+?)の求人 - Forkwell Jobs/i],
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
    summary: description || "Auto-discovered from a supported listing source and verified as reachable.",
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

async function requestUrl(targetUrl, timeoutMs) {
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

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error("Request timed out"));
    });
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

async function processDiscoveredDetailPage(sourceConfig, link) {
  try {
    const detailResponse = await fetchWithTimeout(link);
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

async function discoverCandidateJobs(existingJobs, onProgress = () => {}, deadline = null) {
  const existingUrls = new Set(existingJobs.map((job) => String(job.url || "").trim().toLowerCase()));
  const discoveredJobs = [];
  const discoveredUrls = new Set();
  const discoveryLog = [];
  let stoppedByBudget = false;

  for (const [sourceIndex, sourceConfig] of DISCOVERY_SOURCES.entries()) {
    if (!hasBudgetRemaining(deadline)) {
      stoppedByBudget = true;
      break;
    }

    let sourceCount = 0;
    onProgress({
      stage: "discovering",
      current: sourceIndex + 1,
      total: DISCOVERY_SOURCES.length,
      source: sourceConfig.source,
      discovered: discoveredJobs.length,
      message: `正在扫描 ${sourceConfig.source} 的列表页... ${getBudgetMessage(deadline)}`
    });

    for (const listingUrl of sourceConfig.listingUrls) {
      if (sourceCount >= sourceConfig.maxCandidates) {
        break;
      }

      if (!hasBudgetRemaining(deadline)) {
        stoppedByBudget = true;
        break;
      }

      try {
        const response = await fetchWithTimeout(listingUrl);
        if (!response.ok) {
          discoveryLog.push({
            source: sourceConfig.source,
            listingUrl,
            reason: `Listing HTTP ${response.status}`
          });
          continue;
        }

        const html = await response.text();
        const links = extractResolvedLinks(html, listingUrl);
        const remainingSlots = sourceConfig.maxCandidates - sourceCount;
        const detailCandidates = [...new Set(
          links.filter((link) => {
            if (!sourceConfig.detailPattern.test(link)) {
              return false;
            }

            const normalized = link.toLowerCase();
            return !existingUrls.has(normalized) && !discoveredUrls.has(normalized);
          })
        )].slice(0, Math.max(remainingSlots * 3, 12));

        for (let index = 0; index < detailCandidates.length; index += DISCOVERY_DETAIL_CONCURRENCY) {
          if (!hasBudgetRemaining(deadline)) {
            stoppedByBudget = true;
            break;
          }

          const chunk = detailCandidates.slice(index, index + DISCOVERY_DETAIL_CONCURRENCY);
          const discoveredFromPage = await mapWithConcurrency(
            chunk,
            DISCOVERY_DETAIL_CONCURRENCY,
            async (link) => processDiscoveredDetailPage(sourceConfig, link)
          );

          for (const result of discoveredFromPage) {
            if (!result) {
              continue;
            }

            if (result.type === "log") {
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
              sourceCount += 1;

              if (sourceCount >= sourceConfig.maxCandidates) {
                break;
              }
            }
          }

          if (sourceCount >= sourceConfig.maxCandidates || stoppedByBudget) {
            break;
          }
        }
      } catch (error) {
        discoveryLog.push({
          source: sourceConfig.source,
          listingUrl,
          reason: error instanceof Error ? error.message : "Unknown listing discovery error"
        });
      }
    }

    if (stoppedByBudget) {
      break;
    }
  }

  return {
    discoveredJobs,
    discoveryLog,
    stoppedByBudget
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

async function verifyJob(job, manualInvalidations = []) {
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
    const response = await fetchWithTimeout(crawlUrl);
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
          reason: manualRule?.reason || (response.ok ? "Detected closed or removed listing" : `HTTP ${response.status}`)
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
    const deadline = Date.now() + Math.max(5000, maxDurationMs);
    const manualInvalidations = Array.isArray(options.manualInvalidations) ? options.manualInvalidations : [];
    const discoverNewJobs = options.discoverNewJobs !== false;
    const verificationConcurrency = clampConcurrency(options.verificationConcurrency, CRAWL_CONCURRENCY);
    const interChunkDelayMs = Math.max(0, Number(options.interChunkDelayMs) || 0);
    const verificationReserveMs = reserveVerificationBudget(maxDurationMs, discoverNewJobs);
    const discoveryDeadline = discoverNewJobs ? deadline - verificationReserveMs : deadline;

    onProgress({
      stage: "loading",
      message: `正在读取当前正式 jobs.json ... ${getBudgetMessage(deadline)}`
    });

    const inputPath = await resolveLatestSkillJson();
    const outputDir = await resolveLatestSkillOutputDir();
    const existingReport = await loadSkillReport(inputPath);
    const reportJobs = Array.isArray(existingReport.jobs) ? existingReport.jobs : [];
    const providedBaseJobs = Array.isArray(options.baseJobs) ? options.baseJobs : [];
    const baseJobs = (providedBaseJobs.length ? providedBaseJobs : reportJobs).map(sanitizeBaseJob);

    let discoveredJobs = [];
    let discoveryLog = [];
    let discoveryStoppedByBudget = false;

    if (discoverNewJobs) {
      onProgress({
        stage: "discovering",
        current: 0,
        total: DISCOVERY_SOURCES.length,
        discovered: 0,
        message: `正在从已接入站点发现新岗位链接... ${getBudgetMessage(deadline)}`
      });

      const discoveryResult = await discoverCandidateJobs(baseJobs, onProgress, discoveryDeadline);
      discoveredJobs = discoveryResult.discoveredJobs;
      discoveryLog = discoveryResult.discoveryLog;
      discoveryStoppedByBudget = discoveryResult.stoppedByBudget;
    } else {
      onProgress({
        stage: "discovering",
        current: 0,
        total: 0,
        discovered: 0,
        message: "本次仅校验当前岗位有效性，已跳过新岗位发现。"
      });
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
      message: `开始核验岗位详情，共 ${crawlJobs.length} 条，并发上限 ${verificationConcurrency}，按来源均衡轮询。${getBudgetMessage(deadline)}`
    });

    for (let index = 0; index < crawlJobs.length; index += verificationConcurrency) {
      if (!hasBudgetRemaining(deadline)) {
        verificationStoppedByBudget = true;
        break;
      }

      const chunk = crawlJobs.slice(index, index + verificationConcurrency);
      const verificationResults = await mapWithConcurrency(chunk, verificationConcurrency, (job) =>
        verifyJob(job, manualInvalidations)
      );

      for (const result of verificationResults) {
        processed += 1;

        if (!result) {
          onProgress({
            stage: "verifying",
            current: processed,
            total: crawlJobs.length,
            discovered: discoveredJobs.length,
            retainedOnError: failedJobs.length,
            removedClosed: closedJobs.length,
            message: `正在核验岗位详情 ${processed} / ${crawlJobs.length} ... ${getBudgetMessage(deadline)}`
          });
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
          message: `正在核验岗位详情 ${processed} / ${crawlJobs.length} ... ${getBudgetMessage(deadline)}`
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

    const shouldPersistResults = processed > 0 || discoveredJobs.length > 0 || closedJobs.length > 0;
    const stoppedByBudget = discoveryStoppedByBudget || verificationStoppedByBudget;

    if (!shouldPersistResults) {
      onProgress({
        stage: "skipped",
        current: processed,
        total: crawlJobs.length,
        discovered: discoveredJobs.length,
        retainedOnError: failedJobs.length,
        removedClosed: closedJobs.length,
        message: "本轮未完成任何岗位核验，已跳过 jobs.json 和数据库写入。"
      });

      return {
        inputPath,
        outputPath: inputPath,
        scanned: crawlJobs.length,
        processed,
        discovered: discoveredJobs.length,
        discoveryLog,
        verified: 0,
        retainedOnError: failedJobs.length,
        removedClosed: closedJobs.length,
        closedJobs,
        failedJobs,
        jobs: baseJobs,
        partial: true,
        skippedSync: true,
        skipReason: "no-verified-jobs-within-budget",
        maxDurationMs,
        verificationConcurrency,
        interChunkDelayMs,
        loadBalancingStrategy: "round-robin-by-source"
      };
    }

    const nextReport = {
      ...existingReport,
      created_at: nowDateText(),
      methodology: `${existingReport.methodology || "Verified against live sources."} Discovered fresh URLs from supported listing pages, recrawled configured source URLs on ${nowDateText()}, and retained prior records when network verification failed.${stoppedByBudget ? " This run stopped when the quick-crawl time budget was reached and kept prior records for the remaining URLs." : ""}`,
      jobs: verifiedJobs
    };

    onProgress({
      stage: "writing",
      current: processed,
      total: crawlJobs.length,
      discovered: discoveredJobs.length,
      retainedOnError: failedJobs.length,
      removedClosed: closedJobs.length,
      message: `正在写回正式 jobs.json ... ${getBudgetMessage(deadline)}`
    });

    const outputPath = await writeCanonicalSkillReport(
      {
        ...nextReport,
        jobs: verifiedJobs.map((job) => stripTransientCrawlFields(job))
      },
      outputDir
    );

    onProgress({
      stage: "written",
      current: processed,
      total: crawlJobs.length,
      discovered: discoveredJobs.length,
      retainedOnError: failedJobs.length,
      removedClosed: closedJobs.length,
      message: "正式 jobs.json 已更新，正在准备同步数据库..."
    });

    return {
      inputPath,
      outputPath,
      scanned: crawlJobs.length,
      processed,
      discovered: discoveredJobs.length,
      discoveryLog,
      verified: verifiedJobs.length - failedJobs.length,
      retainedOnError: failedJobs.length,
      removedClosed: closedJobs.length,
      closedJobs,
      failedJobs,
      jobs: verifiedJobs,
      partial: stoppedByBudget,
      maxDurationMs,
      verificationConcurrency,
      interChunkDelayMs,
      loadBalancingStrategy: "round-robin-by-source"
    };
  }
}
