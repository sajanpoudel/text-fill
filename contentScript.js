const MAX_CONTEXT_CHARS = 5000;
const MAX_PAGE_CHARS = 6000;
const CANVAS_PATH_RE = /\/courses\/\d+\/(assignments|discussion_topics|quizzes|modules)/;

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

const isCanvasLocation = (hostname = "", pathname = "") =>
  hostname.includes("instructure.com") || CANVAS_PATH_RE.test(pathname);

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
  canvas: [
    ".tox-edit-area__iframe",
    '.ic-RichContentEditor iframe[id$="_ifr"]',
    'iframe[id$="_ifr"][title*="Rich Text Area"]',
    'textarea[id*="submission"]',
    'textarea[name*="submission"]',
    '.discussion-reply-box textarea',
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

const OBSERVER_ATTRIBUTE_FILTER = [
  "class",
  "style",
  "hidden",
  "aria-hidden",
  "contenteditable",
  "role",
];
const EDITABLE_INPUT_SELECTOR = 'input, textarea, [contenteditable="true"]';

const normalizeText = (text) => text.replace(/\s+/g, " ").trim();
const IS_TOP_FRAME = (() => {
  try {
    return window.top === window;
  } catch (_) {
    return true;
  }
})();

const isBlankLikeUrl = (href = "") =>
  href === "about:blank" || href.startsWith("about:srcdoc");

const canReadWindowLocation = (targetWindow) => {
  try {
    return Boolean(targetWindow?.location?.href);
  } catch (_) {
    return false;
  }
};

const canReadWindowDocument = (targetWindow) => {
  try {
    return Boolean(targetWindow?.document);
  } catch (_) {
    return false;
  }
};

const shouldInitializeInThisFrame = () => {
  if (IS_TOP_FRAME) return true;

  try {
    const topHostname = (window.top?.location?.hostname || "").toLowerCase();
    const topPathname = (window.top?.location?.pathname || "").toLowerCase();
    if (isCanvasLocation(topHostname, topPathname)) return false;
  } catch (_) {
    // Ignore and continue with generic frame checks.
  }

  let href = "";
  try {
    href = window.location.href || "";
  } catch (_) {
    return false;
  }

  // Keep same-origin about:blank/srcdoc editor frames (TinyMCE, etc.).
  if (isBlankLikeUrl(href)) {
    try {
      const topHostname = (window.top?.location?.hostname || "").toLowerCase();
      const topPathname = (window.top?.location?.pathname || "").toLowerCase();
      // Canvas TinyMCE iframes are highly dynamic. Keep all icon logic in top frame
      // and treat the iframe element as the stable editor anchor.
      if (isCanvasLocation(topHostname, topPathname)) return false;
      return (
        window.top &&
        window.top !== window &&
        canReadWindowLocation(window.top) &&
        canReadWindowDocument(window.top)
      );
    } catch (_) {
      return false;
    }
  }

  // For non-blank iframes, only run when same-origin with top.
  try {
    return (
      window.top &&
      window.top !== window &&
      window.top.location.origin === window.location.origin
    );
  } catch (_) {
    return false;
  }
};

const getHostWindow = () => {
  let href = "";
  try {
    href = window.location.href || "";
  } catch (_) {
    return window;
  }

  try {
    if (isBlankLikeUrl(href) && window.top && window.top !== window) {
      if (!canReadWindowLocation(window.top) || !canReadWindowDocument(window.top)) {
        return window;
      }
      return window.top;
    }
  } catch (_) {
    // Cross-origin access blocked — use current frame.
  }
  return window;
};

const getHostDocument = () => {
  const hostWindow = getHostWindow();
  try {
    return hostWindow.document || document;
  } catch (_) {
    return document;
  }
};

const getLocationSnapshot = () => {
  const hostWindow = getHostWindow();
  const hostDoc = getHostDocument();
  let hostname = "";
  let pathname = "";
  let href = "";
  let title = "";

  try {
    const loc = hostWindow.location;
    hostname = (loc?.hostname || "").toLowerCase();
    pathname = (loc?.pathname || "").toLowerCase();
    href = loc?.href || "";
  } catch (_) {
    try {
      hostname = (window.location.hostname || "").toLowerCase();
      pathname = (window.location.pathname || "").toLowerCase();
      href = window.location.href || "";
    } catch (_) {
      // Keep empty fallbacks.
    }
  }

  try {
    title = hostDoc.title || document.title || "";
  } catch (_) {
    try {
      title = document.title || "";
    } catch (_) {
      title = "";
    }
  }

  return {
    hostname,
    pathname,
    href,
    title,
  };
};

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
    if (typeof syncContextFabVisibility === "function") {
      syncContextFabVisibility();
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
  const { hostname, pathname } = getLocationSnapshot();
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
  if (isCanvasLocation(hostname, pathname)) {
    return "canvas";
  }

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

const isElementVisible = (el) => {
  if (!(el instanceof Element)) return false;
  const view = el.ownerDocument?.defaultView || window;
  const style = view.getComputedStyle(el);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.opacity === "0"
  ) {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};

const pickPersonLikeCandidate = (values = []) => {
  const generic = new Set([
    "to",
    "cc",
    "bcc",
    "message",
    "messages",
    "chat",
    "compose",
    "new message",
    "reply",
    "inbox",
    "messaging",
    "focused",
    "jobs",
    "unread",
    "connections",
    "inmail",
    "starred",
    "you",
    "me",
  ]);

  for (const raw of values) {
    if (!raw) continue;
    let text = normalizeText(raw)
      .replace(/\([^)]*\)/g, "")
      .split("·")[0]
      .split("|")[0]
      .trim();
    if (!text) continue;
    if (text.length < 2 || text.length > 80) continue;
    const lower = text.toLowerCase();
    if (generic.has(lower)) continue;
    if (/^\d{1,2}:\d{2}\s*(am|pm)?$/i.test(lower)) continue;
    if (lower.includes("you:") || lower.includes("subject:")) continue;
    if (
      /\b(reaching out|follow|reply|message|interest|opportunity|hiring)\b/i.test(
        text
      ) &&
      text.split(/\s+/).length > 4
    ) {
      continue;
    }
    if (!/[a-z]/i.test(text)) continue;
    return text;
  }
  return "";
};

// ─── Compose Boundary Detection (context isolation) ───────────────────────────
// Finds the tightest container that represents what the user is currently
// composing — prevents reading unrelated emails, chats, or conversations.

const getComposeBoundary = (field) => {
  const { hostname, pathname } = getLocationSnapshot();

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
      field.closest(".msg-overlay-conversation-bubble--is-active") ||
      field.closest(".msg-overlay-conversation-bubble") ||
      field.closest(".msg-thread") ||
      field.closest(".msg-conversation-card") ||
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

  // Canvas LMS / assignment portals
  if (isCanvasLocation(hostname, pathname)) {
    return (
      field.closest(
        ".submission-details, .ic-Layout-contentMain, .discussion-topic, .quiz-submission, [role='main'], form"
      ) ||
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

const ROLE_KEYWORDS = {
  academic: ["professor", "instructor", "teacher", "ta", "course", "class"],
  hiring: ["recruiter", "hiring manager", "interviewer", "talent", "sourcer"],
  client: ["client", "customer", "stakeholder", "account", "vendor"],
};

const ASSIGNMENT_KEYWORDS = [
  "assignment",
  "discussion",
  "prompt",
  "instructions",
  "rubric",
  "submission",
  "question",
  "reply",
  "respond",
  "initial post",
  "classmates",
  "classmate",
  "graded",
  "grade",
  "module",
  "week",
  "thesis",
  "argument",
  "reflection",
  "cite",
  "citation",
  "word count",
  "due date",
  "points",
];

const GENERIC_COMPOSE_LABELS = [
  "write a reply",
  "write your reply",
  "reply",
  "write a response",
  "response",
  "add a comment",
  "write a comment",
  "comment",
  "message",
];

const isGenericComposeLabel = (text = "", platformKey = "") => {
  const normalized = normalizeText(text).toLowerCase();
  if (!normalized) return false;
  if (platformKey !== "canvas") return false;
  return GENERIC_COMPOSE_LABELS.some((label) => normalized === label);
};

const inferRoleHint = (sourceText = "", platformKey = "") => {
  const text = sourceText.toLowerCase();
  if (ROLE_KEYWORDS.academic.some((k) => text.includes(k))) return "academic";
  if (ROLE_KEYWORDS.hiring.some((k) => text.includes(k))) return "hiring";
  if (ROLE_KEYWORDS.client.some((k) => text.includes(k))) return "client";
  if (["messenger", "facebook", "instagram", "threads"].includes(platformKey)) {
    return "social";
  }
  return "";
};

const collectKeywordSnippets = (
  root,
  keywords,
  { maxSnippets = 6, maxTotal = 1600, maxNodes = 350 } = {}
) => {
  if (!root) return "";
  const candidates = Array.from(
    root.querySelectorAll("h1,h2,h3,h4,legend,label,p,li,td,th,div,span")
  ).slice(0, maxNodes);

  const snippets = [];
  let total = 0;

  for (const el of candidates) {
    const text = normalizeText(el.innerText || "");
    if (text.length < 24 || text.length > 450) continue;

    const lower = text.toLowerCase();
    if (!keywords.some((k) => lower.includes(k))) continue;
    if (snippets.some((s) => s === text || s.includes(text) || text.includes(s)))
      continue;

    snippets.push(text);
    total += text.length;
    if (snippets.length >= maxSnippets || total >= maxTotal) break;
  }

  return snippets.join("\n");
};

const findHostIframeForField = (field, hostDoc = getHostDocument()) => {
  if (!(field instanceof Element)) return null;
  if (field.ownerDocument === hostDoc) return null;
  const frames = Array.from(hostDoc.querySelectorAll("iframe"));
  for (const frame of frames) {
    try {
      if (frame.contentDocument === field.ownerDocument) return frame;
    } catch (_) {
      // Cross-origin frame; ignore.
    }
  }
  return null;
};

const getHostAnchorForField = (field, hostDoc = getHostDocument()) => {
  if (!(field instanceof Element)) return null;
  if (field.ownerDocument === hostDoc) {
    return (
      field.closest(
        "[data-testid='discussion-topic-container'], .discussion-topic, .submission-details, .discussion-reply-box, .ic-Layout-contentMain, .ic-RichContentEditor, [role='main'], form, section, article"
      ) || field.closest("section, form, article, [role='main'], div")
    );
  }

  const hostFrame = findHostIframeForField(field, hostDoc);
  if (!hostFrame) return null;
  return (
    hostFrame.closest(
      "[data-testid='discussion-topic-container'], .discussion-topic, .submission-details, .discussion-reply-box, .ic-Layout-contentMain, .ic-RichContentEditor, [role='main'], form, section, article"
    ) ||
    hostFrame.parentElement ||
    hostDoc.body
  );
};

const isPromptNoiseText = (text = "") => {
  const lower = text.toLowerCase();
  if (!lower) return true;
  if (/^(view|insert|format|tools|table|edit)$/i.test(lower)) return true;
  if (/^(bold|italic|underline|font|paragraph|styles?)$/i.test(lower)) return true;
  if (/^\d+\s*words?$/.test(lower)) return true;
  if (/^to\b|^cc\b|^bcc\b/.test(lower)) return true;
  return false;
};

const extractLinkedInCounterpartyContext = (field, composeBoundary) => {
  const hostDoc = getHostDocument();

  const conversationRoot =
    composeBoundary?.closest(
      ".msg-overlay-conversation-bubble, .msg-thread, .msg-conversation-card"
    ) ||
    field.closest(".msg-overlay-conversation-bubble, .msg-thread, .msg-conversation-card") ||
    composeBoundary ||
    null;
  if (!conversationRoot) return null;

  const headerRoot =
    conversationRoot.querySelector(
      "header, [class*='msg-thread__header'], [class*='conversation-header'], [class*='msg-overlay-conversation-bubble-header']"
    ) || conversationRoot;
  const headerCandidates = [];
  [
    ".msg-thread__link-to-profile",
    "[class*='msg-thread__name']",
    "a[href*='/in/']",
    "[class*='participant-name']",
    "h1, h2, h3",
  ].forEach((selector) => {
    headerRoot.querySelectorAll(selector).forEach((el) => {
      if (!isElementVisible(el)) return;
      const text = normalizeText(el.innerText || el.textContent || "");
      if (text) headerCandidates.push(text);
    });
  });

  const headerName = pickPersonLikeCandidate(headerCandidates);
  if (headerName) {
    const roleHint = inferRoleHint(
      `${headerName} ${headerRoot.innerText || ""}`,
      "linkedin"
    );
    return { name: headerName, roleHint };
  }

  const selectedConversation = hostDoc.querySelector(
    ".msg-conversation-listitem--is-active, .msg-conversation-listitem--selected, .msg-conversation-listitem[aria-selected='true'], [aria-selected='true'][class*='msg-conversation-listitem']"
  );
  if (selectedConversation && isElementVisible(selectedConversation)) {
    const fromSelected = [];
    [
      "[class*='participant-names']",
      "[class*='participant-name']",
      "[class*='conversation-listitem__name']",
      "h3",
      "a[href*='/in/']",
    ].forEach((selector) => {
      selectedConversation.querySelectorAll(selector).forEach((el) => {
        if (!isElementVisible(el)) return;
        const text = normalizeText(el.innerText || el.textContent || "");
        if (text) fromSelected.push(text);
      });
    });
    const selectedName = pickPersonLikeCandidate(fromSelected);
    if (selectedName) {
      const selectedHint = inferRoleHint(
        `${selectedName} ${selectedConversation.innerText || ""}`,
        "linkedin"
      );
      return { name: selectedName, roleHint: selectedHint };
    }
  }

  return null;
};

const extractCounterpartyContext = (field, composeBoundary, platformKey) => {
  if (platformKey === "linkedin") {
    const linkedinCounterparty = extractLinkedInCounterpartyContext(
      field,
      composeBoundary
    );
    if (linkedinCounterparty) return linkedinCounterparty;
  }

  const hostDoc = getHostDocument();
  const root =
    composeBoundary ||
    field.closest("section, article, [role='main'], form, div") ||
    hostDoc.body ||
    document.body;

  const selectors = [
    'input[aria-label*="To"]',
    'textarea[aria-label*="To"]',
    '[aria-label*="recipient"]',
    '[aria-label*="Recipient"]',
    "[data-testid*='recipient']",
    "[data-testid*='conversation']",
    "[class*='recipient']",
    "[class*='participant']",
    "[class*='conversation']",
    "header h1, header h2, header [role='heading']",
    "h1, h2, h3, [role='heading']",
    "span[email]",
  ];

  const raw = [];
  for (const selector of selectors) {
    root.querySelectorAll(selector).forEach((el) => {
      if (!isElementVisible(el)) return;
      const text = normalizeText(el.innerText || el.textContent || "");
      if (!text) return;
      if (text.length < 2 || text.length > 80) return;
      raw.push(text);
    });
    if (raw.length >= 5) break;
  }

  const candidate = pickPersonLikeCandidate(raw);
  if (!candidate) return null;

  const roleHint = inferRoleHint(
    `${candidate} ${getLocationSnapshot().title} ${getLocationSnapshot().href}`,
    platformKey
  );

  return {
    name: candidate.replace(/\s+/g, " ").trim(),
    roleHint,
  };
};

const extractAssignmentContext = (field, sourceDoc = null) => {
  const doc = sourceDoc || getHostDocument();
  const loc = getLocationSnapshot();
  const titleAndUrl = `${loc.title} ${loc.href}`.toLowerCase();
  const shouldScan = ASSIGNMENT_KEYWORDS.some((k) =>
    titleAndUrl.includes(k)
  );
  if (!shouldScan) return "";

  const hostAnchor = getHostAnchorForField(field, doc);
  const scanProfile = { maxSnippets: 8, maxTotal: 1800, maxNodes: 420 };

  const roots = [
    hostAnchor,
    doc.querySelector(
      "[data-testid='discussion-topic-container'], [data-resource-type='discussion_topic.body'], .assignment-description, .ic-Assignment-description, .discussion-topic, .quiz-submission, .submission-details"
    ),
    field.closest(".submission-details, .discussion-topic, main, article, [role='main']"),
    doc.body || document.body,
  ].filter(Boolean);

  for (const root of roots) {
    let text = collectKeywordSnippets(root, ASSIGNMENT_KEYWORDS, {
      ...scanProfile,
      maxNodes:
        root === (doc.body || document.body)
          ? scanProfile.maxNodes
          : Math.max(450, Math.floor(scanProfile.maxNodes * 0.75)),
    });
    if (text && text.length > 60) return text.slice(0, 2200);
  }
  return "";
};

const extractContextPack = (field) => {
  const hostDoc = getHostDocument();
  const loc = getLocationSnapshot();
  const title = loc.title || document.title || "";
  const url = loc.href || window.location.href || "";
  const metaDescription =
    hostDoc.querySelector("meta[name='description']")?.content || "";
  const platformKey = detectPlatformKey();

  const hostAnchor = getHostAnchorForField(field, hostDoc);
  const composeBoundary = getComposeBoundary(field) || hostAnchor;
  const foregroundRoot =
    composeBoundary ||
    hostAnchor ||
    field.closest("section, form, article, [role='main'], div");
  const backgroundRoot =
    hostDoc.querySelector("main, article, [role='main']") ||
    hostDoc.body ||
    document.body;

  const foregroundContext = extractSectionText(foregroundRoot, 2800);
  let backgroundContext = composeBoundary
    ? extractSectionText(backgroundRoot, 2600)
    : extractSectionText(hostDoc.body || document.body, 1800);

  if (foregroundContext && backgroundContext) {
    const snippet = foregroundContext.slice(0, 220);
    if (snippet.length > 80 && backgroundContext.includes(snippet)) {
      backgroundContext = normalizeText(backgroundContext.replace(snippet, " "));
    }
  }

  let jobContext = "";
  if (platformKey === "job_application") {
    const jobDesc = extractJobDescription();
    if (jobDesc && !isFormContent(jobDesc)) {
      jobContext = jobDesc.slice(0, 3000);
    }
  }

  const counterpart = extractCounterpartyContext(
    field,
    composeBoundary,
    platformKey
  );
  const assignmentContext = extractAssignmentContext(field, hostDoc);

  return {
    title,
    url,
    metaDescription,
    platformKey,
    foregroundContext,
    backgroundContext,
    assignmentContext,
    counterpart,
    jobContext,
    usesComposeBoundary: Boolean(composeBoundary),
  };
};

const buildPageContextFromPack = (pack) => {
  if (!pack) return "";
  const parts = [
    pack.title ? `Page: ${pack.title}` : "",
    pack.url ? `URL: ${pack.url}` : "",
    pack.metaDescription ? `Description: ${pack.metaDescription}` : "",
    pack.counterpart?.name
      ? `Audience: ${pack.counterpart.name}${
          pack.counterpart.roleHint ? ` (${pack.counterpart.roleHint})` : ""
        }`
      : "",
    pack.foregroundContext
      ? `Foreground context:\n${pack.foregroundContext}`
      : "",
    pack.backgroundContext
      ? `Background context:\n${pack.backgroundContext}`
      : "",
    pack.assignmentContext
      ? `Assignment context:\n${pack.assignmentContext}`
      : "",
    pack.jobContext ? `Job description:\n${pack.jobContext}` : "",
  ].filter(Boolean);

  return parts.join("\n\n").slice(0, MAX_PAGE_CHARS);
};

const extractPageContext = (field) => buildPageContextFromPack(extractContextPack(field));

const inferQuestionFromContextPack = (contextPack = null) => {
  if (!contextPack) return "";
  const raw = [contextPack.assignmentContext, contextPack.foregroundContext]
    .filter(Boolean)
    .join("\n");
  if (!raw) return "";
  const lines = raw
    .split(/\n+/)
    .map((s) => normalizeText(s))
    .filter((s) => s.length >= 22 && s.length <= 280);
  const best =
    lines.find((s) => /\?$/.test(s)) ||
    lines.find((s) =>
      /\b(what|why|how|describe|discuss|explain|analy[sz]e|compare|respond|reply)\b/i.test(
        s
      )
    ) ||
    "";
  return best;
};

const getQuestionText = (field, contextPack = null) => {
  if (!(field instanceof Element)) return "";
  const hostDoc = getHostDocument();
  const localDoc = field.ownerDocument || document;
  const platformKey = contextPack?.platformKey || detectPlatformKey();

  const ariaLabel = field.getAttribute("aria-label");
  if (ariaLabel && !isGenericComposeLabel(ariaLabel, platformKey)) {
    return ariaLabel.trim();
  }

  const ariaLabelledBy = field.getAttribute("aria-labelledby");
  if (typeof ariaLabelledBy === "string" && ariaLabelledBy.trim()) {
    const labelled = ariaLabelledBy
      .trim()
      .split(/\s+/)
      .map((id) => localDoc.getElementById(id) || hostDoc.getElementById(id))
      .filter((el) => el && typeof el.textContent === "string")
      .map((el) => el.textContent.trim())
      .filter((t) => t)
      .join(" ")
      .trim();
    if (labelled && !isGenericComposeLabel(labelled, platformKey)) {
      return labelled;
    }
  }

  const label =
    localDoc.querySelector(`label[for="${field.id}"]`) ||
    hostDoc.querySelector(`label[for="${field.id}"]`);
  if (
    label?.innerText &&
    !isGenericComposeLabel(label.innerText, platformKey)
  ) {
    return label.innerText.trim();
  }

  const placeholder =
    field.placeholder ||
    field.getAttribute("data-placeholder") ||
    field.getAttribute("aria-placeholder") ||
    "";
  if (placeholder && !isGenericComposeLabel(placeholder, platformKey)) {
    return placeholder.trim();
  }

  const describedBy = field.getAttribute("aria-describedby");
  if (describedBy) {
    const described = describedBy
      .split(" ")
      .map(
        (id) =>
          localDoc.getElementById(id)?.innerText ||
          hostDoc.getElementById(id)?.innerText ||
          ""
      )
      .join(" ")
      .trim();
    if (described && !isGenericComposeLabel(described, platformKey)) {
      return described;
    }
  }

  const inferred = inferQuestionFromContextPack(contextPack);
  if (inferred) return inferred;

  const hostAnchor = getHostAnchorForField(field, hostDoc);
  const parentText =
    hostAnchor?.innerText ||
    field.closest("section, form, div")?.innerText ||
    "";
  const condensed = normalizeText(parentText.split("\n").slice(0, 3).join(" "));
  if (condensed.length >= 12) return condensed.slice(0, 320);

  const assignmentFallback = extractAssignmentContext(field, hostDoc);
  if (assignmentFallback) {
    const line = assignmentFallback
      .split(/\n+/)
      .map((s) => normalizeText(s))
      .find((s) => s.length >= 22 && s.length <= 280);
    if (line) return line;
  }

  return "";
};

const getFieldValue = (field) => {
  if (isCanvasEditorIframe(field)) {
    const editorBody = getCanvasEditorBody(field);
    return editorBody ? (editorBody.innerText || editorBody.textContent || "") : "";
  }
  if (field?.isContentEditable) return field.textContent || "";
  return field?.value || "";
};

// Extracts structural hints about a field to guide adaptive generation:
// expected length (from dimensions/attributes) + nearby question labels
const extractFieldHints = (field, contextPack = null) => {
  const hints = {};
  const hostDoc = getHostDocument();

  // 1. Expected length from explicit attributes
  const maxLength =
    parseInt(field.getAttribute("maxlength") || field.getAttribute("maxLength")) || 0;
  const rows = parseInt(field.getAttribute("rows")) || 0;

  if (maxLength > 0) {
    hints.maxLength = maxLength;
    if (maxLength <= 140) hints.expectedLength = "very_short";
    else if (maxLength <= 320) hints.expectedLength = "short";
    else if (maxLength <= 700) hints.expectedLength = "medium";
    else hints.expectedLength = "long";
  } else {
    // Fall back to rendered height
    const rect = field.getBoundingClientRect();
    if (rect.height > 0) {
      if (rect.height < 56) hints.expectedLength = "very_short";
      else if (rect.height < 120) hints.expectedLength = "short";
      else if (rect.height < 260) hints.expectedLength = "medium";
      else hints.expectedLength = "long";
    }
  }

  // Large textarea rows always means long-form
  if (rows >= 10) hints.expectedLength = "very_long";

  // 2. Nearby headings/labels that describe what this field expects
  const nearbyLabels = [];
  const container =
    getHostAnchorForField(field, hostDoc) ||
    field.closest("form, section, article, [role='main']") ||
    hostDoc.body ||
    document.body;
  const candidates = Array.from(
    container.querySelectorAll("h1,h2,h3,h4,h5,label,legend,p,span")
  );

  for (const el of candidates.reverse()) {
    if (el.contains(field)) continue;
    // Must appear before the field in DOM order
    if (el.ownerDocument === field.ownerDocument) {
      const pos = el.compareDocumentPosition(field);
      if (!(pos & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    }
    const text = el.innerText?.trim() || "";
    if (text.length > 4 && text.length < 300 && !isPromptNoiseText(text)) {
      nearbyLabels.push(text);
      if (nearbyLabels.length >= 3) break;
    }
  }

  if (contextPack?.assignmentContext) {
    contextPack.assignmentContext
      .split(/\n+/)
      .map((s) => normalizeText(s))
      .filter((s) => s.length >= 20 && s.length <= 220)
      .slice(0, 2)
      .forEach((line) => nearbyLabels.push(line));
  }

  const uniqueNearby = [...new Set(nearbyLabels.map((s) => s.trim()))].filter(
    Boolean
  );
  if (uniqueNearby.length > 0) hints.nearbyLabels = uniqueNearby.slice(0, 4);

  return hints;
};

const getLogoUrl = () => chrome.runtime.getURL("logo.png");

// ─── Context Library (multi-page context capture) ─────────────────────────────

let _fab = null;
let _contextPanel = null;

const normalizeCapturedContexts = (contexts = []) =>
  contexts
    .filter((ctx) => ctx && typeof ctx === "object")
    .map((ctx) => ({
      ...ctx,
      id:
        typeof ctx.id === "string" && ctx.id
          ? ctx.id
          : `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      title: typeof ctx.title === "string" ? ctx.title : "",
      url: typeof ctx.url === "string" ? ctx.url : "",
      hostname: typeof ctx.hostname === "string" ? ctx.hostname : "",
      text: typeof ctx.text === "string" ? ctx.text : "",
      time: Number.isFinite(ctx.time) ? ctx.time : Date.now(),
      // Backward-compatible default: contexts without this flag are active.
      active: ctx.active !== false,
    }))
    .filter((ctx) => ctx.text.trim());

const normalizeCapturedPageText = (text = "", maxLength = 4000) =>
  String(text || "")
    .replace(/\r/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength);

const extractCapturedPageText = (hostDoc, platformKey) => {
  const mainRoot =
    hostDoc.querySelector("main, article, [role='main']") ||
    hostDoc.body ||
    document.body;

  if (platformKey === "canvas") {
    const canvasRoots = [
      hostDoc.querySelector("[data-resource-type='discussion_topic.body']"),
      hostDoc.querySelector("[data-testid='discussion-topic-container']"),
      hostDoc.querySelector(
        ".assignment-description, .ic-Assignment-description, .discussion-topic, .quiz-submission, .submission-details"
      ),
      mainRoot,
      hostDoc.body || document.body,
    ].filter(Boolean);

    for (const root of canvasRoots) {
      const focused = collectKeywordSnippets(root, ASSIGNMENT_KEYWORDS, {
        maxSnippets: 12,
        maxTotal: 3600,
        maxNodes: 1000,
      });
      if (focused && focused.length > 180) {
        return normalizeCapturedPageText(focused, 4000);
      }
      const broad = extractSectionText(root, 4200);
      if (broad && broad.length > 600) {
        return normalizeCapturedPageText(broad, 4000);
      }
    }
  }

  const broad =
    extractSectionText(mainRoot, 4200) ||
    extractSectionText(hostDoc.body || document.body, 4200);
  return normalizeCapturedPageText(broad, 4000);
};

const syncCapturedContextsFromStorage = async () => {
  try {
    const stored = await chrome.storage.local.get("capturedContexts");
    state.capturedContexts = normalizeCapturedContexts(stored.capturedContexts);
  } catch (_) {
    state.capturedContexts = [];
  }
  return state.capturedContexts;
};

const getActiveCapturedContexts = async () => {
  const contexts = await syncCapturedContextsFromStorage();
  return contexts.filter((c) => c.active !== false && c.text.trim());
};

const persistCapturedContexts = async (contexts) => {
  const normalized = normalizeCapturedContexts(contexts);
  state.capturedContexts = normalized;
  await chrome.storage.local.set({ capturedContexts: normalized });
  updateContextIndicators();
  return normalized;
};

const capturePageContext = async (button = null) => {
  if (button) setButtonLoading(button);
  try {
    const hostDoc = getHostDocument();
    const loc = getLocationSnapshot();
    const title = loc.title || document.title || "";
    const url = loc.href || window.location.href || "";
    const hostname = loc.hostname || window.location.hostname || "";
    const platformKey = detectPlatformKey();
    const pageText = extractCapturedPageText(hostDoc, platformKey);
    if (!pageText) {
      if (button) resetButton(button);
      showToast("No usable page context found to save", true);
      return;
    }
    const id = `ctx_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;

    const entry = { id, title, url, hostname, text: pageText, time: Date.now(), active: true };

    const latest = await syncCapturedContextsFromStorage();
    const next = Array.isArray(latest) ? [...latest] : [];

    // Deduplicate by URL — update if already saved
    const existingIdx = next.findIndex((c) => c.url === url);
    if (existingIdx >= 0) {
      next[existingIdx] = entry;
    } else {
      next.push(entry);
    }

    await persistCapturedContexts(next);
    if (button) resetButton(button);
    showToast(`Context saved: ${(title || hostname).slice(0, 40)}`);

    // Entity extraction + relational linking (fire-and-forget)
    try {
      const entities = extractPageEntities();
      if (entities.length > 0) {
        const result = await chrome.runtime.sendMessage({ type: "checkEntityLinks", entities });
        if (result?.links?.length > 0) {
          for (const link of result.links) {
            if (link.type === "contact_at_target") {
              showToast(`🔗 ${link.content}`);
            } else if (link.type === "job_saved" && link.action === "added") {
              showToast(`💼 Job target saved: ${link.content.replace("Saved: ", "")}`);
            }
          }
        }
      }
    } catch (_) { /* entity linking is best-effort */ }
  } catch (err) {
    if (button) resetButton(button);
    showToast("Failed to capture context", true);
  }
};

const clearCapturedContext = async (id = null) => {
  const latest = await syncCapturedContextsFromStorage();
  let next = Array.isArray(latest) ? [...latest] : [];
  if (id) {
    next = next.filter((c) => c.id !== id);
  } else {
    next = [];
  }
  await persistCapturedContexts(next);
  if (!id) showToast("All contexts cleared");
};

const toggleContextActive = async (id) => {
  const latest = await syncCapturedContextsFromStorage();
  const next = Array.isArray(latest) ? [...latest] : [];
  const ctx = next.find((c) => c.id === id);
  if (ctx) {
    ctx.active = ctx.active === false;
    await persistCapturedContexts(next);
  }
};

// Update the dot on a single field button
const updateContextIndicator = (button) => {
  const activeCount = state.capturedContexts.filter((c) => c.active !== false).length;
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
  syncContextFabVisibility();
};

const shouldShowContextFab = () => {
  if (!IS_TOP_FRAME) return false;
  if (detectPlatformKey() === "canvas") return true;
  const hasVisibleFieldButton = [...state.buttons.values()].some((btn) => {
    if (!btn || !document.body.contains(btn)) return false;
    if (btn.style.display === "none") return false;
    const rect = btn.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  });
  return !hasVisibleFieldButton;
};

const syncContextFabVisibility = () => {
  if (!_fab) return;
  const show = shouldShowContextFab();
  _fab.style.display = show ? "flex" : "none";
  if (!show) closeContextPanel();
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
    const isActive = ctx.active !== false;
    const row = document.createElement("div");
    row.className = `tfa-cp-row${isActive ? "" : " tfa-cp-row-inactive"}`;

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.className = "tfa-cp-check";
    checkbox.checked = isActive;
    checkbox.title = isActive ? "Deactivate" : "Activate";
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

// ─── On-Device Entity Extraction ──────────────────────────────────────────────
const extractPageEntities = () => {
  const loc = getLocationSnapshot();
  const hostDoc = getHostDocument();
  const hostname = (loc.hostname || window.location.hostname || "").toLowerCase();
  const pathname = (loc.pathname || window.location.pathname || "").toLowerCase();
  const entities = [];

  // LinkedIn profile
  if (hostname.includes("linkedin.com") && pathname.includes("/in/")) {
    const name =
      hostDoc.querySelector("h1.text-heading-xlarge")?.innerText?.trim() ||
      hostDoc.querySelector("h1[class*='name']")?.innerText?.trim();
    const titleEl = hostDoc.querySelector(".text-body-medium.break-words") ||
      hostDoc.querySelector("[class*='top-card-layout__headline']");
    const rawTitle = titleEl?.innerText?.trim() || "";
    const atMatch = rawTitle.match(/(?:at|@)\s+([A-Z][A-Za-z0-9 &,.]+?)(?:\s*[\|\·•]|$)/);
    const pipeMatch = rawTitle.match(/^([A-Z][A-Za-z0-9 &,.]+?)\s*[\|·•]/);
    const employer = atMatch?.[1]?.trim() || pipeMatch?.[1]?.trim() ||
      hostDoc.querySelector("[class*='top-card__employer']")?.innerText?.trim();
    if (name) entities.push({ type: "person", name, employer, title: rawTitle, source: "linkedin_profile" });
  }

  // LinkedIn job posting
  if (hostname.includes("linkedin.com") && (pathname.includes("/jobs/") || pathname.includes("/job/"))) {
    const company =
      hostDoc.querySelector(".job-details-jobs-unified-top-card__company-name a")?.innerText?.trim() ||
      hostDoc.querySelector("[class*='top-card__employer']")?.innerText?.trim();
    const role =
      hostDoc.querySelector("h1.job-details-jobs-unified-top-card__job-title")?.innerText?.trim() ||
      hostDoc.querySelector("h1[class*='job-title']")?.innerText?.trim();
    if (company) entities.push({ type: "job_posting", company, role, source: "linkedin_job" });
  }

  // ATS job boards (Greenhouse, Ashby, Lever, Workday)
  if (["greenhouse.io", "ashbyhq.com", "lever.co", "workday.com", "myworkdayjobs.com"]
    .some((b) => hostname.includes(b))) {
    const company =
      hostDoc.querySelector("[class*='company-name']")?.innerText?.trim() ||
      hostDoc.querySelector("meta[property='og:site_name']")?.content?.trim();
    const role =
      hostDoc.querySelector("h1[class*='job-title']")?.innerText?.trim() ||
      hostDoc.querySelector("h1[class*='posting-headline']")?.innerText?.trim() ||
      hostDoc.querySelector("h1")?.innerText?.trim();
    if (company || role) entities.push({ type: "job_posting", company: company || "", role: role || "", source: hostname });
  }

  return entities;
};

const createFloatingFAB = () => {
  if (!IS_TOP_FRAME) return;
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
  syncContextFabVisibility();
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
  const platformKey = detectPlatformKey();
  const activeCount = state.capturedContexts.filter((c) => c.active !== false).length;
  const currentUrl = getLocationSnapshot().href || window.location.href;
  const alreadySaved = state.capturedContexts.some((c) => c.url === currentUrl);

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

  if (platformKey !== "canvas") {
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
      primary ? "tfa-modal-btn-primary" : "",
      secondary ? "tfa-modal-btn-secondary" : "",
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
  // Keep critical styles inline so iframe contexts (e.g., TinyMCE about:blank)
  // still render correctly even if page CSS overrides button defaults.
  button.style.width = "28px";
  button.style.height = "28px";
  button.style.padding = "0";
  button.style.border = "none";
  button.style.borderRadius = "50%";
  button.style.background = "transparent";
  button.style.cursor = "pointer";
  button.style.display = "flex";
  button.style.alignItems = "center";
  button.style.justifyContent = "center";
  button.style.boxShadow = "0 2px 8px rgba(0,0,0,0.2)";

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
  if (isCanvasEditorIframe(field)) return true;
  if (
    field.disabled ||
    field.readOnly ||
    field.getAttribute("aria-disabled") === "true"
  )
    return false;
  if (field.isContentEditable) return true;
  return field.tagName === "TEXTAREA" || field.tagName === "INPUT";
};

const isCanvasEditorIframe = (field) => {
  if (!(field instanceof Element) || field.tagName !== "IFRAME") return false;
  if (detectPlatformKey() !== "canvas") return false;
  return (
    field.matches(".tox-edit-area__iframe") ||
    field.matches('.ic-RichContentEditor iframe[id$="_ifr"]') ||
    (field.id || "").endsWith("_ifr")
  );
};

const getCanvasEditorBody = (iframeEl) => {
  if (!isCanvasEditorIframe(iframeEl)) return null;
  try {
    const doc = iframeEl.contentDocument;
    const body = doc?.body || null;
    if (!body) return null;
    if (!body.isContentEditable) return null;
    return body;
  } catch (_) {
    return null;
  }
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

const isTextInputLike = (field) => {
  if (!(field instanceof Element) || field.tagName !== "INPUT") return false;
  const type = (field.type || "").toLowerCase();
  return type !== "checkbox" && type !== "radio";
};

const resolveEditableField = (target) => {
  if (!(target instanceof Element)) return null;

  if (isCanvasEditorIframe(target)) return target;

  if (target.tagName === "TEXTAREA" || isTextInputLike(target)) return target;

  if (!target.isContentEditable) return null;

  // Normalize nested contenteditable descendants (e.g., p/span inside TinyMCE body)
  // to one stable root so we create exactly one icon per editor.
  let root = target;
  while (
    root.parentElement &&
    root.parentElement.isContentEditable &&
    root.parentElement !== root.ownerDocument.body
  ) {
    root = root.parentElement;
  }
  return root;
};

const getCanvasEditorContainer = (field) =>
  field?.closest?.(
    ".ic-RichContentEditor, .discussion-reply-box, .tox, .tox-tinymce, .tox-editor-container"
  ) || null;

const pruneDuplicateButtonsForField = (field) => {
  if (!(field instanceof Element)) return;

  if (isCanvasEditorIframe(field)) {
    const currentContainer = getCanvasEditorContainer(field);
    state.buttons.forEach((button, trackedField) => {
      if (trackedField === field || !(trackedField instanceof Element)) return;
      if (!isCanvasEditorIframe(trackedField)) return;
      const sameId =
        Boolean(field.id) && Boolean(trackedField.id) && field.id === trackedField.id;
      const sameContainer =
        currentContainer &&
        getCanvasEditorContainer(trackedField) === currentContainer;
      if (!sameId && !sameContainer) return;
      if (button?.parentElement) button.remove();
      state.buttons.delete(trackedField);
    });
    return;
  }

  if (!field.isContentEditable) return;
  state.buttons.forEach((button, trackedField) => {
    if (trackedField === field || !(trackedField instanceof Element)) return;
    if (!trackedField.isContentEditable) return;
    const sameTree =
      field.contains(trackedField) || trackedField.contains(field);
    if (!sameTree) return;
    if (button?.parentElement) button.remove();
    state.buttons.delete(trackedField);
  });
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
  const editorBody = isCanvasEditorIframe(field) ? getCanvasEditorBody(field) : null;
  const effectiveField = editorBody || field;

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

  if (effectiveField.isContentEditable) {
    let targetField = effectiveField;
    const qlEditor =
      effectiveField.querySelector?.(".ql-editor") ||
      (effectiveField.classList?.contains?.("ql-editor") ? effectiveField : null);
    if (qlEditor) targetField = qlEditor;

    targetField.focus();

    const targetDoc = targetField.ownerDocument || document;
    const targetWin = targetDoc.defaultView || window;
    const selection = targetWin.getSelection();
    const range = targetDoc.createRange();
    range.selectNodeContents(targetField);
    selection.removeAllRanges();
    selection.addRange(range);

    const execSuccess =
      typeof targetDoc.execCommand === "function" &&
      targetDoc.execCommand("insertText", false, answerText);

    if (!execSuccess) {
      targetField.innerHTML = "";
      const p = targetDoc.createElement("p");
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

    if (effectiveField.tagName === "TEXTAREA" && nativeTextareaSetter) {
      nativeTextareaSetter.call(effectiveField, answerText);
    } else if (effectiveField.tagName === "INPUT" && nativeInputSetter) {
      nativeInputSetter.call(effectiveField, answerText);
    } else {
      effectiveField.value = answerText;
    }
  }

  // Dispatch events for React/Vue/Angular frameworks
  if (effectiveField.isContentEditable) {
    effectiveField.dispatchEvent(
      new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: "insertText",
        data: answerText,
      })
    );
  }

  effectiveField.dispatchEvent(
    new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: "insertText",
      data: answerText,
    })
  );
  effectiveField.dispatchEvent(new Event("change", { bubbles: true }));

  if (effectiveField.isContentEditable) {
    effectiveField.dispatchEvent(
      new KeyboardEvent("keydown", { bubbles: true, key: "Unidentified" })
    );
    effectiveField.dispatchEvent(
      new KeyboardEvent("keyup", { bubbles: true, key: "Unidentified" })
    );
  }

  effectiveField.dispatchEvent(new Event("blur", { bubbles: true }));

  setTimeout(() => {
    effectiveField.focus();
    effectiveField.dispatchEvent(new Event("focus", { bubbles: true }));
    if (hostname.includes("linkedin.com")) {
      const form =
        effectiveField.closest?.("form") || effectiveField.closest?.(".msg-form");
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
    const contextPack = extractContextPack(field);
    const pageContext = buildPageContextFromPack(contextPack);
    const question = getQuestionText(field, contextPack) || "Write a response";
    const fieldValue = getFieldValue(field);
    const platformKey = contextPack.platformKey || detectPlatformKey();
    const fieldHints = extractFieldHints(field, contextPack);

    const activeContexts = await getActiveCapturedContexts();
    if (platformKey === "gmail" || activeContexts.length > 0) {
      console.debug("[TextFill] generateAndFill payload", {
        platformKey,
        activeCapturedContexts: activeContexts.length,
        foregroundChars: contextPack?.foregroundContext?.length || 0,
        backgroundChars: contextPack?.backgroundContext?.length || 0,
        questionChars: question.length,
      });
    }

    const response = await chrome.runtime.sendMessage({
      type: "generateAnswer",
      question,
      fieldValue,
      pageContext,
      platformKey,
      action,
      instruction,
      capturedContexts: activeContexts.length > 0 ? activeContexts : null,
      fieldHints,
      contextPack,
    });

    if (!response?.ok) {
      showToast(response?.error || "Failed to generate. Check settings.", true);
      resetButton(button);
      return;
    }

    insertText(field, response.answer);
    setButtonSuccess(button);

    // Async memory extraction — fire-and-forget, non-blocking
    // Pass the user's own words (instruction + existing field content) alongside the AI answer.
    // The user's raw input is the primary signal for persona — the AI output was shaped by the extension.
    const userInput = [instruction, fieldValue].filter((s) => s?.trim()).join("\n").trim();
    setTimeout(() => triggerMemoryExtraction(response.answer, platformKey, pageContext, userInput), 3000);
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

// ─── Memory System ────────────────────────────────────────────────────────────

// Rate limit: one extraction per 5 minutes per tab session
let _lastMemoryExtraction = 0;
let _lastContextRefreshPrompt = 0;

// Action toast: persists until user acts (Save/Skip) or 12 s timeout
const showActionToast = (insight, section) => {
  // Don't stack action toasts — dismiss any existing one first
  document.querySelector(".tfa-toast-action")?.remove();

  const sectionLabel = { work: "Work", social: "Social", personal: "Personal", persona: "Persona" }[section] || section;

  const toast = document.createElement("div");
  toast.className = "tfa-toast tfa-toast-action";

  const textEl = document.createElement("span");
  textEl.className = "tfa-toast-text";
  textEl.textContent = `💡 Save to ${sectionLabel}: "${insight.slice(0, 55)}"`;

  const saveBtn = document.createElement("button");
  saveBtn.className = "tfa-toast-btn tfa-toast-btn-save";
  saveBtn.textContent = "Save";
  saveBtn.addEventListener("click", async () => {
    toast.remove();
    await chrome.runtime.sendMessage({ type: "appendToMemory", category: section, content: insight });
    showToast(`💡 Saved to ${sectionLabel} memory`);
  });

  const skipBtn = document.createElement("button");
  skipBtn.className = "tfa-toast-btn tfa-toast-btn-skip";
  skipBtn.textContent = "Skip";
  skipBtn.addEventListener("click", () => toast.remove());

  toast.appendChild(textEl);
  toast.appendChild(saveBtn);
  toast.appendChild(skipBtn);
  document.body.appendChild(toast);

  setTimeout(() => { if (toast.parentElement) toast.remove(); }, 12000);
};

const triggerMemoryExtraction = async (generatedText, platformKey, pageContext, userInput = "") => {
  const now = Date.now();
  // 10-minute cooldown — any page qualifies; confidence ≥ 0.85 filter enforced by AI
  if (now - _lastMemoryExtraction < 10 * 60 * 1000) return;
  if (!generatedText || generatedText.trim().length < 100) return;
  _lastMemoryExtraction = now;

  try {
    // Pass existing context so AI can avoid duplicating what's already stored
    const stored = await chrome.storage.local.get(["workContextText", "socialContextText", "alwaysContextText"]);
    const existingContext = [stored.workContextText, stored.socialContextText, stored.alwaysContextText]
      .filter(Boolean).join("\n").slice(0, 400);

    const result = await chrome.runtime.sendMessage({
      type: "extractMemory",
      generatedText,
      userInput: userInput.slice(0, 300), // user's own words — primary signal for persona
      platformKey,
      pageContext: (pageContext || "").slice(0, 300),
      existingContext,
    });

    if (!result?.ok || !result.memories?.length) return;

    const CAT_LABELS = { work: "Work", social: "Social", personal: "Personal", persona: "Persona" };

    for (const memory of result.memories) {
      const { category, content } = memory;
      if (!category || !content) continue;

      // Persona is the user's writing soul — require very high confidence before auto-saving.
      // A single generation rarely proves a consistent style pattern; ask the user to confirm instead.
      const autoSaveThreshold = category === "persona" ? 0.95 : 0.85;

      if (memory.confidence >= autoSaveThreshold) {
        // Auto-save the full structured memory atom
        await chrome.runtime.sendMessage({
          type: "saveMemory", memory: {
            category,
            type: memory.type || "preference",
            content: content.trim().slice(0, 150),
            tags: memory.tags || [],
            entities: memory.entities || [],
            importance: memory.importance || 2,
            confidence: memory.confidence,
            source: platformKey || "auto",
            private: false,
            related: [],
          }
        });
        const label = CAT_LABELS[category] || category;
        showToast(`💡 ${label} memory saved`);
      } else {
        // Ask user to confirm — one at a time
        showActionToast(content, category);
        await new Promise((r) => setTimeout(r, 200));
      }

      // High-signal insight: nudge the user to refresh persistent settings context.
      // This keeps long-term "always on" background context aligned with new reality.
      if (
        category !== "persona" &&
        (memory.importance || 1) >= 3 &&
        (memory.confidence || 0) >= 0.9
      ) {
        const nowTs = Date.now();
        if (nowTs - _lastContextRefreshPrompt > 30 * 60 * 1000) {
          _lastContextRefreshPrompt = nowTs;
          const label = CAT_LABELS[category] || category;
          showToast(
            `High-signal ${label} info detected. Consider updating ${label} context in Settings.`
          );
        }
      }
    }
  } catch (_) {
    // Memory extraction is best-effort — silently ignore errors
  }
};

// ─── Field Scanning & Button Management ───────────────────────────────────────

const getPlatformSelectors = () => {
  const { hostname, pathname } = getLocationSnapshot();
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
  } else if (isCanvasLocation(hostname, pathname)) {
    selectors = [...PLATFORM_SELECTORS.canvas];
  } else {
    selectors = PLATFORM_SELECTORS.general;
  }

  return selectors.join(", ");
};

const scanAndAddButtons = () => {
  state.scanScheduled = false;

  const selector = getPlatformSelectors();
  const candidates = document.querySelectorAll(selector);
  const seen = new Set();

  candidates.forEach((candidate) => {
    const field = resolveEditableField(candidate);
    if (!field || seen.has(field)) return;
    seen.add(field);
    pruneDuplicateButtonsForField(field);

    if (!isEditableField(field) || !isVisibleField(field)) return;

    if (state.buttons.has(field)) {
      positionButton(field, state.buttons.get(field));
      return;
    }

    const rect = field.getBoundingClientRect();
    const minHeight = field.isContentEditable ? 8 : 20;
    if (rect.width < 100 || rect.height < minHeight) return;
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
  syncContextFabVisibility();
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
    syncContextFabVisibility();
  });
};

const cleanupOrphanedButtons = () => {
  state.buttons.forEach((button, field) => {
    if (!document.contains(field)) {
      if (button.parentElement) button.remove();
      state.buttons.delete(field);
    }
  });
  syncContextFabVisibility();
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

const observeBodyMutations = () => {
  if (!document.body || !state.observer) return;
  state.observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: OBSERVER_ATTRIBUTE_FILTER,
  });
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

  observeBodyMutations();

  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      state.observer?.disconnect();
    } else if (document.body) {
      observeBodyMutations();
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
      if (e.target?.matches?.(EDITABLE_INPUT_SELECTOR)) {
        scheduleScan();
      }
    },
    { passive: true, capture: true }
  );

  // When the user clicks/focuses a field, immediately create the button for it.
  // This bypasses selector matching so it works for any field on any site,
  // including LinkedIn panels that use class names not in our selector list.
  // Guard: skip fields inside the extension's own UI (class names start with "tfa-").
  document.addEventListener("focusin", (e) => {
    const field = resolveEditableField(e.target);
    if (!field) return;
    pruneDuplicateButtonsForField(field);
    if (field.closest('[class*="tfa-"]')) return; // skip extension's own UI

    if (state.buttons.has(field)) {
      // Already tracked — just reposition in case it was hidden
      positionButton(field, state.buttons.get(field));
      syncContextFabVisibility();
      return;
    }

    if (!isEditableField(field) || isSearchField(field) || isLikelyPersonalInfoField(field)) return;

    const btn = getOrCreateButton(field);
    positionButton(field, btn);
    syncContextFabVisibility();
  }, { passive: true, capture: true });
};

const initializeExtension = async () => {
  setupUrlChangeDetection();

  // Load context library from storage
  await syncCapturedContextsFromStorage();

  initializeButtons();
  createFloatingFAB();
  updateContextIndicators();
  proactivelyCacheJobDescription();
};

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.capturedContexts) return;
  const next = changes.capturedContexts.newValue;
  state.capturedContexts = normalizeCapturedContexts(next);
  updateContextIndicators();
});

if (shouldInitializeInThisFrame()) {
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initializeExtension);
  } else {
    initializeExtension();
  }
}
