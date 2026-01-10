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

// Platform-specific selectors for better detection
const PLATFORM_SELECTORS = {
  gmail: [
    'div[aria-label*="Message Body"]',
    'div[contenteditable="true"][aria-label*="Compose"]',
    'div[g_editable="true"]',
    'div[role="textbox"][aria-label*="Message"]',
    'div.editable[role="textbox"]'
  ],
  linkedin: [
    // Messages
    'div.msg-form__contenteditable',
    'div.msg-form__msg-content-container',
    // Comments and replies
    'div.ql-editor[contenteditable="true"]',
    'div[data-placeholder*="Add a comment"]',
    'div[data-placeholder*="comment"]',
    'div[aria-label*="Add a comment"]',
    'div[aria-label*="Text editor"]',
    'div.comments-comment-box__form-container [contenteditable="true"]',
    'div.comments-comment-texteditor [contenteditable="true"]',
    'div.feed-shared-update-v2__comments-container [contenteditable="true"]',
    // Posts
    'div[data-placeholder*="Start a post"]',
    'div[aria-label*="Start a post"]',
    'div.share-creation-state__text-editor [contenteditable="true"]',
    // General contenteditable
    'div[contenteditable="true"][role="textbox"]'
  ],
  facebook: [
    'div[contenteditable="true"][role="textbox"]',
    'div[aria-label*="Message"]',
    'div[aria-label*="Write a comment"]',
    'div[aria-label*="Write a reply"]',
    'div[aria-label*="Write a public comment"]',
    'div.notranslate[contenteditable="true"]'
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
    'div.DraftEditor-root [contenteditable="true"]'
  ],
  threads: [
    'div[contenteditable="true"][role="textbox"]',
    'div[aria-label*="Reply"]',
    'div[aria-label*="Start a thread"]'
  ],
  instagram: [
    'textarea[aria-label*="Add a comment"]',
    'textarea[placeholder*="Add a comment"]',
    'div[contenteditable="true"][role="textbox"]'
  ],
  youtube: [
    'div[contenteditable="true"]#contenteditable-root',
    'div[aria-label*="Add a comment"]',
    'div[aria-label*="Add a public comment"]',
    'div#placeholder-area'
  ],
  reddit: [
    'div[contenteditable="true"][role="textbox"]',
    'textarea[placeholder*="What are your thoughts"]',
    'div.public-DraftEditor-content[contenteditable="true"]'
  ],
  general: [
    'textarea',
    'input[type="text"]',
    'input[type="search"]',
    'input[type="url"]',
    'input:not([type])',
    '[contenteditable="true"]',
    '[contenteditable=""]',
    '[role="textbox"]',
    'div.ql-editor',
    'div.tox-edit-area',
    'div.CodeMirror-code'
  ]
};

const state = {
  activeField: null,
  buttons: new Map(),
  cachedJobDescription: null,
  currentJobUrl: null,
  isGenerating: false,
  activeMode: "general",
  activeSocialStyle: "genz",
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
    console.warn('[TextFill] SessionStorage access denied:', e.message);
    return null;
  }
};

const setToSessionStorage = (key, value) => {
  try {
    sessionStorage.setItem(key, value);
    return true;
  } catch (e) {
    console.warn('[TextFill] SessionStorage write failed:', e.message);
    return false;
  }
};

const extractSectionText = (element, maxLength = Infinity) => {
  if (!element) {
    return "";
  }
  let text = element.innerText || "";
  if (text.length > maxLength) {
    text = text.substring(0, maxLength);
  }
  return normalizeText(text);
};

const findJobSections = (searchAll = false) => {
  const sections = [];
  
  // Search in all elements including hidden ones (for tabbed interfaces like Ashby)
  const selector = searchAll 
    ? "h1, h2, h3, h4, strong, b, [role='heading']"
    : "h1, h2, h3, h4, strong, b";
  const candidates = Array.from(document.querySelectorAll(selector));

  candidates.forEach((heading) => {
    const headingText = normalizeText(heading.innerText || "").toLowerCase();
    if (!headingText) {
      return;
    }
    if (JOB_HINTS.some((hint) => headingText.includes(hint))) {
      const container =
        heading.closest("section, article, div, [role='tabpanel']") || heading.parentElement;
      const text = extractSectionText(container);
      if (text && text.length > 100) {
        sections.push(text);
      }
    }
  });

  return sections;
};

// Look for job description in hidden tabs/panels (Ashby, Greenhouse, Lever, etc.)
const findHiddenJobContent = () => {
  // Ashby: Look for Overview tab content
  const ashbyOverview = document.querySelector(
    '[data-tab="overview"], [aria-labelledby*="overview"], [id*="overview"], ' +
    '[class*="overview"], [class*="job-description"], [class*="jobDescription"]'
  );
  if (ashbyOverview) {
    const text = extractSectionText(ashbyOverview);
    if (text && text.length > 200) {
      return text;
    }
  }

  // Look in all tab panels (visible or hidden)
  const tabPanels = document.querySelectorAll(
    '[role="tabpanel"], [class*="tab-panel"], [class*="tabpanel"], ' +
    '[class*="TabPanel"], [data-testid*="tab"]'
  );
  for (const panel of tabPanels) {
    const text = extractSectionText(panel);
    const lowerText = text.toLowerCase();
    // Check if this panel has job description content
    if (text.length > 300 && JOB_HINTS.some(hint => lowerText.includes(hint))) {
      return text;
    }
  }

  // Look for hidden elements that might contain job info
  const hiddenContainers = document.querySelectorAll(
    '[hidden], [aria-hidden="true"], [style*="display: none"], ' +
    '[style*="display:none"], .hidden, .hide'
  );
  for (const container of hiddenContainers) {
    const text = extractSectionText(container);
    const lowerText = text.toLowerCase();
    if (text.length > 300 && JOB_HINTS.some(hint => lowerText.includes(hint))) {
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

  const tabButtons = document.querySelectorAll('[role="tab"], button[class*="tab"], a[class*="tab"]');
  for (const btn of tabButtons) {
    const text = btn.textContent?.trim().toLowerCase();
    if (text === 'overview' || text === 'job description' || text === 'description') {
      return btn;
    }
  }

  return null;
};

// Find the Application tab button to switch back
const findApplicationTabButton = () => {
  const allButtons = document.querySelectorAll('button, a, [role="tab"]');
  for (const btn of allButtons) {
    const text = btn.textContent?.trim().toLowerCase();
    if (text === 'application' || text === 'apply' || text === 'apply now') {
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
        const main = document.querySelector('main, article, [role="tabpanel"]:not([hidden])');
        if (main) {
          jobDescription = extractSectionText(main, MAX_CONTEXT_CHARS);
        }
      }

      if (applicationBtn) {
        applicationBtn.click();
      }

      setTimeout(() => {
        window.scrollTo(0, scrollPos);
      }, 100);

      if (jobDescription && jobDescription.length > 200) {
        const storageKey = getJobStorageKey();
        cacheJobDescription(storageKey, jobDescription);
      }

      resolve(jobDescription);
    };

    const targetPanel = document.querySelector('[role="tabpanel"]:not([hidden])');
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

// Check if content looks like form content (not job description)
const isFormContent = (text) => {
  if (!text) return true;
  const formIndicators = [
    'upload your resume',
    'autofill from resume',
    'full name',
    'preferred name',
    'email',
    'phone number',
    'submit application',
    'upload file',
    'drag and drop',
    'personal information'
  ];
  const lowerText = text.toLowerCase();
  const matches = formIndicators.filter(indicator => lowerText.includes(indicator));
  return matches.length >= 3;
};

// Get unique key for current job posting (uses full path to avoid mixing jobs)
const getJobStorageKey = () => {
  const hostname = window.location.hostname.toLowerCase();
  const pathname = window.location.pathname;
  const search = window.location.search;

  // For Workday: Extract job ID from URL to persist across login/apply flow
  // Workday URLs look like: /JobID/Software-Engineer/1234567890
  // Or with query params: ?jobId=1234567890
  if (hostname.includes('myworkdayjobs.com')) {
    // Try to extract job ID from path segments
    const pathSegments = pathname.split('/').filter(Boolean);
    const jobIdFromPath = pathSegments.find(segment => /^\d{5,}$/.test(segment)); // 5+ digits

    if (jobIdFromPath) {
      return `tfa_job_workday_${hostname}_${jobIdFromPath}`;
    }

    // Try to extract from query params
    const urlParams = new URLSearchParams(search);
    const jobIdFromQuery = urlParams.get('jobId') || urlParams.get('job_id');

    if (jobIdFromQuery) {
      return `tfa_job_workday_${hostname}_${jobIdFromQuery}`;
    }
  }

  // For other platforms: Use full pathname - each job has unique URL like /jobs/swe-intern-123
  return `tfa_job_${hostname}${pathname}`;
};

// Check if we navigated to a different job page
const checkUrlChanged = () => {
  const currentUrl = window.location.href;
  if (state.currentJobUrl && state.currentJobUrl !== currentUrl) {
    // URL changed - clear in-memory cache (forces fresh extraction)
    state.cachedJobDescription = null;
  }
  state.currentJobUrl = currentUrl;
};

const extractJobDescription = () => {
  // Check if URL changed (navigated to different job)
  checkUrlChanged();

  // Return cached description if available for this job
  if (state.cachedJobDescription) {
    return state.cachedJobDescription;
  }

  const storageKey = getJobStorageKey();
  const cached = getFromSessionStorage(storageKey);
  if (cached && cached.length > 200) {
    state.cachedJobDescription = cached;
    return cached;
  }

  // First try visible sections
  let sections = findJobSections(false);
  if (sections.length > 0) {
    const result = sections.join("\n\n").slice(0, MAX_CONTEXT_CHARS);
    cacheJobDescription(storageKey, result);
    return result;
  }

  // Try hidden tabs/panels (Ashby, etc.)
  const hiddenContent = findHiddenJobContent();
  if (hiddenContent) {
    const result = hiddenContent.slice(0, MAX_CONTEXT_CHARS);
    cacheJobDescription(storageKey, result);
    return result;
  }

  // Search all elements including hidden
  sections = findJobSections(true);
  if (sections.length > 0) {
    const result = sections.join("\n\n").slice(0, MAX_CONTEXT_CHARS);
    cacheJobDescription(storageKey, result);
    return result;
  }

  // Fallback to main content
  const main = document.querySelector("main, article") || document.body;
  const text = extractSectionText(main);
  return text.slice(0, MAX_CONTEXT_CHARS);
};

const cacheJobDescription = (key, text) => {
  if (text && text.length > 200) {
    state.cachedJobDescription = text;
    setToSessionStorage(key, text);
  }
};

// Track URL changes for SPA navigation (defined early, used later)
let lastUrl = window.location.href;

// Proper URL change detection using history API interception
const setupUrlChangeDetection = () => {
  // Intercept pushState and replaceState for SPA navigation
  const originalPushState = history.pushState;
  const originalReplaceState = history.replaceState;

  history.pushState = function(...args) {
    originalPushState.apply(this, args);
    handleUrlChange();
  };

  history.replaceState = function(...args) {
    originalReplaceState.apply(this, args);
    handleUrlChange();
  };

  // Listen for popstate (back/forward navigation)
  window.addEventListener('popstate', handleUrlChange);
  window.addEventListener('hashchange', handleUrlChange);
};

// Handle URL changes efficiently
const handleUrlChange = () => {
  const currentUrl = window.location.href;
  if (currentUrl !== lastUrl) {
    lastUrl = currentUrl;
    state.cachedJobDescription = null;
    state.currentJobUrl = currentUrl;

    // Re-run proactive caching for new page (important for Workday multi-step)
    if (typeof proactivelyCacheJobDescription === 'function') {
      proactivelyCacheJobDescription();
    }

    // Rescan for new fields
    if (typeof scheduleScan === 'function') {
      scheduleScan();
    }
  }
};

// Detect known job platforms for proactive caching
const detectJobPlatform = () => {
  const hostname = window.location.hostname.toLowerCase();
  const pathname = window.location.pathname.toLowerCase();

  // Platform detection
  const platforms = {
    ashby: hostname.includes('ashbyhq.com') || hostname.includes('jobs.ashbyhq.com'),
    greenhouse: hostname.includes('greenhouse.io') || hostname.includes('boards.greenhouse.io'),
    lever: hostname.includes('lever.co') || hostname.includes('jobs.lever.co'),
    workable: hostname.includes('workable.com') || hostname.includes('apply.workable.com'),
    workday: hostname.includes('myworkdayjobs.com') || hostname.includes('wd1.myworkdayjobs.com') || hostname.includes('wd5.myworkdayjobs.com'),
    jobvite: hostname.includes('jobvite.com'),
    smartrecruiters: hostname.includes('smartrecruiters.com'),
    icims: hostname.includes('icims.com')
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

    console.log('[TextFill] Detected job platform:', platform);

    await new Promise(resolve => setTimeout(resolve, 1500));

    const storageKey = getJobStorageKey();
    const cached = getFromSessionStorage(storageKey);

    if (cached && cached.length > 200) {
      console.log('[TextFill] Job description already cached');
      return;
    }

  // For Workday: Check if on job details page (before Apply button)
  if (platform === 'workday') {
    const isJobDetailsPage = document.querySelector('[data-automation-id="jobPostingDescription"]') ||
                              document.querySelector('.jobdescription') ||
                              document.querySelector('#job-description') ||
                              document.querySelector('[data-automation-id="jobPostingHeader"]') ||
                              document.querySelector('.css-1tnvnpa') || // Workday job description container
                              document.querySelector('[aria-label*="Job Description"]');

    // Also check if Apply button exists (confirms it's the job details page)
    const hasApplyButton = document.querySelector('[data-automation-id="applyButton"]') ||
                           document.querySelector('button[title*="Apply"]') ||
                           Array.from(document.querySelectorAll('button')).find(btn =>
                             btn.textContent.toLowerCase().includes('apply')
                           );

    if (isJobDetailsPage || hasApplyButton) {
      console.log('[TextFill] Workday job details page detected - caching description');
      const description = extractJobDescription();
      if (description && description.length > 200) {
        cacheJobDescription(storageKey, description);
        console.log('[TextFill] Cached Workday job description:', description.length, 'chars');
        return;
      }
    }
  }

  // For Ashby/Greenhouse/Lever: Auto-fetch from Overview tab
  if (platform === 'ashby' || platform === 'greenhouse' || platform === 'lever') {
    const overviewBtn = findOverviewTabButton();

    if (overviewBtn) {
      console.log('[TextFill] Found Overview tab - auto-fetching job description');
      const fetched = await autoFetchJobDescription();

      if (fetched && fetched.length > 200) {
        console.log('[TextFill] Proactively cached job description:', fetched.length, 'chars');
        return;
      }
    }
  }

    const description = extractJobDescription();
    if (description && description.length > 200 && !isFormContent(description)) {
      cacheJobDescription(storageKey, description);
      console.log('[TextFill] Cached job description from page:', description.length, 'chars');
    }
  } catch (error) {
    console.error('[TextFill] Proactive caching failed:', error.message);
  }
};

const extractPageContext = (field) => {
  const title = document.title || "";
  const url = window.location.href || "";
  const metaDescription = document.querySelector("meta[name='description']")?.content || "";
  const fieldContainer = field?.closest("section, form, div");
  const fieldContext = extractSectionText(fieldContainer, 2000);
  const pageText = extractSectionText(document.body, MAX_PAGE_CHARS);

  const parts = [
    title ? `Page title: ${title}` : "",
    url ? `URL: ${url}` : "",
    metaDescription ? `Meta description: ${metaDescription}` : "",
    fieldContext ? `Field context: ${fieldContext}` : "",
    pageText ? `Page text: ${pageText}` : "",
  ].filter(Boolean);

  return parts.join("\n").slice(0, MAX_PAGE_CHARS);
};

const getQuestionText = (field) => {
  if (!(field instanceof Element)) {
    return "";
  }

  const ariaLabel = field.getAttribute("aria-label");
  if (ariaLabel) {
    return ariaLabel.trim();
  }

  const ariaLabelledBy = field.getAttribute("aria-labelledby");
  if (typeof ariaLabelledBy === "string" && ariaLabelledBy.trim()) {
    const labelled = ariaLabelledBy
      .trim()
      .split(/\s+/)
      .map((id) => document.getElementById(id))
      .filter((element) => element && typeof element.textContent === "string")
      .map((element) => element.textContent.trim())
      .filter(text => text)
      .join(" ")
      .trim();
    if (labelled) {
      return labelled;
    }
  }

  const label = document.querySelector(`label[for="${field.id}"]`);
  if (label?.innerText) {
    return label.innerText.trim();
  }

  const placeholder =
    field.placeholder ||
    field.getAttribute("data-placeholder") ||
    field.getAttribute("aria-placeholder") ||
    "";
  if (placeholder) {
    return placeholder.trim();
  }

  const describedBy = field.getAttribute("aria-describedby");
  if (describedBy) {
    const described = describedBy
      .split(" ")
      .map((id) => document.getElementById(id)?.innerText || "")
      .join(" ")
      .trim();
    if (described) {
      return described;
    }
  }

  const parentText = field.closest("section, form, div")?.innerText || "";
  return normalizeText(parentText.split("\n").slice(0, 3).join(" "));
};

const getFieldValue = (field) => {
  if (field?.isContentEditable) {
    return field.textContent || "";
  }
  return field?.value || "";
};

// Get the extension's logo URL
const getLogoUrl = () => {
  return chrome.runtime.getURL('logo.png');
};

const getOrCreateButton = (field) => {
  if (state.buttons.has(field)) {
    return state.buttons.get(field);
  }

  const button = document.createElement("button");
  button.className = "tfa-icon-button";
  button.type = "button";
  button.title = "Fill with AI (right-click for settings)";

  const img = document.createElement("img");
  img.src = getLogoUrl();
  img.alt = "AI Fill";
  img.className = "tfa-logo";
  button.appendChild(img);

  // Style indicator for social mode
  const styleIndicator = document.createElement("span");
  styleIndicator.className = "tfa-style-indicator";
  button.appendChild(styleIndicator);

  // Left click: generate
  button.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await generateAndFill(field, button);
  });

  // Right click: open settings
  button.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    e.stopPropagation();
    chrome.runtime.sendMessage({ type: "openSettings" });
  });

  state.buttons.set(field, button);
  return button;
};

// Position the button inside/near the field
const positionButton = (field, button) => {
  const rect = field.getBoundingClientRect();
  if (!rect.width || !rect.height) {
    button.style.display = "none";
    return;
  }

  const top = rect.top + window.scrollY + 6;
  const left = rect.right + window.scrollX - 32;

  // Position at top-right corner of the field
  button.style.position = "absolute";
  button.style.top = `${Math.max(top, 0)}px`;
  button.style.left = `${Math.max(left, 0)}px`;
  button.style.zIndex = "2147483647";

  // Update style indicator for social mode
  if (state.activeMode === "social") {
    const styleMap = { genz: "G", casual: "C", professional: "P" };
    button.dataset.style = state.activeSocialStyle;
    const indicator = button.querySelector(".tfa-style-indicator");
    if (indicator) {
      indicator.textContent = styleMap[state.activeSocialStyle] || "G";
    }
  } else {
    delete button.dataset.style;
  }

  if (!button.parentElement) {
    document.body.appendChild(button);
  }
};

const isEditableField = (field) => {
  if (!field) return false;
  if (field.disabled || field.readOnly || field.getAttribute("aria-disabled") === "true") {
    return false;
  }
  if (field.isContentEditable) {
    return true;
  }
  return field.tagName === "TEXTAREA" || field.tagName === "INPUT";
};

const isVisibleField = (field) => {
  if (!field || !field.getClientRects().length) {
    return false;
  }
  const style = window.getComputedStyle(field);
  return style.visibility !== "hidden" && style.display !== "none";
};

const isSearchField = (field) => {
  const placeholder = (field.placeholder || field.getAttribute("aria-placeholder") || "").toLowerCase();
  const name = (field.name || "").toLowerCase();
  return placeholder.includes("search") || placeholder.includes("filter") || name.includes("search");
};

const isLikelyPersonalInfoField = (field) => {
  // GLOBALLY exclude personal info fields (name, email, phone, address, etc.)
  const autocomplete = (field.autocomplete || "").toLowerCase();
  const name = (field.name || "").toLowerCase();
  const id = (field.id || "").toLowerCase();
  const type = (field.type || "").toLowerCase();
  const placeholder = (field.placeholder || field.getAttribute("aria-placeholder") || "").toLowerCase();
  const ariaLabel = (field.getAttribute("aria-label") || "").toLowerCase();

  const combined = `${autocomplete} ${name} ${id} ${placeholder} ${ariaLabel}`;

  // Exclude if type is personal
  if (type === "email" || type === "tel" || type === "password" || type === "number") {
    return true;
  }

  // Comprehensive list of personal info patterns
  const personalPatterns = [
    "email", "e-mail", "mail",
    "phone", "tel", "telephone", "mobile", "cell",
    "name", "first-name", "last-name", "given-name", "family-name", "full-name", "firstname", "lastname",
    "address", "street", "city", "state", "zip", "postal", "country",
    "password", "pwd", "pass",
    "ssn", "social-security",
    "dob", "birth", "birthday",
    "credit", "card", "cvv", "expir",
    "salary", "compensation", "wage"
  ];

  return personalPatterns.some(pattern => combined.includes(pattern));
};

const loadActiveMode = async () => {
  try {
    const data = await chrome.storage.local.get(["mode", "socialStyle"]);
    state.activeMode = data.mode || "general";
    state.activeSocialStyle = data.socialStyle || "genz";
  } catch (error) {
    state.activeMode = "general";
    state.activeSocialStyle = "genz";
  }
};

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

  const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
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
  const overlay = button.querySelector(".tfa-loading-overlay");
  if (overlay) overlay.remove();

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

  setTimeout(() => {
    if (successOverlay.parentElement) {
      successOverlay.remove();
    }
  }, 1500);
};

const resetButton = (button) => {
  const overlay = button.querySelector(".tfa-loading-overlay, .tfa-success-overlay");
  if (overlay) overlay.remove();

  button.disabled = false;
  button.title = "Fill with AI";
};

const generateAndFill = async (field, button) => {
  if (state.isGenerating || button.dataset.generating === 'true') return;

  button.dataset.generating = 'true';
  state.isGenerating = true;

  setButtonLoading(button);

  try {
    // Get job description (auto-fetch if needed)
    let jobDescription = extractJobDescription();
    
    if (isFormContent(jobDescription)) {
      const overviewBtn = findOverviewTabButton();
      if (overviewBtn) {
        const fetched = await autoFetchJobDescription();
        if (fetched && !isFormContent(fetched)) {
          jobDescription = fetched;
        }
      }
    }

    const question = getQuestionText(field) || "Job application response";
    const pageContext = extractPageContext(field);

    const response = await chrome.runtime.sendMessage({
      type: "generateAnswer",
      question,
      fieldValue: getFieldValue(field),
      jobDescription,
      pageContext,
    });

    if (!response?.ok) {
      showToast(response?.error || "Failed to generate. Check settings.", true);
      resetButton(button);
      return;
    }

    // Apply character limit for LinkedIn messages (3000 char limit)
    let answerText = response.answer;
    const hostname = window.location.hostname.toLowerCase();
    if (hostname.includes('linkedin.com') && answerText.length > 2900) {
      // Truncate at sentence boundary if possible, leave buffer for safety
      const truncated = answerText.substring(0, 2900);
      const lastSentence = Math.max(
        truncated.lastIndexOf('. '),
        truncated.lastIndexOf('! '),
        truncated.lastIndexOf('? ')
      );
      answerText = lastSentence > 2000 ? truncated.substring(0, lastSentence + 1) : truncated;
    }

    if (field.isContentEditable) {
      // For LinkedIn/Quill editors, need special handling
      // Find the actual editable element (may be nested ql-editor)
      let targetField = field;
      const qlEditor = field.querySelector('.ql-editor') ||
                       (field.classList.contains('ql-editor') ? field : null);
      if (qlEditor) {
        targetField = qlEditor;
      }

      // Focus the field first
      targetField.focus();

      // Select all existing content
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(targetField);
      selection.removeAllRanges();
      selection.addRange(range);

      // Try execCommand first (works with many rich text editors)
      const execSuccess = document.execCommand('insertText', false, answerText);

      if (!execSuccess) {
        // Fallback: Clear and create proper paragraph structure
        targetField.innerHTML = '';
        const p = document.createElement('p');
        p.textContent = answerText;
        targetField.appendChild(p);
      }

      // Move cursor to end
      range.selectNodeContents(targetField);
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);

    } else {
      const nativeInputSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
      const nativeTextareaSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;

      if (field.tagName === 'TEXTAREA' && nativeTextareaSetter) {
        nativeTextareaSetter.call(field, answerText);
      } else if (field.tagName === 'INPUT' && nativeInputSetter) {
        nativeInputSetter.call(field, answerText);
      } else {
        field.value = answerText;
      }
    }

    // Dispatch events in proper order for React/Vue/Angular frameworks
    // beforeinput is critical for contenteditable change detection
    if (field.isContentEditable) {
      field.dispatchEvent(new InputEvent("beforeinput", {
        bubbles: true,
        cancelable: true,
        inputType: 'insertText',
        data: answerText
      }));
    }

    field.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      cancelable: true,
      inputType: 'insertText',
      data: answerText
    }));
    field.dispatchEvent(new Event("change", { bubbles: true }));

    if (field.isContentEditable) {
      // Additional events for rich text editors
      field.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: 'Unidentified' }));
      field.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true, key: 'Unidentified' }));
    }

    // Blur and refocus to trigger validation and enable send button
    field.dispatchEvent(new Event("blur", { bubbles: true }));
    setTimeout(() => {
      field.focus();
      field.dispatchEvent(new Event("focus", { bubbles: true }));

      // For LinkedIn, also try to trigger the form state update
      if (hostname.includes('linkedin.com')) {
        const form = field.closest('form') || field.closest('.msg-form');
        if (form) {
          form.dispatchEvent(new Event("input", { bubbles: true }));
        }
      }
    }, 50);

    setButtonSuccess(button);

  } catch (err) {
    showToast(err.message || "Something went wrong", true);
    resetButton(button);
  } finally {
    delete button.dataset.generating;
    state.isGenerating = false;
  }
};

const showToast = (message, isError = false) => {
  const existing = document.querySelector('.tfa-toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `tfa-toast ${isError ? 'tfa-toast-error' : ''}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => {
    try {
      if (toast && toast.parentElement) {
        toast.remove();
      }
    } catch (e) {
      // Ignore - page might have unloaded
    }
  }, 4000);
};

// Get platform-optimized selectors
const getPlatformSelectors = () => {
  const hostname = window.location.hostname.toLowerCase();
  let selectors = [];

  // Platform-specific selectors
  if (hostname.includes("mail.google.com")) {
    selectors = [...PLATFORM_SELECTORS.gmail, ...PLATFORM_SELECTORS.general];
  } else if (hostname.includes("linkedin.com")) {
    selectors = [...PLATFORM_SELECTORS.linkedin, ...PLATFORM_SELECTORS.general];
  } else if (hostname.includes("facebook.com") || hostname.includes("messenger.com")) {
    selectors = [...PLATFORM_SELECTORS.facebook, ...PLATFORM_SELECTORS.general];
  } else if (hostname.includes("twitter.com") || hostname.includes("x.com")) {
    selectors = [...PLATFORM_SELECTORS.twitter, ...PLATFORM_SELECTORS.general];
  } else if (hostname.includes("threads.net")) {
    selectors = [...PLATFORM_SELECTORS.threads, ...PLATFORM_SELECTORS.general];
  } else if (hostname.includes("instagram.com")) {
    selectors = [...PLATFORM_SELECTORS.instagram, ...PLATFORM_SELECTORS.general];
  } else if (hostname.includes("youtube.com")) {
    selectors = [...PLATFORM_SELECTORS.youtube, ...PLATFORM_SELECTORS.general];
  } else if (hostname.includes("reddit.com")) {
    selectors = [...PLATFORM_SELECTORS.reddit, ...PLATFORM_SELECTORS.general];
  } else {
    selectors = PLATFORM_SELECTORS.general;
  }

  return selectors.join(", ");
};

// Check if field is a messaging/social/composition field
const isMessagingField = (field) => {
  const ariaLabel = (field.getAttribute("aria-label") || "").toLowerCase();
  const placeholder = (field.placeholder || field.getAttribute("data-placeholder") || "").toLowerCase();
  const role = (field.getAttribute("role") || "").toLowerCase();
  const className = (field.className || "").toLowerCase();
  const testId = (field.getAttribute("data-testid") || "").toLowerCase();

  const messagingPatterns = [
    "message", "compose", "write", "reply", "comment",
    "post", "chat", "conversation", "note", "memo",
    "tweet", "thread", "status", "update", "share"
  ];

  const combined = `${ariaLabel} ${placeholder} ${role} ${className} ${testId}`;
  return messagingPatterns.some(pattern => combined.includes(pattern));
};

// Scan for text fields and add buttons
const scanAndAddButtons = () => {
  state.scanScheduled = false; // Clear debounce flag

  const selector = getPlatformSelectors();
  const fields = document.querySelectorAll(selector);

  fields.forEach((field) => {
    if (!isEditableField(field) || !isVisibleField(field)) {
      return;
    }

    // Skip if already has a button
    if (state.buttons.has(field)) {
      positionButton(field, state.buttons.get(field));
      return;
    }

    const rect = field.getBoundingClientRect();
    // Only add to fields with reasonable size
    if (rect.width < 100 || rect.height < 20) {
      return;
    }

    // Skip search fields
    if (isSearchField(field)) return;

    // GLOBALLY exclude personal info fields (not mode-dependent)
    if (isLikelyPersonalInfoField(field)) {
      return;
    }

    // For small input fields in general mode, only show if it's a messaging field
    const isTextarea = field.tagName === "TEXTAREA" || field.isContentEditable;
    if (state.activeMode === "general" && !isTextarea && rect.height < 50) {
      if (!isMessagingField(field)) {
        return; // Skip small non-messaging fields
      }
    }

    const button = getOrCreateButton(field);
    positionButton(field, button);
  });
};

const updateButtonPositions = () => {
  if (state.scrollTicking) return;

  state.scrollTicking = true;

  requestAnimationFrame(() => {
    const positions = [];

    state.buttons.forEach((button, field) => {
      const rect = field.getBoundingClientRect();
      const visible = isVisibleField(field) && rect.bottom >= 0 && rect.top <= window.innerHeight;
      positions.push({ button, field, rect, visible });
    });

    positions.forEach(({ button, field, rect, visible }) => {
      if (!visible) {
        button.style.display = 'none';
      } else {
        button.style.display = '';
        positionButton(field, button);
      }
    });

    state.scrollTicking = false;
  });
};

const cleanupOrphanedButtons = () => {
  state.buttons.forEach((button, field) => {
    if (!document.contains(field)) {
      if (button.parentElement) {
        button.remove();
      }
      state.buttons.delete(field);
    }
  });
};

const scheduleScan = () => {
  if (state.scanScheduled) return;
  state.scanScheduled = true;

  if ('requestIdleCallback' in window) {
    state.idleCallbackId = requestIdleCallback(() => {
      scanAndAddButtons();
      cleanupOrphanedButtons();
    }, { timeout: 2000 });
  } else {
    setTimeout(() => {
      scanAndAddButtons();
      cleanupOrphanedButtons();
    }, 150);
  }
};

// Initial scan and setup observers
const initializeButtons = () => {
  loadActiveMode().then(scanAndAddButtons);

  // Advanced MutationObserver with optimizations
  state.observer = new MutationObserver((mutations) => {
    // Check if any mutation actually added/removed elements or changed attributes
    let shouldScan = false;

    for (const mutation of mutations) {
      if (mutation.type === 'childList' && (mutation.addedNodes.length > 0 || mutation.removedNodes.length > 0)) {
        shouldScan = true;
        break;
      }
      if (mutation.type === 'attributes' && mutation.attributeName) {
        const attrName = mutation.attributeName;
        // Only care about visibility/state changes
        if (attrName === 'class' || attrName === 'style' || attrName === 'hidden' || attrName === 'aria-hidden') {
          shouldScan = true;
          break;
        }
      }
    }

    if (shouldScan) {
      scheduleScan();
    }
  });

  // Observe with specific filters to reduce noise (only if document.body exists)
  if (document.body) {
    state.observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'contenteditable', 'role'] // Only watch relevant attributes
    });
  }

  // Disconnect observer when page is hidden to save resources
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      state.observer?.disconnect();
    } else if (document.body) {
      state.observer?.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['class', 'style', 'hidden', 'aria-hidden', 'contenteditable', 'role']
      });
      scheduleScan(); // Rescan when page becomes visible
    }
  });

  // Update positions on scroll/resize with passive listeners
  window.addEventListener('scroll', updateButtonPositions, { passive: true });
  document.addEventListener('scroll', updateButtonPositions, { passive: true, capture: true });
  window.addEventListener('resize', updateButtonPositions, { passive: true });

  // Detect React/Vue state changes via input events
  document.addEventListener('input', (e) => {
    // React may render new fields on input, schedule rescan
    if (e.target?.matches?.('input, textarea, [contenteditable="true"]')) {
      scheduleScan();
    }
  }, { passive: true, capture: true });
};

chrome.storage.onChanged.addListener((changes) => {
  if (changes.mode) {
    state.activeMode = changes.mode.newValue || "general";
    scheduleScan();
    updateButtonStyles();
  }
  if (changes.socialStyle) {
    state.activeSocialStyle = changes.socialStyle.newValue || "genz";
    updateButtonStyles();
  }
});

// Update all button style indicators
const updateButtonStyles = () => {
  const styleMap = { genz: "G", casual: "C", professional: "P" };
  state.buttons.forEach((button) => {
    if (state.activeMode === "social") {
      button.dataset.style = state.activeSocialStyle;
      const indicator = button.querySelector(".tfa-style-indicator");
      if (indicator) {
        indicator.textContent = styleMap[state.activeSocialStyle] || "G";
      }
    } else {
      delete button.dataset.style;
    }
  });
};

// Initialize everything when DOM is ready
const initializeExtension = () => {
  // Set up URL change detection (no DOM dependency)
  setupUrlChangeDetection();

  // Initialize buttons (requires document.body)
  initializeButtons();

  // Proactively cache job descriptions on known platforms
  proactivelyCacheJobDescription();
};

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeExtension);
} else {
  initializeExtension();
}
