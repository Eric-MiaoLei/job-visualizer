const statsGrid = document.getElementById("statsGrid");
const jobsList = document.getElementById("jobsList");
const template = document.getElementById("jobCardTemplate");
const crawlAllButton = document.getElementById("crawlAllButton");
const refreshButton = document.getElementById("refreshButton");
const syncLatestButton = document.getElementById("syncLatestButton");
const resetFiltersButton = document.getElementById("resetFiltersButton");
const toggleFiltersButton = document.getElementById("toggleFiltersButton");
const toastViewport = document.getElementById("toastViewport");
const manualCloseModal = document.getElementById("manualCloseModal");
const manualCloseDialog = document.getElementById("manualCloseDialog");
const manualCloseForm = document.getElementById("manualCloseForm");
const manualCloseConfirmButton = document.getElementById("manualCloseConfirmButton");
const manualCloseCancelButton = document.getElementById("manualCloseCancelButton");
const toolbarCard = document.querySelector(".toolbar-card");
const toolbarContent = document.getElementById("toolbarContent");
const searchInput = document.getElementById("searchInput");
const locationFilter = document.getElementById("locationFilter");
const roleFamilyFilter = document.getElementById("roleFamilyFilter");
const sourceFilter = document.getElementById("sourceFilter");
const remoteFilter = document.getElementById("remoteFilter");
const japaneseFilter = document.getElementById("japaneseFilter");
const englishFilter = document.getElementById("englishFilter");
const sortSelect = document.getElementById("sortSelect");
const salaryOnlyFilter = document.getElementById("salaryOnlyFilter");
const stackFilterList = document.getElementById("stackFilterList");
const resultSummary = document.getElementById("resultSummary");
const listTabs = document.getElementById("listTabs");
const listSectionTitle = document.getElementById("listSectionTitle");

const defaultFilters = {
  search: "",
  location: "all",
  roleFamily: "all",
  source: "all",
  remote: "all",
  japanese: "all",
  english: "all",
  salaryOnly: false,
  sort: "match",
  stacks: []
};

let dashboardState = {
  jobs: [],
  stats: {}
};

let uiState = {
  filters: { ...defaultFilters },
  currentTab: "active",
  filtersCollapsed: false,
  hasAutoCollapsed: false,
  manualExpandedWhileStuck: false
};

let crawlStatusPoller = null;
let activeToast = null;
let activeToastTimer = null;
let searchRenderTimer = null;
let lastStackFilterSignature = "";
let manualCloseResolve = null;

function dismissToast() {
  if (activeToastTimer) {
    window.clearTimeout(activeToastTimer);
    activeToastTimer = null;
  }

  if (!activeToast) {
    return;
  }

  activeToast.classList.remove("is-visible");
  const toastToRemove = activeToast;
  activeToast = null;
  window.setTimeout(() => {
    toastToRemove.remove();
  }, 220);
}

function setNotice(message, tone = "neutral") {
  if (!toastViewport) {
    return;
  }

  if (!activeToast) {
    activeToast = document.createElement("div");
    activeToast.className = "toast";
    toastViewport.append(activeToast);
    requestAnimationFrame(() => {
      activeToast?.classList.add("is-visible");
    });
  }

  activeToast.dataset.tone = tone;
  activeToast.textContent = message;

  if (tone === "neutral") {
    if (activeToastTimer) {
      window.clearTimeout(activeToastTimer);
      activeToastTimer = null;
    }
    return;
  }

  if (activeToastTimer) {
    window.clearTimeout(activeToastTimer);
  }

  activeToastTimer = window.setTimeout(() => {
    dismissToast();
  }, 3600);
}

function setCrawlButtonsDisabled(disabled) {
  crawlAllButton.disabled = disabled;
  syncLatestButton.disabled = disabled;
  refreshButton.disabled = disabled;
}

function formatCrawlProgress(payload) {
  const progress = payload?.progress;
  if (!progress) {
    return "全站抓取正在后台执行，页面会在完成后自动刷新。";
  }

  const baseMessage = progress.message || "全站抓取正在后台执行。";
  if (typeof progress.current === "number" && typeof progress.total === "number" && progress.total > 0) {
    return `${baseMessage}（${progress.current} / ${progress.total}）`;
  }

  return baseMessage;
}

function syncToolbarState() {
  toolbarCard.classList.toggle("is-collapsed", uiState.filtersCollapsed);
  toolbarCard.classList.toggle("is-stuck", uiState.hasAutoCollapsed);
  toolbarContent.hidden = uiState.filtersCollapsed;
  toggleFiltersButton.textContent = uiState.filtersCollapsed ? "展开筛选" : "收起筛选";
  toggleFiltersButton.setAttribute("aria-expanded", String(!uiState.filtersCollapsed));
}

function syncListTabState() {
  listTabs?.querySelectorAll(".list-tab").forEach((button) => {
    button.classList.toggle("is-active", button.dataset.tab === uiState.currentTab);
  });

  if (listSectionTitle) {
    const titleMap = {
      active: "当前岗位列表",
      favorite: "收藏岗位列表",
      closed: "职位已关闭列表"
    };
    listSectionTitle.textContent = titleMap[uiState.currentTab] || "当前岗位列表";
  }
}

function statCard({ label, value, accent = "", active = false, key = "" }) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `stat-card stat-card--interactive ${accent} ${active ? "is-active" : ""}`.trim();
  button.dataset.quickFilter = key;
  button.setAttribute("aria-pressed", String(active));
  button.innerHTML = `
    <div class="stat-label">${label}</div>
    <div class="stat-value">${value}</div>
  `;
  return button;
}

function uniqueValues(items, field) {
  return [...new Set(items.map((item) => item[field]).filter(Boolean))];
}

function populateSelect(select, values, allLabel) {
  const currentValue = select.value;
  select.innerHTML = "";

  const defaultOption = document.createElement("option");
  defaultOption.value = "all";
  defaultOption.textContent = allLabel;
  select.append(defaultOption);

  values.forEach((value) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = value;
    select.append(option);
  });

  if ([...select.options].some((option) => option.value === currentValue)) {
    select.value = currentValue;
  }
}

function syncStackFilterSelection() {
  const selected = new Set(uiState.filters.stacks);
  stackFilterList.querySelectorAll(".stack-chip").forEach((button) => {
    button.classList.toggle("is-selected", selected.has(button.dataset.stack || ""));
  });
}

function buildStackFilters(jobs) {
  const stackTokens = [...new Set(jobs.flatMap((job) => job.techStackTokens || []).sort((a, b) => a.localeCompare(b)))];
  const signature = stackTokens.join("||");

  if (signature === lastStackFilterSignature && stackFilterList.childElementCount === stackTokens.length) {
    syncStackFilterSelection();
    return;
  }

  lastStackFilterSignature = signature;
  const fragment = document.createDocumentFragment();
  stackFilterList.innerHTML = "";

  stackTokens.forEach((stack) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "stack-chip";
    button.textContent = stack;
    button.dataset.stack = stack;
    fragment.append(button);
  });

  stackFilterList.append(fragment);
  syncStackFilterSelection();
}

function closeManualCloseModal(reason = null) {
  if (manualCloseModal?.hidden) {
    return;
  }

  manualCloseModal.hidden = true;
  document.body.classList.remove("has-modal-open");
  const resolve = manualCloseResolve;
  manualCloseResolve = null;
  resolve?.(reason);
}

function openManualCloseModal() {
  if (!manualCloseModal || !manualCloseDialog) {
    return Promise.resolve(null);
  }

  manualCloseModal.hidden = false;
  document.body.classList.add("has-modal-open");
  manualCloseForm?.reset();

  return new Promise((resolve) => {
    manualCloseResolve = resolve;
    window.setTimeout(() => {
      manualCloseDialog.querySelector(".modal-radio:checked")?.focus();
    }, 0);
  });
}

function matchesFilters(job, options = {}) {
  const {
    ignoreRoleFamily = false,
    ignoreRemote = false,
    ignoreSalaryOnly = false,
    ignoreTab = false
  } = options;
  const { search, location, roleFamily, source, remote, japanese, english, salaryOnly, stacks } = uiState.filters;
  const searchTerm = search.trim().toLowerCase();
  const searchBlob = `${job.title} ${job.company} ${job.tech_stack} ${job.roleFamily} ${job.source}`.toLowerCase();

  if (searchTerm && !searchBlob.includes(searchTerm)) {
    return false;
  }

  if (location !== "all" && job.locationBucket !== location) {
    return false;
  }

  if (!ignoreRoleFamily && roleFamily !== "all" && job.roleFamily !== roleFamily) {
    return false;
  }

  if (source !== "all" && job.source !== source) {
    return false;
  }

  if (!ignoreRemote && remote === "remote" && !job.isRemoteFriendly) {
    return false;
  }

  if (!ignoreRemote && remote === "onsite" && job.isRemoteFriendly) {
    return false;
  }

  if (japanese !== "all" && job.japanese_level !== japanese) {
    return false;
  }

  if (english !== "all" && job.english_level !== english) {
    return false;
  }

  if (!ignoreSalaryOnly && salaryOnly && job.parsedSalaryMax === null) {
    return false;
  }

  if (stacks.length && !stacks.some((stack) => (job.techStackTokens || []).includes(stack))) {
    return false;
  }

  if (!ignoreTab && uiState.currentTab === "active" && job.hiring_status === "closed") {
    return false;
  }

  if (!ignoreTab && uiState.currentTab === "favorite" && !job.isFavorite) {
    return false;
  }

  if (!ignoreTab && uiState.currentTab === "closed" && job.hiring_status !== "closed") {
    return false;
  }

  return true;
}

function getQuickFilterContextJobs() {
  return dashboardState.jobs.filter((job) => matchesFilters(job, {
    ignoreRoleFamily: true,
    ignoreRemote: true,
    ignoreSalaryOnly: true,
    ignoreTab: true
  }));
}

function renderStats(contextJobs, filteredJobs) {
  const roleFamilies = {
    frontend: contextJobs.filter((job) => job.roleFamily === "前端").length,
    backend: contextJobs.filter((job) => job.roleFamily === "后端").length,
    qa: contextJobs.filter((job) => job.roleFamily === "测试 / QA").length
  };
  const quickFilterIsDefault =
    uiState.currentTab === "active" &&
    uiState.filters.roleFamily === "all" &&
    uiState.filters.remote === "all" &&
    uiState.filters.salaryOnly === false;

  statsGrid.innerHTML = "";
  statsGrid.append(
    statCard({ label: "当前结果", value: filteredJobs.length, accent: "is-highlight", active: quickFilterIsDefault, key: "reset-quick" }),
    statCard({ label: "招聘中", value: contextJobs.filter((job) => job.hiring_status !== "closed").length, active: uiState.currentTab === "active", key: "tab-active" }),
    statCard({ label: "已关闭", value: contextJobs.filter((job) => job.hiring_status === "closed").length, active: uiState.currentTab === "closed", key: "tab-closed" }),
    statCard({ label: "已收藏", value: contextJobs.filter((job) => job.isFavorite).length, active: uiState.currentTab === "favorite", key: "tab-favorite" }),
    statCard({ label: "前端岗位", value: roleFamilies.frontend, active: uiState.filters.roleFamily === "前端", key: "role-frontend" }),
    statCard({ label: "后端岗位", value: roleFamilies.backend, active: uiState.filters.roleFamily === "后端", key: "role-backend" }),
    statCard({ label: "测试 / QA", value: roleFamilies.qa, active: uiState.filters.roleFamily === "测试 / QA", key: "role-qa" }),
    statCard({ label: "远程友好", value: contextJobs.filter((job) => job.isRemoteFriendly).length, active: uiState.filters.remote === "remote", key: "remote" }),
    statCard({ label: "含薪资信息", value: contextJobs.filter((job) => job.parsedSalaryMax !== null).length, active: uiState.filters.salaryOnly, key: "salary" })
  );
}

function appendDetail(list, label, value) {
  const dt = document.createElement("dt");
  const dd = document.createElement("dd");
  dt.textContent = label;
  dd.textContent = value || "未知";
  list.append(dt, dd);
}

function createStackPill(text) {
  const span = document.createElement("span");
  span.className = "stack-pill";
  span.textContent = text;
  return span;
}

function createInfoPill(label, value, tone = "default") {
  const span = document.createElement("span");
  span.className = `info-pill ${tone !== "default" ? `is-${tone}` : ""}`.trim();
  span.textContent = label ? `${label}：${value}` : value;
  return span;
}

function normalizeBenefits(benefits) {
  if (!Array.isArray(benefits)) {
    return [];
  }

  return [...new Set(
    benefits
      .map((item) => String(item || "").trim())
      .filter((item) => item && !/^unknown$/i.test(item) && item !== "未知")
  )];
}

function createJobCard(job) {
  const node = template.content.firstElementChild.cloneNode(true);
  node.dataset.jobKey = job.jobKey;
  node.querySelector(".job-company").textContent = job.company;
  node.querySelector(".job-title").textContent = job.title;

  const statusBadge = node.querySelector(".job-status-badge");
  if (job.hiring_status === "closed") {
    statusBadge.textContent = "已关闭";
    statusBadge.classList.add("is-closed");
    node.classList.add("is-closed");
  } else {
    statusBadge.textContent = "招聘中";
    statusBadge.classList.add("is-open");
  }
  if (job.isFavorite) {
    node.classList.add("is-favorite");
  }

  const favoriteBadge = node.querySelector(".job-favorite-badge");
  favoriteBadge.hidden = !job.isFavorite;

  const roleBadge = node.querySelector(".job-family-badge");
  roleBadge.textContent = job.roleFamily;
  roleBadge.classList.add("is-role");

  node.querySelector(".job-meta").textContent =
    `${job.roleFamily} · ${job.locationBucket} · ${job.work_mode} · ${job.employment_type} · ${job.salary}`;

  const stackList = node.querySelector(".job-stack-list");
  (job.techStackTokens || []).forEach((stack) => stackList.append(createStackPill(stack)));

  const highlightList = node.querySelector(".job-highlights");
  if (job.hiring_status === "closed") {
    highlightList.append(createInfoPill("关闭原因", job.status_reason || "已关闭", "danger"));
  }
  if (job.company_size && !/^unknown$/i.test(job.company_size) && job.company_size !== "未知") {
    highlightList.append(createInfoPill("人员规模", job.company_size, "warm"));
  }
  if (job.visa_support && !/^unknown$/i.test(job.visa_support) && job.visa_support !== "未知") {
    highlightList.append(createInfoPill("签证支持", job.visa_support, "cool"));
  }

  node.querySelector(".job-summary").textContent = job.summary || "暂无岗位摘要";

  const normalizedBenefits = normalizeBenefits(job.benefits);
  const benefitsSection = node.querySelector(".job-benefits");
  const benefitsList = node.querySelector(".job-benefit-list");
  if (normalizedBenefits.length) {
    normalizedBenefits.slice(0, 6).forEach((benefit) => {
      benefitsList.append(createInfoPill("", benefit));
    });
    if (normalizedBenefits.length > 6) {
      benefitsList.append(createInfoPill("", `+${normalizedBenefits.length - 6} 项`));
    }
    benefitsSection.hidden = false;
  }

  const details = node.querySelector(".job-details");
  appendDetail(details, "地点", job.location);
  appendDetail(details, "岗位方向", job.roleFamily);
  appendDetail(details, "首次招聘时间", job.first_posted_at || "未知");
  appendDetail(details, "来源网站", job.source || "未知");
  appendDetail(details, "日语", job.japanese_level);
  appendDetail(details, "英语", job.english_level);
  appendDetail(details, "签证", job.visa_support);
  appendDetail(details, "核验日期", job.source_date);
  if (job.hiring_status === "closed") {
    appendDetail(details, "关闭原因", job.status_reason || "已关闭");
    appendDetail(details, "关闭时间", job.closedAt ? new Date(job.closedAt).toLocaleString("zh-CN") : "未知");
  }
  appendDetail(details, "匹配分", String(job.match_score ?? 0));
  appendDetail(details, "版本", String(job.version || 1));
  appendDetail(details, "最近同步", job.lastSeenAt ? new Date(job.lastSeenAt).toLocaleString("zh-CN") : "未知");

  const link = node.querySelector(".job-link");
  link.href = job.url;

  const sourceLink = node.querySelector(".job-source-link");
  sourceLink.href = job.source_url || job.url;

  const favoriteButton = node.querySelector('[data-action="favorite"]');
  favoriteButton.textContent = job.isFavorite ? "取消收藏" : "收藏";
  favoriteButton.classList.toggle("is-active", Boolean(job.isFavorite));

  const manualCloseButton = node.querySelector('[data-action="manual-close"]');
  const reopenButton = node.querySelector('[data-action="reopen"]');
  if (job.hiring_status === "closed") {
    manualCloseButton.hidden = true;
    reopenButton.hidden = false;
  } else {
    reopenButton.hidden = true;
  }

  return node;
}

function renderJobs(target, jobs) {
  target.innerHTML = "";
  if (!jobs.length) {
    const empty = document.createElement("div");
    empty.className = "stat-card";
    empty.textContent = "当前筛选条件下没有可展示的数据。";
    target.append(empty);
    return;
  }

  jobs.forEach((job) => target.append(createJobCard(job)));
}

function compareBySort(left, right) {
  const mode = uiState.filters.sort;

  if (mode === "latest") {
    return new Date(right.source_date) - new Date(left.source_date);
  }

  if (mode === "firstPosted") {
    return (right.parsedFirstPostedAt ?? Number.NEGATIVE_INFINITY) - (left.parsedFirstPostedAt ?? Number.NEGATIVE_INFINITY);
  }

  if (mode === "salaryDesc" || mode === "salaryAsc") {
    const fallback = mode === "salaryDesc" ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
    const leftMax = left.parsedSalaryMax ?? fallback;
    const rightMax = right.parsedSalaryMax ?? fallback;
    const leftMin = left.parsedSalaryMin ?? fallback;
    const rightMin = right.parsedSalaryMin ?? fallback;

    if (mode === "salaryDesc") {
      if (rightMax !== leftMax) {
        return rightMax - leftMax;
      }
      return rightMin - leftMin;
    }

    if (leftMax !== rightMax) {
      return leftMax - rightMax;
    }
    return leftMin - rightMin;
  }

  if (mode === "company") {
    return String(left.company).localeCompare(String(right.company));
  }

  return (right.match_score || 0) - (left.match_score || 0);
}

function getFilteredJobs() {
  return dashboardState.jobs.filter(matchesFilters).sort(compareBySort);
}

function syncControlsFromState() {
  searchInput.value = uiState.filters.search;
  locationFilter.value = uiState.filters.location;
  roleFamilyFilter.value = uiState.filters.roleFamily;
  sourceFilter.value = uiState.filters.source;
  remoteFilter.value = uiState.filters.remote;
  japaneseFilter.value = uiState.filters.japanese;
  englishFilter.value = uiState.filters.english;
  sortSelect.value = uiState.filters.sort;
  salaryOnlyFilter.checked = uiState.filters.salaryOnly;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;")
    .replaceAll("'", "&#39;");
}

function getActiveFilterLabels() {
  const labels = [];
  const { search, location, roleFamily, source, remote, japanese, english, salaryOnly, sort, stacks } = uiState.filters;

  if (search.trim()) {
    labels.push(`搜索: ${search.trim()}`);
  }
  if (location !== "all") {
    labels.push(`地点: ${location}`);
  }
  if (roleFamily !== "all") {
    labels.push(`岗位方向: ${roleFamily}`);
  }
  if (source !== "all") {
    labels.push(`来源网站: ${source}`);
  }
  if (remote === "remote") {
    labels.push("远程友好");
  }
  if (remote === "onsite") {
    labels.push("仅非远程");
  }
  if (japanese !== "all") {
    labels.push(`日语: ${japanese}`);
  }
  if (english !== "all") {
    labels.push(`英语: ${english}`);
  }
  if (salaryOnly) {
    labels.push("仅看有薪资");
  }
  if (sort !== "match") {
    const sortLabels = {
      latest: "核验时间最新",
      firstPosted: "首次招聘时间最新",
      salaryDesc: "薪资从高到低",
      salaryAsc: "薪资从低到高",
      company: "公司名 A-Z"
    };
    labels.push(`排序: ${sortLabels[sort] || sort}`);
  }
  stacks.forEach((stack) => labels.push(`技术栈: ${stack}`));

  return labels;
}

function updateResultSummary(filteredJobs) {
  const activeLabels = getActiveFilterLabels();
  const tabLabelMap = {
    active: "当前岗位",
    favorite: "收藏岗位",
    closed: "已关闭岗位"
  };
  const tabLabel = tabLabelMap[uiState.currentTab] || "当前岗位";
  const chipsHtml = activeLabels.length
    ? activeLabels.map((label) => `<span class="summary-chip">${escapeHtml(label)}</span>`).join("")
    : '<span class="summary-chip is-muted">当前未附加筛选条件</span>';

  resultSummary.innerHTML = `
    <span class="summary-text">${tabLabel}结果 ${filteredJobs.length} 条</span>
    <span class="summary-chip-list">${chipsHtml}</span>
  `;
}

function render() {
  syncToolbarState();
  syncListTabState();
  syncControlsFromState();
  buildStackFilters(dashboardState.jobs);

  const contextJobs = getQuickFilterContextJobs();
  const filteredJobs = getFilteredJobs();

  renderStats(contextJobs, filteredJobs);
  renderJobs(jobsList, filteredJobs);
  updateResultSummary(filteredJobs);
}

function applyQuickStatFilter(key) {
  if (!key) {
    return;
  }

  if (key === "reset-quick") {
    uiState.currentTab = "active";
    uiState.filters.roleFamily = "all";
    uiState.filters.remote = "all";
    uiState.filters.salaryOnly = false;
    render();
    setNotice("已恢复默认快捷筛选。", "neutral");
    return;
  }

  if (key === "tab-active") {
    uiState.currentTab = "active";
  }

  if (key === "tab-closed") {
    uiState.currentTab = "closed";
  }

  if (key === "tab-favorite") {
    uiState.currentTab = "favorite";
  }

  if (key === "role-frontend") {
    uiState.filters.roleFamily = uiState.filters.roleFamily === "前端" ? "all" : "前端";
  }

  if (key === "role-backend") {
    uiState.filters.roleFamily = uiState.filters.roleFamily === "后端" ? "all" : "后端";
  }

  if (key === "role-qa") {
    uiState.filters.roleFamily = uiState.filters.roleFamily === "测试 / QA" ? "all" : "测试 / QA";
  }

  if (key === "remote") {
    uiState.filters.remote = uiState.filters.remote === "remote" ? "all" : "remote";
  }

  if (key === "salary") {
    uiState.filters.salaryOnly = !uiState.filters.salaryOnly;
  }

  render();
}

async function loadDashboard() {
  const response = await fetch(`/api/dashboard?ts=${Date.now()}`, { cache: "no-store" });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Dashboard load failed");
  }
  const payload = await response.json();
  dashboardState = payload;

  populateSelect(locationFilter, uniqueValues(payload.jobs, "locationBucket"), "全部地点");
  populateSelect(roleFamilyFilter, uniqueValues(payload.jobs, "roleFamily"), "全部岗位方向");
  populateSelect(sourceFilter, uniqueValues(payload.jobs, "source"), "全部来源网站");
  populateSelect(japaneseFilter, uniqueValues(payload.jobs, "japanese_level"), "全部日语要求");
  populateSelect(englishFilter, uniqueValues(payload.jobs, "english_level"), "全部英语要求");

  render();
}

async function syncLatest() {
  syncLatestButton.disabled = true;
  setNotice("正在同步最新抓取结果...", "neutral");

  try {
    const response = await fetch("/api/sync/latest", { method: "POST" });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "Sync latest failed");
    }
    const payload = await response.json();
    await loadDashboard();
    setNotice(`同步完成：新增 ${payload.added} 条，更新 ${payload.updated} 条，移除 ${payload.removed ?? 0} 条。来源：${payload.inputPath}`, "success");
  } catch (error) {
    console.error(error);
    setNotice(`同步失败：${error.message}`, "error");
  } finally {
    syncLatestButton.disabled = false;
  }
}

async function crawlAllSources() {
  setCrawlButtonsDisabled(true);
  setNotice("正在启动自动抓取全站快速模式，系统会在约 55 秒预算内优先返回可用结果...", "neutral");

  try {
    const response = await fetch("/api/crawl/all", {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: JSON.stringify({
        maxDurationMs: 55000
      })
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      throw new Error(payload.error || "Start crawl all failed");
    }

    const payload = await response.json();

    if (payload.started === false) {
      setNotice("全站抓取任务已在运行中，正在等待最新结果...", "neutral");
    } else {
      setNotice("全站抓取快速模式已启动，正在后台处理，请稍候...", "neutral");
    }

    startCrawlStatusPolling();
  } catch (error) {
    console.error(error);
    setNotice(`全站抓取失败：${error.message}`, "error");
    stopCrawlStatusPolling();
    setCrawlButtonsDisabled(false);
  }
}

async function toggleFavorite(jobKey, nextFavorite) {
  const response = await fetch("/api/jobs/favorite", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      jobKey,
      favorite: nextFavorite
    })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Toggle favorite failed");
  }

  return response.json();
}

async function submitManualClose(jobKey) {
  const reason = await openManualCloseModal();
  if (!reason) {
    return null;
  }

  const response = await fetch("/api/jobs/manual-close", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({
      jobKey,
      reason
    })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Manual close failed");
  }

  return response.json();
}

async function reopenJob(jobKey) {
  const response = await fetch("/api/jobs/reopen", {
    method: "POST",
    headers: {
      "content-type": "application/json"
    },
    body: JSON.stringify({ jobKey })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || "Reopen job failed");
  }

  return response.json();
}

function stopCrawlStatusPolling() {
  if (crawlStatusPoller) {
    clearInterval(crawlStatusPoller);
    crawlStatusPoller = null;
  }
}

function formatIngestBreakdown(summary) {
  const breakdown = summary?.ingestBreakdown || {};
  const reasons = [];

  if ((breakdown.updatedExistingJobs ?? 0) > 0) {
    reasons.push(`其中 ${breakdown.updatedExistingJobs} 条命中了已有岗位，已按更新处理`);
  }

  if ((breakdown.closedBeforeSync ?? 0) > 0) {
    reasons.push(`${breakdown.closedBeforeSync} 条在核验阶段被判定为已关闭`);
  }

  if ((breakdown.failedBeforeSync ?? 0) > 0) {
    reasons.push(`${breakdown.failedBeforeSync} 条请求失败，按保留旧记录处理`);
  }

  if ((breakdown.skippedByBudget ?? 0) > 0) {
    reasons.push(`${breakdown.skippedByBudget} 条因为时间预算提前收口，留待下轮处理`);
  }

  if ((breakdown.unresolvedDiscovered ?? 0) > 0) {
    reasons.push(`${breakdown.unresolvedDiscovered} 条候选未形成新增入库，通常是去重或候选未通过最终验证`);
  }

  return reasons.length ? ` 未录入原因：${reasons.join("；")}。` : "";
}

async function pollCrawlStatus() {
  const response = await fetch("/api/crawl/status");
  if (!response.ok) {
    throw new Error("无法读取抓取任务状态");
  }

  const payload = await response.json();

  if (payload.state === "running") {
    setNotice(formatCrawlProgress(payload), "neutral");
    return;
  }

  if (payload.state === "completed") {
    stopCrawlStatusPolling();
    const summary = payload.summary || {};
    if (summary.skippedSync) {
      setNotice("全站抓取本轮没有完成任何真实岗位核验，系统已跳过数据库写入。建议稍后重试，或提高抓取预算。", "error");
      setCrawlButtonsDisabled(false);
      return;
    }

    await loadDashboard();
    setNotice(
      `全站抓取完成${summary.partial ? "（快速模式已按时间预算提前收口）" : ""}：发现新增候选 ${summary.discovered ?? 0} 条，真正写入数据库新增 ${summary.sync?.added ?? 0} 条，更新 ${summary.sync?.updated ?? 0} 条，关闭/移除 ${summary.sync?.removed ?? summary.removedClosed ?? 0} 条，网络失败保留 ${summary.retainedOnError ?? 0} 条，同步后共 ${summary.sync?.totalAfterSync ?? 0} 条。${formatIngestBreakdown(summary)}`,
      "success"
    );

    setCrawlButtonsDisabled(false);
    return;
  }

  if (payload.state === "error") {
    stopCrawlStatusPolling();
    setNotice(`全站抓取失败：${payload.error || "未知错误"}`, "error");
    setCrawlButtonsDisabled(false);
    return;
  }

  stopCrawlStatusPolling();
  setCrawlButtonsDisabled(false);
}

function startCrawlStatusPolling() {
  stopCrawlStatusPolling();
  void pollCrawlStatus().catch((error) => {
    console.error(error);
    setNotice(`全站抓取状态获取失败：${error.message}`, "error");
    setCrawlButtonsDisabled(false);
  });

  crawlStatusPoller = setInterval(() => {
    void pollCrawlStatus().catch((error) => {
      console.error(error);
      stopCrawlStatusPolling();
      setNotice(`全站抓取状态获取失败：${error.message}`, "error");
      setCrawlButtonsDisabled(false);
    });
  }, 3000);
}

function resetFilters() {
  if (searchRenderTimer) {
    window.clearTimeout(searchRenderTimer);
    searchRenderTimer = null;
  }
  uiState.filters = { ...defaultFilters };
  render();
  setNotice("筛选条件已重置。", "neutral");
}

function collapseFiltersOnScroll() {
  const beyondThreshold = window.scrollY > 180;

  if (beyondThreshold) {
    uiState.hasAutoCollapsed = true;
    if (!uiState.filtersCollapsed && !uiState.manualExpandedWhileStuck) {
      uiState.filtersCollapsed = true;
    }
    syncToolbarState();
    return;
  }

  if (uiState.hasAutoCollapsed || uiState.manualExpandedWhileStuck) {
    uiState.hasAutoCollapsed = false;
    uiState.manualExpandedWhileStuck = false;
    syncToolbarState();
  }
}

searchInput.addEventListener("input", (event) => {
  const nextValue = event.target.value;
  uiState.filters.search = nextValue;
  if (searchRenderTimer) {
    window.clearTimeout(searchRenderTimer);
  }

  searchRenderTimer = window.setTimeout(() => {
    render();
  }, 180);
});

locationFilter.addEventListener("change", (event) => {
  uiState.filters.location = event.target.value;
  render();
});

roleFamilyFilter.addEventListener("change", (event) => {
  uiState.filters.roleFamily = event.target.value;
  render();
});

sourceFilter.addEventListener("change", (event) => {
  uiState.filters.source = event.target.value;
  render();
});

remoteFilter.addEventListener("change", (event) => {
  uiState.filters.remote = event.target.value;
  render();
});

japaneseFilter.addEventListener("change", (event) => {
  uiState.filters.japanese = event.target.value;
  render();
});

englishFilter.addEventListener("change", (event) => {
  uiState.filters.english = event.target.value;
  render();
});

sortSelect.addEventListener("change", (event) => {
  uiState.filters.sort = event.target.value;
  render();
});

salaryOnlyFilter.addEventListener("change", (event) => {
  uiState.filters.salaryOnly = event.target.checked;
  render();
});

refreshButton.addEventListener("click", async () => {
  refreshButton.disabled = true;
  setNotice("正在刷新当前数据库数据...", "neutral");

  try {
    await loadDashboard();
    setNotice("数据已刷新。", "neutral");
  } catch (error) {
    console.error(error);
    setNotice(`刷新失败：${error.message}`, "error");
  } finally {
    refreshButton.disabled = false;
  }
});

syncLatestButton.addEventListener("click", () => {
  syncLatest();
});

crawlAllButton.addEventListener("click", () => {
  crawlAllSources();
});

jobsList.addEventListener("click", async (event) => {
  const actionButton = event.target.closest("[data-action]");
  if (!actionButton) {
    return;
  }

  const card = actionButton.closest(".job-card");
  const jobKey = card?.dataset.jobKey;
  if (!jobKey) {
    return;
  }

  const action = actionButton.dataset.action;
  const targetJob = dashboardState.jobs.find((job) => job.jobKey === jobKey);

  try {
    actionButton.disabled = true;

    if (action === "favorite") {
      await toggleFavorite(jobKey, !targetJob?.isFavorite);
      await loadDashboard();
      setNotice(targetJob?.isFavorite ? "已取消收藏岗位。" : "已收藏岗位。", "success");
      return;
    }

    if (action === "manual-close") {
      const result = await submitManualClose(jobKey);
      if (!result) {
        return;
      }
      dashboardState.jobs = dashboardState.jobs.map((job) =>
        job.jobKey === jobKey
          ? {
              ...job,
              ...result.job
            }
          : job
      );
      if (uiState.currentTab === "active") {
        render();
      }
      await loadDashboard();
      setNotice(`岗位已标记为${result.job.status_reason || "失效"}，并已移入已关闭列表。`, "success");
      return;
    }

    if (action === "reopen") {
      const result = await reopenJob(jobKey);
      dashboardState.jobs = dashboardState.jobs.map((job) =>
        job.jobKey === jobKey
          ? {
              ...job,
              ...result.job
            }
          : job
      );
      uiState.currentTab = "active";
      render();
      await loadDashboard();
      setNotice("岗位已取消关闭，并已回到当前岗位列表。", "success");
    }
  } catch (error) {
    console.error(error);
    setNotice(`操作失败：${error.message}`, "error");
  } finally {
    actionButton.disabled = false;
  }
});

listTabs?.addEventListener("click", (event) => {
  const button = event.target.closest(".list-tab");
  if (!button) {
    return;
  }

  const nextTab = button.dataset.tab;
  uiState.currentTab = ["active", "favorite", "closed"].includes(nextTab) ? nextTab : "active";
  render();
});

statsGrid?.addEventListener("click", (event) => {
  const button = event.target.closest("[data-quick-filter]");
  if (!button) {
    return;
  }

  applyQuickStatFilter(button.dataset.quickFilter);
});

stackFilterList?.addEventListener("click", (event) => {
  const button = event.target.closest(".stack-chip");
  if (!button) {
    return;
  }

  const stack = button.dataset.stack;
  if (!stack) {
    return;
  }

  const selected = new Set(uiState.filters.stacks);
  if (selected.has(stack)) {
    selected.delete(stack);
  } else {
    selected.add(stack);
  }

  uiState.filters.stacks = [...selected];
  render();
});

manualCloseModal?.addEventListener("click", (event) => {
  if (event.target === manualCloseModal) {
    closeManualCloseModal(null);
  }
});

manualCloseForm?.addEventListener("submit", (event) => {
  event.preventDefault();
  const selectedReason = manualCloseForm?.querySelector('input[name="manualCloseReason"]:checked')?.value || null;
  closeManualCloseModal(selectedReason);
});

manualCloseCancelButton?.addEventListener("click", () => {
  closeManualCloseModal(null);
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && !manualCloseModal?.hidden) {
    closeManualCloseModal(null);
  }
});

resetFiltersButton.addEventListener("click", () => {
  resetFilters();
});

toggleFiltersButton.addEventListener("click", () => {
  uiState.filtersCollapsed = !uiState.filtersCollapsed;
  if (uiState.hasAutoCollapsed) {
    uiState.manualExpandedWhileStuck = !uiState.filtersCollapsed;
  }
  syncToolbarState();
});

window.addEventListener("scroll", collapseFiltersOnScroll, { passive: true });

Promise.all([loadDashboard(), fetch("/api/crawl/status").then((response) => response.json())])
  .then(([, crawlStatus]) => {
    if (crawlStatus?.state === "running") {
      setCrawlButtonsDisabled(true);
      setNotice(formatCrawlProgress(crawlStatus), "neutral");
      startCrawlStatusPolling();
      return;
    }

    setNotice("看板已加载，可随时同步最新抓取结果。", "success");
  })
  .catch((error) => {
    console.error(error);
    setNotice("初始化加载失败，请检查服务状态。", "error");
  });
