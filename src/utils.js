export function nowIso() {
  return new Date().toISOString();
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return [...new Set(value.map((item) => String(item || "").trim()).filter(Boolean))];
  }

  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) {
      return [];
    }

    const separatorPattern = /[;|/]/;
    const items = separatorPattern.test(raw)
      ? raw.split(/\s*[;|/]\s*/)
      : raw.includes(",")
        ? raw.split(/\s*,\s*/)
        : [raw];

    return [...new Set(items.map((item) => item.trim()).filter(Boolean))];
  }

  return [];
}

function normalizeJobFamily(value, fallbackSource = "") {
  const raw = String(value || fallbackSource || "").trim().toLowerCase();

  if (!raw) {
    return "frontend";
  }

  if (["qa", "test", "testing", "sdet"].includes(raw)) {
    return "qa";
  }

  if (
    raw.includes("qa") ||
    raw.includes("test") ||
    raw.includes("sdet") ||
    raw.includes("qaエンジニア") ||
    raw.includes("テストエンジニア") ||
    raw.includes("品質保証") ||
    raw.includes("自動テスト")
  ) {
    return "qa";
  }

  if (
    raw.includes("backend") ||
    raw.includes("back-end") ||
    raw.includes("server-side") ||
    raw.includes("server side") ||
    raw.includes("バックエンド") ||
    raw.includes("サーバーサイド")
  ) {
    return "backend";
  }

  if (
    raw.includes("frontend") ||
    raw.includes("front-end") ||
    raw.includes("フロントエンド") ||
    raw.includes("webエンジニア")
  ) {
    return "frontend";
  }

  return "frontend";
}

function normalizeHiringStatus(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "unknown";
  }

  const normalized = raw.toLowerCase();
  if (
    /(closed|expired|inactive|position filled|filled|no longer hiring|no longer accepting|applications closed|not accepting|archived|stopped)/.test(normalized) ||
    /(募集終了|掲載終了|応募終了|受付終了|採用終了|充足|募集を終了|現在募集しておりません|応募受付を終了)/.test(raw)
  ) {
    return "closed";
  }

  if (
    /(open|active|hiring|recruiting|accepting applications|available)/.test(normalized) ||
    /(募集中|採用中|応募受付中|エントリー受付中|積極採用中)/.test(raw)
  ) {
    return "open";
  }

  return "unknown";
}

function getFirstMatchingPhrase(text, phrases) {
  const normalized = String(text || "").trim();
  if (!normalized) {
    return "";
  }

  return phrases.find((phrase) => normalized.includes(phrase)) || "";
}

function getStatusEvidenceText(input) {
  const fields = [
    "html_validation_text",
    "validation_text",
    "page_text",
    "response_text",
    "raw_text",
    "html_text",
    "body_text",
    "rendered_text",
    "extracted_text",
    "status_reason",
    "hiring_status"
  ];

  return fields
    .flatMap((field) => {
      const value = input?.[field];
      return Array.isArray(value) ? value : [value];
    })
    .map((value) => String(value || "").trim())
    .filter(Boolean)
    .join("\n");
}

function resolveHiringStatusData(input) {
  const explicitStatus = normalizeHiringStatus(input?.hiring_status);
  const explicitReason = String(input?.status_reason || "").trim();
  const evidenceText = getStatusEvidenceText(input);

  const closedPhrases = [
    "This job is no longer available.",
    "This position is closed and is no longer accepting applications.",
    "no longer available",
    "no longer accepting applications",
    "applications closed",
    "position filled",
    "listing expired",
    "募集終了",
    "掲載終了",
    "応募終了",
    "受付終了",
    "採用終了",
    "充足",
    "募集を終了",
    "現在募集しておりません",
    "応募受付を終了"
  ];

  const openPhrases = [
    "accepting applications",
    "currently hiring",
    "open role",
    "active listing",
    "募集中",
    "採用中",
    "応募受付中",
    "エントリー受付中",
    "積極採用中"
  ];

  const closedPhrase = getFirstMatchingPhrase(evidenceText, closedPhrases);
  if (closedPhrase) {
    return {
      hiring_status: "closed",
      status_reason: explicitReason || closedPhrase
    };
  }

  if (explicitStatus === "closed") {
    return {
      hiring_status: "closed",
      status_reason: explicitReason
    };
  }

  const openPhrase = getFirstMatchingPhrase(evidenceText, openPhrases);
  if (openPhrase) {
    return {
      hiring_status: "open",
      status_reason: explicitReason
    };
  }

  return {
    hiring_status: explicitStatus,
    status_reason: explicitReason
  };
}

export function buildJobKey(job) {
  return String(job.url || "").trim().toLowerCase();
}

export function normalizeJob(input) {
  const roleHint = `${input.title || ""} ${input.summary || ""} ${input.tech_stack || ""}`;
  const statusData = resolveHiringStatusData(input);

  return {
    title: input.title || "Unknown",
    company: input.company || "Unknown",
    job_family: normalizeJobFamily(input.job_family, roleHint),
    first_posted_at: input.first_posted_at || input.first_seen_at || input.source_date || "Unknown",
    company_size: input.company_size || "Unknown",
    location: input.location || "Unknown",
    work_mode: input.work_mode || "Unknown",
    employment_type: input.employment_type || "Unknown",
    salary: input.salary || "Unknown",
    japanese_level: input.japanese_level || "Unknown",
    english_level: input.english_level || "Unknown",
    visa_support: input.visa_support || "Unknown",
    tech_stack: input.tech_stack || "Unknown",
    benefits: normalizeStringArray(input.benefits),
    education_requirements: input.education_requirements || "Unknown",
    experience_requirements: input.experience_requirements || "Unknown",
    other_requirements: input.other_requirements || "Unknown",
    summary: input.summary || "",
    url: input.url || "",
    source: input.source || "Unknown",
    source_url: input.source_url || input.url || "",
    source_date: input.source_date || "Unknown",
    hiring_status: statusData.hiring_status,
    status_reason: statusData.status_reason,
    match_score: Number(input.match_score || 0),
    notes: input.notes || ""
  };
}

export function sortJobs(items) {
  return [...items].sort((a, b) => (b.match_score || 0) - (a.match_score || 0));
}
