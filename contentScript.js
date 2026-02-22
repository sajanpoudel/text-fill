const MAX_CONTEXT_CHARS = 5000;
const MAX_PAGE_CHARS = 6000;

const JOB_HINTS = [
  "job description",
  "responsibilities",
  "requirements",
  "qualifications",
  "what you will do",
  "what you'll do",
  "about the role",
  "about the job",
  "about this role",
  "the role",
  "your impact",
  "what we're looking for",
];

// Platform-specific selectors for better field detection
const PLATFORM_SELECTORS = {
  gmail: [
    'div[aria-label*="Message Body"]',
    'div[contenteditable="true"][aria-label*="Compose"]',
    'div[g_editable="true"]',
    'div[role="textbox"][aria-label*="Message"]',
    'div.editable[role="textbox"]',
  ],
  linkedin: [
    "div.msg-form__contenteditable",
    "div.msg-form__msg-content-container",
    'div.ql-editor[contenteditable="true"]',
    'div[data-placeholder*="Add a comment"]',
    'div[data-placeholder*="comment"]',
    'div[aria-label*="Add a comment"]',
    'div[aria-label*="Text editor"]',
    'div.comments-comment-box__form-container [contenteditable="true"]',
    'div.comments-comment-texteditor [contenteditable="true"]',
    'div.feed-shared-update-v2__comments-container [contenteditable="true"]',
    'div[data-placeholder*="Start a post"]',
    'div[aria-label*="Start a post"]',
    'div.share-creation-state__text-editor [contenteditable="true"]',
    'div[contenteditable="true"][role="textbox"]',
  ],
  facebook: [
    'div[contenteditable="true"][role="textbox"]',
    'div[aria-label*="Message"]',
    'div[aria-label*="Write a comment"]',
    'div[aria-label*="Write a reply"]',
    'div[aria-label*="Write a public comment"]',
    'div.notranslate[contenteditable="true"]',
  ],
  twitter: [
    'div[data-testid="tweetTextarea_0"]',
    'div[data-testid="tweetTextarea_0_label"]',
    'div[aria-label*="Post text"]',
    'div[aria-label*="Tweet text"]',
    'div[aria-label*="Add another Tweet"]',
    'div[aria-label*="Reply"]',
    'div[role="textbox"][data-block="true"]',
    'div.public-DraftEditor-content[contenteditable="true"]',
    'div.DraftEditor-root [contenteditable="true"]',
  ],
  threads: [
    'div[contenteditable="true"][role="textbox"]',
    'div[aria-label*="Reply"]',
    'div[aria-label*="Start a thread"]',
  ],
  instagram: [
    'textarea[aria-label*="Add a comment"]',
    'textarea[placeholder*="Add a comment"]',
    'div[contenteditable="true"][role="textbox"]',
  ],
  youtube: [
    'div[contenteditable="true"]#contenteditable-root',
    'div[aria-label*="Add a comment"]',
    'div[aria-label*="Add a public comment"]',
    "div#placeholder-area",
  ],
  reddit: [
    'div[contenteditable="true"][role="textbox"]',
    'textarea[placeholder*="What are your thoughts"]',
    'div.public-DraftEditor-content[contenteditable="true"]',
  ],
  general: [
    "textarea",
    'input[type="text"]',
    'input[type="search"]',
    'input[type="url"]',
    "input:not([type])",
    '[contenteditable="true"]',
    '[contenteditable=""]',
    '[role="textbox"]',
    "div.ql-editor",
    "div.tox-edit-area",
    "div.CodeMirror-code",
  ],
};

const state = {
  activeField: null,
  buttons: new Map(),
  cachedJobDescription: null,
  currentJobUrl: null,
  capturedContexts: [], // [{ id, title, url, hostname, text, time, active }] — multi-page context library
  scanScheduled: false,
  observer: null,
  idleCallbackId: null,
  scrollTicking: false,
};

const normalizeText = (text) => text.replace(/\s+/g, " ").trim();

const getFromSessionStorage = (key) => {
  try {
    return sessionStorage.getItem(key);
  } catch (e) {
    console.warn("[TextFill] SessionStorage access denied:", e.message);
    return null;
  }
};

const setToSessionStorage = (key, value) => {
  try {
    sessionStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.warn("[TextFill] SessionStorage write failed:", e.message);
    return false;
  }
};

const extractSectionText = (element, maxLength = Infinity) => {
  if (!element) return "";
  let text = element.innerText || "";
  if (text.length > maxLength) text = text.substring(0, maxLength);
  return normalizeText(text);
};

// ─── Job Description Extraction ───────────────────────────────────────────────

const findJobSections = (searchAll = false) => {
  const sections = [];
  const selector = searchAll
    ? "h1, h2, h3, h4, strong, b, [role='heading']"
    : "h1, h2, h3, h4, strong, b";
  const candidates = Array.from(document.querySelectorAll(selector));

  candidates.forEach((heading) => {
    const headingText = normalizeText(
      heading.innerText || ""
    ).toLowerCase();
    if (!headingText) return;
    if (JOB_HINTS.some((hint) => headingText.includes(hint))) {
      const container =
        heading.closest(
          "section, article, div, [role='tabpanel']"
        ) || heading.parentElement;
      const text = extractSectionText(container);
      if (text && text.length > 100) sections.push(text);
    }
  });

  return sections;
};

const findHiddenJobContent = () => {
  const ashbyOverview = document.querySelector(
    '[data-tab="overview"], [aria-labelledby*="overview"], [id*="overview"], ' +
      '[class*="overview"], [class*="job-description"], [class*="jobDescription"]'
  );
  if (ashbyOverview) {
    const text = extractSectionText(ashbyOverview);
    if (text && text.length > 200) return text;
  }

  const tabPanels = document.querySelectorAll(
    '[role="tabpanel"], [class*="tab-panel"], [class*="tabpanel"], ' +
      '[class*="TabPanel"], [data-testid*="tab"]'
  );
  for (const panel of tabPanels) {
    const text = extractSectionText(panel);
    const lowerText = text.toLowerCase();
    if (
      text.length > 300 &&
      JOB_HINTS.some((hint) => lowerText.includes(hint))
    ) {
      return text;
    }
  }

  const hiddenContainers = document.querySelectorAll(
    '[hidden], [aria-hidden="true"], [style*="display: none"], ' +
      '[style*="display:none"], .hidden, .hide'
  );
  for (const container of hiddenContainers) {
    const text = extractSectionText(container);
    const lowerText = text.toLowerCase();
    if (
      text.length > 300 &&
      JOB_HINTS.some((hint) => lowerText.includes(hint))
    ) {
      return text;
    }
  }

  return null;
};

const findOverviewTabButton = () => {
  const directMatch = document.querySelector(
    '[data-tab="overview"], [aria-controls*="overview"], ' +
      'button[aria-label*="Overview" i], [role="tab"][aria-label*="Overview" i]'
  );
  if (directMatch) return directMatch;

  const tabButtons = document.querySelectorAll(
    '[role="tab"], button[class*="tab"], a[class*="tab"]'
  );
  for (const btn of tabButtons) {
    const text = btn.textContent?.trim().toLowerCase();
    if (
      text === "overview" ||
      text === "job description" ||
      text === "description"
    ) {
      return btn;
    }
  }
  return null;
};

const findApplicationTabButton = () => {
  const allButtons = document.querySelectorAll('button, a, [role="tab"]');
  for (const btn of allButtons) {
    const text = btn.textContent?.trim().toLowerCase();
    if (text === "application" || text === "apply" || text === "apply now") {
      return btn;
    }
  }
  return null;
};

const autoFetchJobDescription = () => {
  return new Promise((resolve) => {
    const overviewBtn = findOverviewTabButton();
    const applicationBtn = findApplicationTabButton();

    if (!overviewBtn) {
      resolve(null);
      return;
    }

    const scrollPos = window.scrollY;
    overviewBtn.click();

    const extractAndResolve = () => {
      const sections = findJobSections(false);
      let jobDescription = null;

      if (sections.length > 0) {
        jobDescription = sections.join("\n\n").slice(0, MAX_CONTEXT_CHARS);
      } else {
        const main = document.querySelector(
          'main, article, [role="tabpanel"]:not([hidden])'
        );
        if (main) jobDescription = extractSectionText(main, MAX_CONTEXT_CHARS);
      }

      if (applicationBtn) applicationBtn.click();
      setTimeout(() => window.scrollTo(0, scrollPos), 100);

      if (jobDescription && jobDescription.length > 200) {
        const storageKey = getJobStorageKey();
        cacheJobDescription(storageKey, jobDescription);
      }
      resolve(jobDescription);
    };

    const targetPanel = document.querySelector(
      '[role="tabpanel"]:not([hidden])'
    );
    if (!targetPanel) {
      setTimeout(extractAndResolve, 500);
      return;
    }

    const observer = new MutationObserver(() => {
      if (targetPanel.textContent.length > 500) {
        observer.disconnect();
        extractAndResolve();
      }
    });
    observer.observe(targetPanel, { childList: true, subtree: true });
    setTimeout(() => {
      observer.disconnect();
      extractAndResolve();
    }, 2000);
  });
};

const isFormContent = (text) => {
  if (!text) return true;
  const formIndicators = [
    "upload your resume",
    "autofill from resume",
    "full name",
    "preferred name",
    "email",
    "phone number",
    "submit application",
    "upload file",
    "drag and drop",
    "personal information",
  ];
  const lowerText = text.toLowerCase();
  const matches = formIndicators.filter((indicator) =>
    lowerText.includes(indicator)
  );
  return matches.length >= 3;
};

const getJobStorageKey = () => {
  const hostname = window.location.hostname.toLowerCase();
  const pathname = window.location.pathname;
  const search = window.location.search;

  if (hostname.includes("myworkdayjobs.com")) {
    const pathSegments = pathname.split("/").filter(Boolean);
    const jobIdFromPath = pathSegments.find((segment) =>
      /^\d{5,}$/.test(segment)
    );
    if (jobIdFromPath)
      return `tfa_job_workday_${hostname}_${jobIdFromPath}`;
    const urlParams = new URLSearchParams(search);
    const jobIdFromQuery =
      urlParams.get("jobId") || urlParams.get("job_id");
    if (jobIdFromQuery)
      return `tfa_job_workday_${hostname}_${jobIdFromQuery}`;
  }

  return `tfa_job_${hostname}${pathname}`;
};

const checkUrlChanged = () => {
  const currentUrl = window.location.href;
  if (state.currentJobUrl && state.currentJobUrl !== currentUrl) {
    state.cachedJobDescription = null;
  }
  state.currentJobUrl = currentUrl;
};

const extractJobDescription = () => {
  checkUrlChanged();
  if (state.cachedJobDescription) return state.cachedJobDescription;

  const storageKey = getJobStorageKey();
  const cached = getFromSessionStorage(storageKey);
  if (cached && cached.length > 200) {
    state.cachedJobDescription = cached;
    return cached;
  }

  let sections = findJobSections(false);
  if (sections.length > 0) {
    const result = sections.join("\n\n").slice(0, MAX_CONTEXT_CHARS);
    cacheJobDescription(storageKey, result);
    return result;
  }

  const hiddenContent = findHiddenJobContent();
  if (hiddenContent) {
    const result = hiddenContent.slice(0, MAX_CONTEXT_CHARS);
    cacheJobDescription(storageKey, result);
    return result;
  }

  sections = findJobSections(true);
  if (sections.length > 0) {
    const result = sections.join("\n\n").slice(0, MAX_CONTEXT_CHARS);
    cacheJobDescription(storageKey, result);
    return result;
  }

  const main = document.querySelector("main, article") || document.body;
  return extractSectionText(main).slice(0, MAX_CONTEXT_CHARS);
};

const cacheJobDescription = (key, text) => {
  if (text && text.length > 200) {
    state.cachedJobDescription = text;
    setToSessionStorage(key, text);
  }
};

let lastUrl = window.location.href;

const setupUrlChangeDetection = () => {
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function (...args) {
    originalPushState.apply(this, args);
    handleUrlChange();
  };
  history.replaceState = function (...args) {
    originalReplaceState.apply(this, args);
    handleUrlChange();
  };

  window.addEventListener("popstate", handleUrlChange);
  window.addEventListener("hashchange", handleUrlChange);
};

const handleUrlChange = () => {
  const currentUrl = window.location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    state.cachedJobDescription = null;
    state.currentJobUrl = currentUrl;
    if (typeof proactivelyCacheJobDescription === "function") {
      proactivelyCacheJobDescription();
    }
    if (typeof scheduleScan === "function") {
      scheduleScan();
    }
  }
};

const detectJobPlatform = () => {
  const hostname = window.location.hostname.toLowerCase();
  const platforms = {
    ashby:
      hostname.includes("ashbyhq.com") ||
      hostname.includes("jobs.ashbyhq.com"),
    greenhouse:
      hostname.includes("greenhouse.io") ||
      hostname.includes("boards.greenhouse.io"),
    lever:
      hostname.includes("lever.co") ||
      hostname.includes("jobs.lever.co"),
    workable:
      hostname.includes("workable.com") ||
      hostname.includes("apply.workable.com"),
    workday:
      hostname.includes("myworkdayjobs.com") ||
      hostname.includes("wd1.myworkdayjobs.com") ||
      hostname.includes("wd5.myworkdayjobs.com"),
    jobvite: hostname.includes("jobvite.com"),
    smartrecruiters: hostname.includes("smartrecruiters.com"),
    icims: hostname.includes("icims.com"),
  };
  for (const [platform, isMatch] of Object.entries(platforms)) {
    if (isMatch) return platform;
  }
  return null;
};

const proactivelyCacheJobDescription = async () => {
  try {
    const platform = detectJobPlatform();
    if (!platform) return;

    await new Promise((resolve) => setTimeout(resolve, 1500));
    const storageKey = getJobStorageKey();
    const cached = getFromSessionStorage(storageKey);
    if (cached && cached.length > 200) return;

    if (platform === "workday") {
      const isJobDetailsPage =
        document.querySelector(
          '[data-automation-id="jobPostingDescription"]'
        ) ||
        document.querySelector(".jobdescription") ||
        document.querySelector("#job-description") ||
        document.querySelector(
          '[data-automation-id="jobPostingHeader"]'
        );
      const hasApplyButton =
        document.querySelector(
          '[data-automation-id="applyButton"]'
        ) ||
        Array.from(document.querySelectorAll("button")).find((btn) =>
          btn.textContent.toLowerCase().includes("apply")
        );
      if (isJobDetailsPage || hasApplyButton) {
        const description = extractJobDescription();
        if (description && description.length > 200) {
          cacheJobDescription(storageKey, description);
          return;
        }
      }
    }

    if (
      platform === "ashby" ||
      platform === "greenhouse" ||
      platform === "lever"
    ) {
      const overviewBtn = findOverviewTabButton();
      if (overviewBtn) {
        const fetched = await autoFetchJobDescription();
        if (fetched && fetched.length > 200) return;
      }
    }

    const description = extractJobDescription();
    if (description && description.length > 200 && !isFormContent(description)) {
      cacheJobDescription(storageKey, description);
    }
  } catch (error) {
    console.error("[TextFill] Proactive caching failed:", error.message);
  }
};

// ─── Platform Detection ────────────────────────────────────────────────────────

const detectPlatformKey = () => {
  const hostname = window.location.hostname.toLowerCase();
  if (hostname.includes("mail.google.com")) return "gmail";
  if (hostname.includes("linkedin.com")) return "linkedin";
  if (hostname.includes("twitter.com") || hostname.includes("x.com"))
    return "twitter";
  if (hostname.includes("facebook.com")) return "facebook";
  if (hostname.includes("messenger.com")) return "messenger";
  if (hostname.includes("reddit.com")) return "reddit";
  if (hostname.includes("youtube.com")) return "youtube";
  if (hostname.includes("instagram.com")) return "instagram";
  if (hostname.includes("threads.net")) return "threads";
  if (hostname.includes("slack.com")) return "slack";
  if (hostname.includes("discord.com")) return "discord";
  if (hostname.includes("notion.so") || hostname.includes("notion.com"))
    return "notion";
  if (hostname.includes("docs.google.com")) return "google_docs";

  const jobBoards = [
    "greenhouse.io",
    "lever.co",
    "ashbyhq.com",
    "myworkdayjobs.com",
    "workable.com",
    "jobvite.com",
    "smartrecruiters.com",
    "icims.com",
    "taleo.net",
    "bamboohr.com",
  ];
  if (jobBoards.some((board) => hostname.includes(board)))
    return "job_application";
  return "general";
};

// ─── Compose Boundary Detection (context isolation) ───────────────────────────
// Finds the tightest container that represents what the user is currently
// composing — prevents reading unrelated emails, chats, or conversations.

const getComposeBoundary = (field) => {
  const hostname = window.location.hostname.toLowerCase();

  // Gmail: Only the active compose/reply window
  if (hostname.includes("mail.google.com")) {
    return (
      field.closest('[role="dialog"]') ||
      field.closest("td.Ar.Au") || // Compose table cell
      field.closest("form") ||
      null
    );
  }

  // LinkedIn: Only the active message, post, or comment editor
  if (hostname.includes("linkedin.com")) {
    return (
      field.closest(".msg-form__container") ||
      field.closest('[role="dialog"]') ||
      field.closest(".share-creation-state") ||
      field.closest(".comments-comment-box") ||
      field.closest(".feed-shared-update-v2__comments-container") ||
      null
    );
  }

  // Twitter/X: Only the tweet compose area
  if (
    hostname.includes("twitter.com") ||
    hostname.includes("x.com")
  ) {
    return (
      field.closest('[role="dialog"]') ||
      field.closest(".DraftEditor-root")?.closest("div") ||
      null
    );
  }

  // Facebook/Messenger
  if (
    hostname.includes("facebook.com") ||
    hostname.includes("messenger.com")
  ) {
    return (
      field.closest('[role="dialog"]') ||
      field.closest('[role="main"]') ||
      null
    );
  }

  // Generic: prefer dialog > form
  return (
    field.closest('[role="dialog"]') ||
    field.closest("form") ||
    null
  );
};

// ─── Context Extraction ────────────────────────────────────────────────────────

const extractPageContext = (field) => {
  const title = document.title || "";
  const url = window.location.href || "";
  const metaDescription =
    document.querySelector("meta[name='description']")?.content || "";

  // Use compose boundary to isolate context — avoids reading other emails/chats
  const composeBoundary = getComposeBoundary(field);

  let contextText = "";
  let pageText = "";

  if (composeBoundary) {
    // Only read within the compose/reply window
    contextText = extractSectionText(composeBoundary, 3000);
  } else {
    contextText = extractSectionText(
      field.closest("section, form, div"),
      2000
    );
    pageText = extractSectionText(document.body, MAX_PAGE_CHARS);
  }

  // For job application platforms, append job description
  const platformKey = detectPlatformKey();
  let jobContext = "";
  if (platformKey === "job_application") {
    const jobDesc = extractJobDescription();
    if (jobDesc && !isFormContent(jobDesc)) {
      jobContext = jobDesc.slice(0, 3000);
    }
  }

  const parts = [
    title ? `Page: ${title}` : "",
    url ? `URL: ${url}` : "",
    metaDescription ? `Description: ${metaDescription}` : "",
    contextText ? `Context:\n${contextText}` : "",
    pageText ? `Page content:\n${pageText}` : "",
    jobContext ? `Job description:\n${jobContext}` : "",
  ].filter(Boolean);

  return parts.join("\n\n").slice(0, MAX_PAGE_CHARS);
};

const getQuestionText = (field) => {
  if (!(field instanceof Element)) return "";

  const ariaLabel = field.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel.trim();

  const ariaLabelledBy = field.getAttribute("aria-labelledby");
  if (typeof ariaLabelledBy === "string" && ariaLabelledBy.trim()) {
    const labelled = ariaLabelledBy
      .trim()
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter((el) => el && typeof el.textContent === "string")
      .map((el) => el.textContent.trim())
      .filter((t) => t)
      .join(" ")
      .trim();
    if (labelled) return labelled;
  }

  const label = document.querySelector(`label[for="${field.id}"]`);
  if (label?.innerText) return label.innerText.trim();

  const placeholder =
    field.placeholder ||
    field.getAttribute("data-placeholder") ||
    field.getAttribute("aria-placeholder") ||
    "";
  if (placeholder) return placeholder.trim();

  const describedBy = field.getAttribute("aria-describedby");
  if (describedBy) {
    const described = describedBy
      .split(" ")
      .map((id) => document.getElementById(id)?.innerText || "")
      .join(" ")
      .trim();
    if (described) return described;
  }

  const parentText = field.closest("section, form, div")?.innerText || "";
  return normalizeText(parentText.split("\n").slice(0, 3).join(" "));
};

const getFieldValue = (field) => {
  if (field?.isContentEditable) return field.textContent || "";
  return field?.value || "";
};

const getLogoUrl = () => chrome.runtime.getURL("logo.png");

// ─── Context Library (multi-page context capture) ─────────────────────────────

let _fab = null;
let _contextPanel = null;

const capturePageContext = async (button = null) => {
  if (button) setButtonLoading(button);
  try {
    const title = document.title || "";
    const url = window.location.href || "";
    const hostname = window.location.hostname || "";
    const pageText = extractSectionText(document.body, 4000);
    const id = `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const entry = { id, title, url, hostname, text: pageText, time: Date.now(), active: true };

    // Deduplicate by URL — update if already saved
    const existingIdx = state.capturedContexts.findIndex((c) => c.url === url);
    if (existingIdx >= 0) {
      state.capturedContexts[existingIdx] = entry;
    } else {
      state.capturedContexts.push(entry);
    }

    await chrome.storage.local.set({ capturedContexts: state.capturedContexts });
    if (button) resetButton(button);
    updateContextIndicators();
    showToast(`Context saved: ${(title || hostname).slice(0, 40)}`);
  } catch (err) {
    if (button) resetButton(button);
    showToast("Failed to capture context", true);
  }
};

const clearCapturedContext = async (id = null) => {
  if (id) {
    state.capturedContexts = state.capturedContexts.filter((c) => c.id !== id);
  } else {
    state.capturedContexts = [];
  }
  await chrome.storage.local.set({ capturedContexts: state.capturedContexts });
  updateContextIndicators();
  if (!id) showToast("All contexts cleared");
};

const toggleContextActive = async (id) => {
  const ctx = state.capturedContexts.find((c) => c.id === id);
  if (ctx) {
    ctx.active = !ctx.active;
    await chrome.storage.local.set({ capturedContexts: state.capturedContexts });
    updateContextIndicators();
  }
};

// Update the dot on a single field button
const updateContextIndicator = (button) => {
  const activeCount = state.capturedContexts.filter((c) => c.active).length;
  let dot = button.querySelector(".tfa-context-dot");
  if (activeCount > 0) {
    if (!dot) {
      dot = document.createElement("span");
      dot.className = "tfa-context-dot";
      button.appendChild(dot);
    }
    dot.textContent = activeCount > 1 ? String(activeCount) : "";
  } else {
    if (dot) dot.remove();
  }
};

// Update all field buttons + FAB badge
const updateContextIndicators = () => {
  state.buttons.forEach((btn) => updateContextIndicator(btn));
  const totalCount = state.capturedContexts.length;
  if (_fab) {
    let badge = _fab.querySelector(".tfa-fab-badge");
    if (badge) {
      badge.textContent = totalCount;
      badge.style.display = totalCount > 0 ? "flex" : "none";
    }
  }
  // Refresh panel if open
  if (_contextPanel && document.body.contains(_contextPanel)) {
    refreshContextPanel(_contextPanel);
  }
};

// ─── Floating FAB & Context Panel ─────────────────────────────────────────────

const positionContextPanel = (panel) => {
  if (!_fab) return;
  const fabRect = _fab.getBoundingClientRect();
  const PANEL_W = 288;
  const right = Math.max(window.innerWidth - fabRect.right, 8);
  const bottom = window.innerHeight - fabRect.top + 8;
  panel.style.right = `${right}px`;
  panel.style.bottom = `${bottom}px`;
  panel.style.maxWidth = `${Math.min(PANEL_W, window.innerWidth - 16)}px`;
};

const relativeTime = (ts) => {
  const diff = Date.now() - ts;
  if (diff < 60000) return "just now";
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  return `${Math.floor(diff / 86400000)}d ago`;
};

const renderContextList = (listEl) => {
  listEl.innerHTML = "";
  if (state.capturedContexts.length === 0) {
    const empty = document.createElement("div");
    empty.className = "tfa-cp-empty";
    empty.textContent = "No contexts yet — browse to a page and click \"+\".";
    listEl.appendChild(empty);
    return;
  }

  [...state.capturedContexts].reverse().forEach((ctx) => {
    const row = document.createElement("div");
    row.className = `tfa-cp-row${ctx.active ? "" : " tfa-cp-row-inactive"}`;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "tfa-cp-check";
    checkbox.checked = ctx.active;
    checkbox.title = ctx.active ? "Deactivate" : "Activate";
    checkbox.addEventListener("change", async () => {
      await toggleContextActive(ctx.id);
    });

    const avatar = document.createElement("span");
    avatar.className = "tfa-cp-avatar";
    avatar.textContent = (ctx.hostname || ctx.title || "?").charAt(0).toUpperCase();

    const info = document.createElement("div");
    info.className = "tfa-cp-info";

    const titleEl = document.createElement("span");
    titleEl.className = "tfa-cp-item-title";
    titleEl.textContent = (ctx.title || ctx.hostname || ctx.url).slice(0, 40);
    titleEl.title = ctx.url;

    const metaEl = document.createElement("span");
    metaEl.className = "tfa-cp-item-meta";
    metaEl.textContent = `${ctx.hostname} · ${relativeTime(ctx.time)}`;

    info.appendChild(titleEl);
    info.appendChild(metaEl);

    const del = document.createElement("button");
    del.className = "tfa-cp-del";
    del.title = "Remove";
    del.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    del.addEventListener("click", async (e) => {
      e.stopPropagation();
      await clearCapturedContext(ctx.id);
    });

    row.appendChild(checkbox);
    row.appendChild(avatar);
    row.appendChild(info);
    row.appendChild(del);
    listEl.appendChild(row);
  });
};

const refreshContextPanel = (panel) => {
  const list = panel.querySelector(".tfa-cp-list");
  if (list) renderContextList(list);

  const footer = panel.querySelector(".tfa-cp-footer");
  if (state.capturedContexts.length > 0 && !footer) {
    const footerEl = document.createElement("div");
    footerEl.className = "tfa-cp-footer";
    const clearAll = document.createElement("button");
    clearAll.className = "tfa-cp-clear-all";
    clearAll.textContent = "Delete all";
    clearAll.addEventListener("click", async () => { await clearCapturedContext(); });
    footerEl.appendChild(clearAll);
    panel.appendChild(footerEl);
  } else if (state.capturedContexts.length === 0 && footer) {
    footer.remove();
  }
};

const closeContextPanel = () => {
  if (_contextPanel && document.body.contains(_contextPanel)) _contextPanel.remove();
  _contextPanel = null;
};

const showContextPanel = () => {
  closeContextPanel();
  closeAllModals();

  const panel = document.createElement("div");
  panel.className = "tfa-context-panel";
  if (isPageDark()) panel.dataset.dark = "1";

  // Header
  const header = document.createElement("div");
  header.className = "tfa-cp-header";

  const titleSpan = document.createElement("span");
  titleSpan.className = "tfa-cp-title";
  titleSpan.textContent = "Context Library";
  header.appendChild(titleSpan);

  const addBtn = document.createElement("button");
  addBtn.className = "tfa-cp-add-btn";
  addBtn.textContent = "+ Add this page";
  addBtn.addEventListener("click", async () => { await capturePageContext(); });
  header.appendChild(addBtn);
  panel.appendChild(header);

  // List
  const list = document.createElement("div");
  list.className = "tfa-cp-list";
  renderContextList(list);
  panel.appendChild(list);

  // Footer
  if (state.capturedContexts.length > 0) {
    const footerEl = document.createElement("div");
    footerEl.className = "tfa-cp-footer";
    const clearAll = document.createElement("button");
    clearAll.className = "tfa-cp-clear-all";
    clearAll.textContent = "Delete all";
    clearAll.addEventListener("click", async () => { await clearCapturedContext(); });
    footerEl.appendChild(clearAll);
    panel.appendChild(footerEl);
  }

  document.body.appendChild(panel);
  positionContextPanel(panel);
  _contextPanel = panel;

  setTimeout(() => {
    const outside = (e) => {
      if (!panel.contains(e.target) && e.target !== _fab) {
        closeContextPanel();
        document.removeEventListener("click", outside, true);
      }
    };
    document.addEventListener("click", outside, true);
  }, 50);
};

const toggleContextPanel = () => {
  if (_contextPanel && document.body.contains(_contextPanel)) {
    closeContextPanel();
  } else {
    showContextPanel();
  }
};

const createFloatingFAB = () => {
  if (_fab && document.body.contains(_fab)) return;

  _fab = document.createElement("button");
  _fab.className = "tfa-fab";
  _fab.type = "button";
  _fab.title = "Context library — save pages to use as AI context";

  const img = document.createElement("img");
  img.src = getLogoUrl();
  img.alt = "Context";
  img.className = "tfa-logo";
  _fab.appendChild(img);

  const badge = document.createElement("span");
  badge.className = "tfa-fab-badge";
  badge.style.display = "none";
  _fab.appendChild(badge);

  _fab.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    toggleContextPanel();
  });

  document.body.appendChild(_fab);

  // Set initial badge
  const count = state.capturedContexts.length;
  if (count > 0) { badge.textContent = count; badge.style.display = "flex"; }
};

// ─── Button State Management ───────────────────────────────────────────────────

const setButtonLoading = (button) => {
  button.disabled = true;
  button.title = "Generating...";

  const overlay = document.createElement("div");
  overlay.className = "tfa-loading-overlay";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", "tfa-spin");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2");

  const circle = document.createElementNS(
    "http://www.w3.org/2000/svg",
    "circle"
  );
  circle.setAttribute("cx", "12");
  circle.setAttribute("cy", "12");
  circle.setAttribute("r", "10");
  circle.setAttribute("stroke-opacity", "0.3");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M12 2a10 10 0 0 1 10 10");

  svg.appendChild(circle);
  svg.appendChild(path);
  overlay.appendChild(svg);
  button.appendChild(overlay);
};

const setButtonSuccess = (button) => {
  const loadingOverlay = button.querySelector(".tfa-loading-overlay");
  if (loadingOverlay) loadingOverlay.remove();

  const successOverlay = document.createElement("div");
  successOverlay.className = "tfa-success-overlay";
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "2.5");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", "M20 6L9 17l-5-5");
  svg.appendChild(path);
  successOverlay.appendChild(svg);
  button.appendChild(successOverlay);

  // Re-enable after animation — this is the critical fix for the spinning bug
  setTimeout(() => {
    if (successOverlay.parentElement) successOverlay.remove();
    button.disabled = false;
    button.title = "Fill with AI";
  }, 1500);
};

const resetButton = (button) => {
  const overlay = button.querySelector(
    ".tfa-loading-overlay, .tfa-success-overlay"
  );
  if (overlay) overlay.remove();
  button.disabled = false;
  button.title = "Fill with AI";
};

// ─── Modal System ──────────────────────────────────────────────────────────────

let _buttonIdCounter = 0;

const getButtonId = (button) => {
  if (!button.dataset.tfaId) {
    button.dataset.tfaId = String(++_buttonIdCounter);
  }
  return button.dataset.tfaId;
};

const getModalForButton = (button) =>
  document.querySelector(
    `.tfa-modal[data-tfa-for="${getButtonId(button)}"]`
  );

const closeModalForButton = (button) => {
  const modal = getModalForButton(button);
  if (modal) modal.remove();
  delete button.dataset.modalOpen;
};

const closeAllModals = () => {
  document.querySelectorAll(".tfa-modal").forEach((m) => m.remove());
  state.buttons.forEach((btn) => delete btn.dataset.modalOpen);
};

const positionModal = (modal, button) => {
  const btnRect = button.getBoundingClientRect();
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;
  const MODAL_W = 224;
  const MODAL_H_ESTIMATE = 220;

  // Default: align right edge of modal with button, below button
  let left = btnRect.right + window.scrollX - MODAL_W;
  let top = btnRect.bottom + window.scrollY + 6;

  // Clamp horizontally
  if (left < 8) left = 8;
  if (left + MODAL_W > viewportW - 8) left = viewportW - MODAL_W - 8;

  // If too close to bottom, show above button
  if (top + MODAL_H_ESTIMATE > viewportH + window.scrollY - 8) {
    top = btnRect.top + window.scrollY - MODAL_H_ESTIMATE - 6;
  }

  modal.style.position = "absolute";
  modal.style.top = `${Math.max(top, window.scrollY + 8)}px`;
  modal.style.left = `${Math.max(left, 8)}px`;
};

// Detect if the page is using a dark background (for modal theming)
const isPageDark = () => {
  try {
    const bg = window.getComputedStyle(document.body).backgroundColor;
    const m = bg.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
    if (!m) return window.matchMedia("(prefers-color-scheme: dark)").matches;
    const luma = (0.299 * +m[1] + 0.587 * +m[2] + 0.114 * +m[3]) / 255;
    return luma < 0.5;
  } catch (_) {
    return window.matchMedia("(prefers-color-scheme: dark)").matches;
  }
};

const showModal = (field, button) => {
  closeAllModals();

  const hasContent = getFieldValue(field).trim().length > 10;
  const activeCount = state.capturedContexts.filter((c) => c.active).length;
  const alreadySaved = state.capturedContexts.some((c) => c.url === window.location.href);

  const modal = document.createElement("div");
  modal.className = "tfa-modal";
  modal.dataset.tfaFor = getButtonId(button);
  if (isPageDark()) modal.dataset.dark = "1";
  button.dataset.modalOpen = "true";

  // Instruction input at top
  const inputRow = document.createElement("div");
  inputRow.className = "tfa-modal-input-row";
  const instructionInput = document.createElement("input");
  instructionInput.type = "text";
  instructionInput.className = "tfa-modal-input";
  instructionInput.placeholder = "Optional instruction...";
  inputRow.appendChild(instructionInput);
  modal.appendChild(inputRow);

  // Action buttons
  const actions = [];

  actions.push({
    icon: "✦",
    label: "Generate",
    action: "generate",
    primary: true,
  });

  if (hasContent) {
    actions.push({ icon: "↺", label: "Rewrite & improve", action: "rewrite" });
    actions.push({ icon: "↓", label: "Make shorter", action: "shorten" });
    actions.push({ icon: "↗", label: "Expand", action: "expand" });
  }

  {
    const ctxLabel = activeCount > 0
      ? `Add page · ${activeCount} active`
      : alreadySaved ? "Update page context" : "Add page to context";
    actions.push({
      icon: "📋",
      label: ctxLabel,
      action: "captureContext",
      secondary: true,
    });
  }

  // Settings link at the bottom
  actions.push({ icon: "⚙", label: "Settings", action: "settings", settings: true });

  const actionsDiv = document.createElement("div");
  actionsDiv.className = "tfa-modal-actions";

  actions.forEach(({ icon, label, action, primary, secondary, settings: isSettings }) => {
    const btn = document.createElement("button");
    btn.className = [
      "tfa-modal-btn",
      primary    ? "tfa-modal-btn-primary"  : "",
      secondary  ? "tfa-modal-btn-secondary": "",
      isSettings ? "tfa-modal-btn-settings" : "",
    ]
      .filter(Boolean)
      .join(" ");

    const iconEl = document.createElement("span");
    iconEl.className = "tfa-modal-icon";
    iconEl.textContent = icon;

    const labelEl = document.createElement("span");
    labelEl.textContent = label;

    btn.appendChild(iconEl);
    btn.appendChild(labelEl);

    btn.addEventListener("click", async (e) => {
      e.preventDefault();
      e.stopPropagation();

      const instruction = instructionInput.value.trim();
      closeModalForButton(button);

      if (action === "settings") {
        chrome.runtime.sendMessage({ type: "openSettings" });
      } else if (action === "captureContext") {
        await capturePageContext(button);
      } else {
        await generateAndFill(field, button, { action, instruction });
      }
    });

    actionsDiv.appendChild(btn);

    // Separator before context action
    if (action === "captureContext") {
      const sep = actionsDiv.querySelector(".tfa-modal-sep");
      if (!sep) {
        const divEl = document.createElement("div");
        divEl.className = "tfa-modal-sep";
        actionsDiv.insertBefore(divEl, btn);
      }
    }

    // Separator before settings
    if (isSettings) {
      const sepBefore = document.createElement("div");
      sepBefore.className = "tfa-modal-sep";
      actionsDiv.insertBefore(sepBefore, btn);
    }
  });

  modal.appendChild(actionsDiv);

  // Position and mount
  document.body.appendChild(modal);
  positionModal(modal, button);

  // Focus instruction input
  setTimeout(() => instructionInput.focus(), 10);

  // Close on outside click
  const outsideHandler = (e) => {
    if (!modal.contains(e.target) && e.target !== button) {
      closeModalForButton(button);
      document.removeEventListener("click", outsideHandler, true);
      document.removeEventListener("keydown", escHandler);
    }
  };

  // Close on Escape
  const escHandler = (e) => {
    if (e.key === "Escape") {
      closeModalForButton(button);
      document.removeEventListener("click", outsideHandler, true);
      document.removeEventListener("keydown", escHandler);
    }
  };

  // Enter on input = generate
  instructionInput.addEventListener("keydown", async (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const instruction = instructionInput.value.trim();
      closeModalForButton(button);
      document.removeEventListener("click", outsideHandler, true);
      document.removeEventListener("keydown", escHandler);
      await generateAndFill(field, button, {
        action: "generate",
        instruction,
      });
    }
  });

  setTimeout(() => {
    document.addEventListener("click", outsideHandler, true);
    document.addEventListener("keydown", escHandler);
  }, 50);
};

const toggleModal = (field, button) => {
  if (button.dataset.modalOpen === "true") {
    closeModalForButton(button);
  } else {
    showModal(field, button);
  }
};

// ─── Button Creation ───────────────────────────────────────────────────────────

const getOrCreateButton = (field) => {
  if (state.buttons.has(field)) {
    return state.buttons.get(field);
  }

  const button = document.createElement("button");
  button.className = "tfa-icon-button";
  button.type = "button";
  button.title = "Fill with AI";

  const img = document.createElement("img");
  img.src = getLogoUrl();
  img.alt = "AI Fill";
  img.className = "tfa-logo";
  button.appendChild(img);

  // Single click → show modal (after short debounce to detect double-click)
  // Double click → instant generate
  let clickTimer = null;
  let lastClickTime = 0;

  button.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();

    if (button.disabled || button.dataset.generating === "true") return;

    const now = Date.now();
    const timeSinceLastClick = now - lastClickTime;

    if (timeSinceLastClick < 280) {
      // Double-click detected — instant generate
      if (clickTimer) {
        clearTimeout(clickTimer);
        clickTimer = null;
      }
      lastClickTime = 0;
      closeModalForButton(button);
      await generateAndFill(field, button, { action: "generate" });
    } else {
      lastClickTime = now;
      if (clickTimer) clearTimeout(clickTimer);
      clickTimer = setTimeout(() => {
        clickTimer = null;
        lastClickTime = 0;
        if (button.disabled || button.dataset.generating === "true") return;
        toggleModal(field, button);
      }, 280);
    }
  });

  state.buttons.set(field, button);
  return button;
};

// ─── Button Positioning ────────────────────────────────────────────────────────

const positionButton = (field, button) => {
  const rect = field.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    button.style.display = "none";
    return;
  }

  const top = rect.top + window.scrollY + 6;
  const left = rect.right + window.scrollX - 32;

  button.style.position = "absolute";
  button.style.top = `${Math.max(top, 0)}px`;
  button.style.left = `${Math.max(left, 0)}px`;
  button.style.zIndex = "2147483647";

  if (!button.parentElement) {
    document.body.appendChild(button);
  }

  // Ensure context indicator is up to date
  updateContextIndicator(button);
};

// ─── Field Detection Utilities ─────────────────────────────────────────────────

const isEditableField = (field) => {
  if (!field) return false;
  if (
    field.disabled ||
    field.readOnly ||
    field.getAttribute("aria-disabled") === "true"
  )
    return false;
  if (field.isContentEditable) return true;
  return field.tagName === "TEXTAREA" || field.tagName === "INPUT";
};

const isVisibleField = (field) => {
  if (!field || !field.getClientRects().length) return false;
  const style = window.getComputedStyle(field);
  return style.visibility !== "hidden" && style.display !== "none";
};

const isSearchField = (field) => {
  const placeholder = (
    field.placeholder ||
    field.getAttribute("aria-placeholder") ||
    ""
  ).toLowerCase();
  const name = (field.name || "").toLowerCase();
  return (
    placeholder.includes("search") ||
    placeholder.includes("filter") ||
    name.includes("search")
  );
};

const isLikelyPersonalInfoField = (field) => {
  const autocomplete = (field.autocomplete || "").toLowerCase();
  const name = (field.name || "").toLowerCase();
  const id = (field.id || "").toLowerCase();
  const type = (field.type || "").toLowerCase();
  const placeholder = (
    field.placeholder ||
    field.getAttribute("aria-placeholder") ||
    ""
  ).toLowerCase();
  const ariaLabel = (
    field.getAttribute("aria-label") || ""
  ).toLowerCase();
  const combined = `${autocomplete} ${name} ${id} ${placeholder} ${ariaLabel}`;

  if (
    type === "email" ||
    type === "tel" ||
    type === "password" ||
    type === "number"
  )
    return true;

  const personalPatterns = [
    "email",
    "e-mail",
    "mail",
    "phone",
    "tel",
    "telephone",
    "mobile",
    "cell",
    "name",
    "first-name",
    "last-name",
    "given-name",
    "family-name",
    "full-name",
    "firstname",
    "lastname",
    "address",
    "street",
    "city",
    "state",
    "zip",
    "postal",
    "country",
    "password",
    "pwd",
    "pass",
    "ssn",
    "social-security",
    "dob",
    "birth",
    "birthday",
    "credit",
    "card",
    "cvv",
    "expir",
    "salary",
    "compensation",
    "wage",
  ];
  return personalPatterns.some((pattern) => combined.includes(pattern));
};

const isMessagingField = (field) => {
  const ariaLabel = (field.getAttribute("aria-label") || "").toLowerCase();
  const placeholder = (
    field.placeholder ||
    field.getAttribute("data-placeholder") ||
    ""
  ).toLowerCase();
  const role = (field.getAttribute("role") || "").toLowerCase();
  const className = (field.className || "").toLowerCase();
  const testId = (
    field.getAttribute("data-testid") || ""
  ).toLowerCase();

  const messagingPatterns = [
    "message",
    "compose",
    "write",
    "reply",
    "comment",
    "post",
    "chat",
    "conversation",
    "note",
    "memo",
    "tweet",
    "thread",
    "status",
    "update",
    "share",
  ];
  const combined = `${ariaLabel} ${placeholder} ${role} ${className} ${testId}`;
  return messagingPatterns.some((pattern) => combined.includes(pattern));
};

// ─── Text Insertion ────────────────────────────────────────────────────────────

const insertText = (field, answerText) => {
  const hostname = window.location.hostname.toLowerCase();

  // Apply LinkedIn character limit
  if (hostname.includes("linkedin.com") && answerText.length > 2900) {
    const truncated = answerText.substring(0, 2900);
    const lastSentence = Math.max(
      truncated.lastIndexOf(". "),
      truncated.lastIndexOf("! "),
      truncated.lastIndexOf("? ")
    );
    answerText =
      lastSentence > 2000
        ? truncated.substring(0, lastSentence + 1)
        : truncated;
  }

  if (field.isContentEditable) {
    let targetField = field;
    const qlEditor =
      field.querySelector(".ql-editor") ||
      (field.classList.contains("ql-editor") ? field : null);
    if (qlEditor) targetField = qlEditor;

    targetField.focus();

    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(targetField);
    selection.removeAllRanges();
    selection.addRange(range);

    const execSuccess = document.execCommand("insertText", false, answerText);

    if (!execSuccess) {
      targetField.innerHTML = "";
      const p = document.createElement("p");
      p.textContent = answerText;
      targetField.appendChild(p);
    }

    range.selectNodeContents(targetField);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  } else {
    const nativeInputSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      "value"
    )?.set;
    const nativeTextareaSetter = Object.getOwnPropertyDescriptor(
      window.HTMLTextAreaElement.prototype,
      "value"
    )?.set;

    if (field.tagName === "TEXTAREA" && nativeTextareaSetter) {
      nativeTextareaSetter.call(field, answerText);
    } else if (field.tagName === "INPUT" && nativeInputSetter) {
      nativeInputSetter.call(field, answerText);
    } else {
      field.value = answerText;
    }
  }

  // Dispatch events for React/Vue/Angular frameworks
  if (field.isContentEditable) {
    field.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: answerText,
      })
    );
  }

  field.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: answerText,
    })
  );
  field.dispatchEvent(new Event("change", { bubbles: true }));

  if (field.isContentEditable) {
    field.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Unidentified" })
    );
    field.dispatchEvent(
      new KeyboardEvent("keyup", { bubbles: true, key: "Unidentified" })
    );
  }

  field.dispatchEvent(new Event("blur", { bubbles: true }));

  setTimeout(() => {
    field.focus();
    field.dispatchEvent(new Event("focus", { bubbles: true }));
    if (hostname.includes("linkedin.com")) {
      const form = field.closest("form") || field.closest(".msg-form");
      if (form) form.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }, 50);
};

// ─── Generate & Fill ──────────────────────────────────────────────────────────

const generateAndFill = async (field, button, options = {}) => {
  const { action = "generate", instruction = "" } = options;

  if (button.dataset.generating === "true") return;

  button.dataset.generating = "true";
  setButtonLoading(button);

  try {
    const question = getQuestionText(field) || "Write a response";
    const pageContext = extractPageContext(field);
    const fieldValue = getFieldValue(field);
    const platformKey = detectPlatformKey();

    const activeContexts = state.capturedContexts.filter((c) => c.active);

    const response = await chrome.runtime.sendMessage({
      type: "generateAnswer",
      question,
      fieldValue,
      pageContext,
      platformKey,
      action,
      instruction,
      capturedContexts: activeContexts.length > 0 ? activeContexts : null,
    });

    if (!response?.ok) {
      showToast(response?.error || "Failed to generate. Check settings.", true);
      resetButton(button);
      return;
    }

    insertText(field, response.answer);
    setButtonSuccess(button);
  } catch (err) {
    showToast(err.message || "Something went wrong", true);
    resetButton(button);
  } finally {
    delete button.dataset.generating;
  }
};

// ─── Toast Notifications ───────────────────────────────────────────────────────

const showToast = (message, isError = false) => {
  const existing = document.querySelector(".tfa-toast");
  if (existing) existing.remove();

  const toast = document.createElement("div");
  toast.className = `tfa-toast ${isError ? "tfa-toast-error" : ""}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    try {
      if (toast && toast.parentElement) toast.remove();
    } catch (e) {
      // Ignore
    }
  }, 4000);
};

// ─── Field Scanning & Button Management ───────────────────────────────────────

const getPlatformSelectors = () => {
  const hostname = window.location.hostname.toLowerCase();
  let selectors = [];

  if (hostname.includes("mail.google.com")) {
    selectors = [...PLATFORM_SELECTORS.gmail, ...PLATFORM_SELECTORS.general];
  } else if (hostname.includes("linkedin.com")) {
    selectors = [
      ...PLATFORM_SELECTORS.linkedin,
      ...PLATFORM_SELECTORS.general,
    ];
  } else if (
    hostname.includes("facebook.com") ||
    hostname.includes("messenger.com")
  ) {
    selectors = [
      ...PLATFORM_SELECTORS.facebook,
      ...PLATFORM_SELECTORS.general,
    ];
  } else if (
    hostname.includes("twitter.com") ||
    hostname.includes("x.com")
  ) {
    selectors = [
      ...PLATFORM_SELECTORS.twitter,
      ...PLATFORM_SELECTORS.general,
    ];
  } else if (hostname.includes("threads.net")) {
    selectors = [
      ...PLATFORM_SELECTORS.threads,
      ...PLATFORM_SELECTORS.general,
    ];
  } else if (hostname.includes("instagram.com")) {
    selectors = [
      ...PLATFORM_SELECTORS.instagram,
      ...PLATFORM_SELECTORS.general,
    ];
  } else if (hostname.includes("youtube.com")) {
    selectors = [
      ...PLATFORM_SELECTORS.youtube,
      ...PLATFORM_SELECTORS.general,
    ];
  } else if (hostname.includes("reddit.com")) {
    selectors = [
      ...PLATFORM_SELECTORS.reddit,
      ...PLATFORM_SELECTORS.general,
    ];
  } else {
    selectors = PLATFORM_SELECTORS.general;
  }

  return selectors.join(", ");
};

const scanAndAddButtons = () => {
  state.scanScheduled = false;

  const selector = getPlatformSelectors();
  const fields = document.querySelectorAll(selector);

  fields.forEach((field) => {
    if (!isEditableField(field) || !isVisibleField(field)) return;

    if (state.buttons.has(field)) {
      positionButton(field, state.buttons.get(field));
      return;
    }

    const rect = field.getBoundingClientRect();
    if (rect.width < 100 || rect.height < 20) return;
    if (isSearchField(field)) return;
    if (isLikelyPersonalInfoField(field)) return;

    // Only show on small inputs if they're messaging-style
    const isTextarea = field.tagName === "TEXTAREA" || field.isContentEditable;
    if (!isTextarea && rect.height < 50) {
      if (!isMessagingField(field)) return;
    }

    const button = getOrCreateButton(field);
    positionButton(field, button);
  });
};

const updateButtonPositions = () => {
  if (state.scrollTicking) return;
  state.scrollTicking = true;

  requestAnimationFrame(() => {
    state.buttons.forEach((button, field) => {
      const rect = field.getBoundingClientRect();
      const visible =
        isVisibleField(field) &&
        rect.bottom >= 0 &&
        rect.top <= window.innerHeight;

      if (!visible) {
        button.style.display = "none";
      } else {
        button.style.display = "";
        positionButton(field, button);
      }
    });
    state.scrollTicking = false;
  });
};

const cleanupOrphanedButtons = () => {
  state.buttons.forEach((button, field) => {
    if (!document.contains(field)) {
      if (button.parentElement) button.remove();
      state.buttons.delete(field);
    }
  });
};

const scheduleScan = () => {
  if (state.scanScheduled) return;
  state.scanScheduled = true;

  if ("requestIdleCallback" in window) {
    state.idleCallbackId = requestIdleCallback(
      () => {
        scanAndAddButtons();
        cleanupOrphanedButtons();
      },
      { timeout: 2000 }
    );
  } else {
    setTimeout(() => {
      scanAndAddButtons();
      cleanupOrphanedButtons();
    }, 150);
  }
};

// ─── Initialization ────────────────────────────────────────────────────────────

const initializeButtons = () => {
  scanAndAddButtons();

  state.observer = new MutationObserver((mutations) => {
    let shouldScan = false;
    for (const mutation of mutations) {
      if (
        mutation.type === "childList" &&
        (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0)
      ) {
        shouldScan = true;
        break;
      }
      if (mutation.type === "attributes" && mutation.attributeName) {
        const attrName = mutation.attributeName;
        if (
          attrName === "class" ||
          attrName === "style" ||
          attrName === "hidden" ||
          attrName === "aria-hidden"
        ) {
          shouldScan = true;
          break;
        }
      }
    }
    if (shouldScan) scheduleScan();
  });

  if (document.body) {
    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "hidden",
        "aria-hidden",
        "contenteditable",
        "role",
      ],
    });
  }

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      state.observer?.disconnect();
    } else if (document.body) {
      state.observer?.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: [
          "class",
          "style",
          "hidden",
          "aria-hidden",
          "contenteditable",
          "role",
        ],
      });
      scheduleScan();
    }
  });

  window.addEventListener("scroll", updateButtonPositions, { passive: true });
  document.addEventListener("scroll", updateButtonPositions, {
    passive: true,
    capture: true,
  });
  window.addEventListener("resize", updateButtonPositions, { passive: true });

  document.addEventListener(
    "input",
    (e) => {
      if (
        e.target?.matches?.('input, textarea, [contenteditable="true"]')
      ) {
        scheduleScan();
      }
    },
    { passive: true, capture: true }
  );
};

const initializeExtension = async () => {
  setupUrlChangeDetection();

  // Load context library from storage (with migration from old single-context format)
  try {
    const stored = await chrome.storage.local.get(["capturedContexts", "capturedContext"]);

    if (Array.isArray(stored.capturedContexts)) {
      state.capturedContexts = stored.capturedContexts;
    } else if (stored.capturedContext && stored.capturedContext.text) {
      // Migrate old single-context entry to array
      const old = stored.capturedContext;
      const migrated = {
        id: `ctx_${Date.now()}`,
        title: old.title || "",
        url: old.url || "",
        hostname: (() => { try { return new URL(old.url).hostname; } catch (_) { return ""; } })(),
        text: old.text,
        time: old.time || Date.now(),
        active: true,
      };
      state.capturedContexts = [migrated];
      chrome.storage.local.set({ capturedContexts: state.capturedContexts });
      chrome.storage.local.remove("capturedContext");
    }
  } catch (e) {
    // Ignore storage errors
  }

  initializeButtons();
  createFloatingFAB();
  updateContextIndicators();
  proactivelyCacheJobDescription();
};

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeExtension);
} else {
  initializeExtension();
}
