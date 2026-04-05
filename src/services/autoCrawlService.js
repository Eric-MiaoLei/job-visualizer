import http from "http";
import https from "https";
import { URL } from "url";
import { loadSkillReport, resolveLatestSkillJson, resolveLatestSkillOutputDir, writeCanonicalSkillReport } from "./skillOutputSyncService.js";

const DEFAULT_TIMEOUT_MS = 5000;
const CRAWL_CONCURRENCY = 6;
const DEFAULT_CRAWL_BUDGET_MS = 55000;
const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36 JPHRJobCrawler/1.0";

const CLOSED_PATTERNS = [
  "募集終了",
  "募集は終了",
  "掲載終了",
  "掲載を終了",
  "応募受付終了",
  "受付終了",
  "この求人は終了",
  "この募集は終了",
  "該当する求人は見つかりません",
  "ページが見つかりません",
  "お探しのページは見つかりません",
  "job not found",
  "page not found"
];

const ACTIVE_HINTS = {
  Wantedly: ["話を聞きに行きたい", "カジュアル面談", "まずは話を聞いてみたい"],
  Green: ["この求人に応募する", "気になる", "話を聞いてみたい"],
  "Forkwell Jobs": ["応募する", "気になる", "カジュアル面談"],
  TokyoDev: ["Apply now", "Apply", "Get this job"],
  JapanDev: ["Apply now", "Apply", "Remote", "Salary"]
};

function withPageQuery(baseUrl, page) {
  return `${baseUrl}${baseUrl.includes("?") ? "&" : "?"}page=${page}`;
}

const DISCOVERY_SOURCES = [
  {
    source: "TokyoDev",
    listingUrls: [
      "https://www.tokyodev.com/jobs",
      withPageQuery("https://www.tokyodev.com/jobs", 2)
    ],
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

function looksClosed(job, response, pageText) {
  if (!response.ok) {
    return true;
  }

  const haystack = `${pageText} ${response.url}`.toLowerCase();
  if (CLOSED_PATTERNS.some((pattern) => haystack.includes(pattern.toLowerCase()))) {
    const activeHints = ACTIVE_HINTS[job.source] || [];
    if (!activeHints.some((hint) => haystack.includes(hint.toLowerCase()))) {
      return true;
    }
  }

  return false;
}

function shouldRetainOnHttpError(status) {
  return [401, 403, 408, 429, 500, 502, 503, 504].includes(status);
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

function hasBudgetRemaining(deadline) {
  return !deadline || Date.now() < deadline;
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

function looksRelevantRole(text) {
  const haystack = String(text || "").toLowerCase();
  return /(frontend|front-end|front end|ui engineer|backend|back-end|server-side|api engineer|platform engineer|qa|quality assurance|test engineer|tester|sdet|フロントエンド|バックエンド|サーバーサイド|qaエンジニア|テストエンジニア|品質保証|自動テスト)/i.test(
    haystack
  );
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
    Wantedly: [/ - (.+?)の.+Wantedly/i, / - (.+?)の.+採用/i],
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
      message: `正在扫描 ${sourceConfig.source} 的列表页...`
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

        for (let index = 0; index < detailCandidates.length; index += 4) {
          if (!hasBudgetRemaining(deadline)) {
            stoppedByBudget = true;
            break;
          }

          const chunk = detailCandidates.slice(index, index + 4);
          const discoveredFromPage = await mapWithConcurrency(chunk, 4, async (link) => {
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
              if (looksClosed({ source: sourceConfig.source }, detailResponse, pageText)) {
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
          });

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

async function verifyJob(job) {
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

    if (looksClosed(job, response, pageText)) {
      return {
        type: "closed",
        payload: {
          url: crawlUrl,
          source: job.source || "Unknown",
          reason: response.ok ? "Detected closed or removed listing" : `HTTP ${response.status}`
        }
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

    onProgress({
      stage: "loading",
      message: "正在读取当前正式 jobs.json ..."
    });

    const inputPath = await resolveLatestSkillJson();
    const outputDir = await resolveLatestSkillOutputDir();
    const existingReport = await loadSkillReport(inputPath);
    const baseJobs = Array.isArray(existingReport.jobs) ? existingReport.jobs : [];

    onProgress({
      stage: "discovering",
      current: 0,
      total: DISCOVERY_SOURCES.length,
      discovered: 0,
      message: "正在从已接入站点发现新岗位链接..."
    });

    const { discoveredJobs, discoveryLog } = await discoverCandidateJobs(baseJobs, onProgress);
    const crawlJobs = [...baseJobs, ...discoveredJobs];

    const verifiedJobs = [];
    const closedJobs = [];
    const failedJobs = [];
    let processed = 0;

    onProgress({
      stage: "verifying",
      current: 0,
      total: crawlJobs.length,
      discovered: discoveredJobs.length,
      message: `开始核验岗位详情，共 ${crawlJobs.length} 条...`
    });

    const verificationResults = await mapWithConcurrency(crawlJobs, CRAWL_CONCURRENCY, (job) => verifyJob(job));

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
          message: `正在核验岗位详情 ${processed} / ${crawlJobs.length} ...`
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
        message: `正在核验岗位详情 ${processed} / ${crawlJobs.length} ...`
      });
    }

    const nextReport = {
      ...existingReport,
      created_at: nowDateText(),
      methodology: `${existingReport.methodology || "Verified against live sources."} Discovered fresh URLs from supported listing pages, recrawled all configured source URLs on ${nowDateText()}, and retained prior records when network verification failed.`,
      jobs: verifiedJobs
    };

    onProgress({
      stage: "writing",
      current: processed,
      total: crawlJobs.length,
      discovered: discoveredJobs.length,
      retainedOnError: failedJobs.length,
      removedClosed: closedJobs.length,
      message: "正在写回正式 jobs.json ..."
    });

    const outputPath = await writeCanonicalSkillReport(nextReport, outputDir);

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
      discovered: discoveredJobs.length,
      discoveryLog,
      verified: verifiedJobs.length - failedJobs.length,
      retainedOnError: failedJobs.length,
      removedClosed: closedJobs.length,
      closedJobs,
      failedJobs,
      jobs: verifiedJobs
    };
  }
}
