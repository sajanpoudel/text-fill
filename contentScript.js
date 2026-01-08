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

const state = {
  activeField: null,
  modal: null,
  button: null,
  cachedJobDescription: null,
  currentJobUrl: null, // Track current job URL to detect navigation
};

const normalizeText = (text) => text.replace(/\s+/g, " ").trim();

const extractSectionText = (element) => {
  if (!element) {
    return "";
  }
  return normalizeText(element.innerText || "");
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

// Find the Overview tab button on platforms like Ashby
const findOverviewTabButton = () => {
  // Common selectors for Overview/Job Description tabs
  const selectors = [
    'button:has-text("Overview")',
    'a:has-text("Overview")', 
    '[role="tab"]:has-text("Overview")',
    '[data-tab="overview"]',
    '[aria-controls*="overview"]',
    'button[class*="tab"]',
    'a[class*="tab"]',
  ];
  
  // Try to find by text content
  const allButtons = document.querySelectorAll('button, a, [role="tab"]');
  for (const btn of allButtons) {
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

// Automatically fetch job description by switching tabs
const autoFetchJobDescription = () => {
  return new Promise((resolve) => {
    const overviewBtn = findOverviewTabButton();
    const applicationBtn = findApplicationTabButton();
    
    if (!overviewBtn) {
      resolve(null);
      return;
    }
    
    // Remember current scroll position
    const scrollPos = window.scrollY;
    
    // Click Overview tab
    overviewBtn.click();
    
    // Wait for content to load
    setTimeout(() => {
      // Extract job description from Overview
      const sections = findJobSections(false);
      let jobDescription = null;
      
      if (sections.length > 0) {
        jobDescription = sections.join("\n\n").slice(0, MAX_CONTEXT_CHARS);
      } else {
        // Try to get main content
        const main = document.querySelector('main, article, [role="tabpanel"]');
        if (main) {
          jobDescription = extractSectionText(main).slice(0, MAX_CONTEXT_CHARS);
        }
      }
      
      // Switch back to Application tab
      if (applicationBtn) {
        applicationBtn.click();
      }
      
      // Restore scroll position
      setTimeout(() => {
        window.scrollTo(0, scrollPos);
      }, 100);
      
      // Cache the job description
      if (jobDescription && jobDescription.length > 200) {
        const storageKey = getJobStorageKey();
        cacheJobDescription(storageKey, jobDescription);
      }
      
      resolve(jobDescription);
    }, 500); // Wait 500ms for tab content to load
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
  // Use full pathname - each job has unique URL like /jobs/swe-intern-123
  return `tfa_job_${window.location.hostname}${window.location.pathname}`;
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

  // Try to get from session storage (persists across Overview/Application tab switches)
  // Session storage clears when browser tab is closed
  const storageKey = getJobStorageKey();
  const cached = sessionStorage.getItem(storageKey);
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
    try {
      sessionStorage.setItem(key, text);
    } catch (e) {
      // Session storage might be full or disabled
    }
  }
};

// Auto-capture job description when viewing Overview tab
const captureOnTabSwitch = () => {
  const observer = new MutationObserver(() => {
    // Check for URL changes in SPAs
    checkUrlChanged();
    
    const visibleContent = findJobSections(false);
    if (visibleContent.length > 0) {
      const text = visibleContent.join("\n\n").slice(0, MAX_CONTEXT_CHARS);
      if (text.length > 300) {
        const storageKey = getJobStorageKey();
        cacheJobDescription(storageKey, text);
      }
    }
  });
  
  observer.observe(document.body, { 
    childList: true, 
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'hidden', 'aria-hidden', 'style']
  });
};

// Listen for URL changes (for SPAs that don't reload the page)
let lastUrl = window.location.href;
const urlObserver = new MutationObserver(() => {
  if (window.location.href !== lastUrl) {
    lastUrl = window.location.href;
    // Clear cache when navigating to different job
    state.cachedJobDescription = null;
    state.currentJobUrl = window.location.href;
  }
});
urlObserver.observe(document.body, { childList: true, subtree: true });

// Also listen for popstate (back/forward navigation)
window.addEventListener('popstate', () => {
  state.cachedJobDescription = null;
  state.currentJobUrl = window.location.href;
});

// Start observing for tab switches
captureOnTabSwitch();

const extractPageContext = (field) => {
  const title = document.title || "";
  const url = window.location.href || "";
  const metaDescription = document.querySelector("meta[name='description']")?.content || "";
  const fieldContainer = field?.closest("section, form, div");
  const fieldContext = extractSectionText(fieldContainer);
  const pageText = extractSectionText(document.body);

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
  const aria = field.getAttribute("aria-label") || field.getAttribute("aria-labelledby");
  if (aria) {
    const labelled = aria
      .split(" ")
      .map((id) => document.getElementById(id)?.innerText || "")
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

  if (field.placeholder) {
    return field.placeholder.trim();
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

const ensureButton = () => {
  if (state.button) {
    return state.button;
  }

  const button = document.createElement("button");
  button.className = "tfa-floating-button";
  button.type = "button";
  button.textContent = "Fill with AI";
  // Use mousedown to capture click before blur hides the button
  button.addEventListener("mousedown", (e) => {
    e.preventDefault();
    e.stopPropagation();
    openModal();
  });
  document.body.appendChild(button);
  state.button = button;
  return button;
};

const positionButton = (field) => {
  const rect = field.getBoundingClientRect();
  const button = ensureButton();
  button.style.top = `${window.scrollY + rect.top - 12}px`;
  button.style.left = `${window.scrollX + rect.right - 120}px`;
  button.hidden = false;
};

const closeModal = () => {
  if (state.modal) {
    state.modal.remove();
    state.modal = null;
  }
};

// Open modal - async to allow auto-fetching job description
const openModal = async () => {
  closeModal();
  if (!state.activeField) {
    return;
  }

  // First, get the job description (might need to auto-fetch)
  let contextText = extractJobDescription();
  
  // If we got form content instead of job description, try auto-fetching
  if (isFormContent(contextText)) {
    // Check if there's an Overview tab we can click
    const overviewBtn = findOverviewTabButton();
    if (overviewBtn) {
      // Auto-fetch from Overview tab
      const fetched = await autoFetchJobDescription();
      if (fetched && !isFormContent(fetched)) {
        contextText = fetched;
      }
    }
  }

  const modal = document.createElement("div");
  modal.className = "tfa-modal";
  modal.innerHTML = `
    <div class="tfa-card">
      <div class="tfa-header">
        <div>
          <h3>Draft answer</h3>
          <p>Uses your resume and this page's job description.</p>
        </div>
        <button class="tfa-close" type="button">Close</button>
      </div>
      <div class="tfa-body">
        <label class="tfa-label">Question</label>
        <div class="tfa-question"></div>
        <label class="tfa-label">Job context</label>
        <div class="tfa-context"></div>
        <label class="tfa-label">Answer</label>
        <textarea class="tfa-output" placeholder="Generate a response..."></textarea>
        <div class="tfa-error" hidden></div>
      </div>
      <div class="tfa-actions">
        <button class="tfa-secondary" type="button">Generate</button>
        <button class="tfa-primary" type="button">Insert</button>
      </div>
    </div>
  `;

  modal.querySelector(".tfa-close").addEventListener("click", closeModal);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) {
      closeModal();
    }
  });

  const question = getQuestionText(state.activeField) || "Job application response";
  modal.querySelector(".tfa-question").textContent = question;
  
  const contextDiv = modal.querySelector(".tfa-context");
  
  // Show the job context (or error if still form content)
  if (isFormContent(contextText)) {
    contextDiv.innerHTML = '<span style="color: #b42318;">⚠️ Could not auto-detect job description. Please visit the Overview tab first, then try again.</span>';
  } else {
    contextDiv.textContent = contextText || "No job description detected.";
  }
  
  const pageContext = extractPageContext(state.activeField);

  const output = modal.querySelector(".tfa-output");
  const error = modal.querySelector(".tfa-error");
  const generateButton = modal.querySelector(".tfa-secondary");
  const insertButton = modal.querySelector(".tfa-primary");

  generateButton.addEventListener("click", async () => {
    error.hidden = true;
    output.value = "";
    
    // Check if we have valid job description
    if (isFormContent(contextText)) {
      error.hidden = false;
      error.textContent = "Please visit the Overview tab first to capture the job description, then try again.";
      return;
    }
    
    if (!contextText || contextText.length < 50) {
      error.hidden = false;
      error.textContent = "No job description found. Please visit the job description page first.";
      return;
    }
    
    generateButton.disabled = true;
    generateButton.textContent = "Working...";

    const response = await chrome.runtime.sendMessage({
      type: "generateAnswer",
      question,
      fieldValue: state.activeField.value,
      jobDescription: contextText,
      pageContext,
    });

    generateButton.disabled = false;
    generateButton.textContent = "Generate";

    if (!response?.ok) {
      error.hidden = false;
      error.textContent = response?.error || "Something went wrong.";
      return;
    }

    output.value = response.answer;
  });

  insertButton.addEventListener("click", () => {
    if (!output.value.trim()) {
      return;
    }
    state.activeField.value = output.value.trim();
    state.activeField.dispatchEvent(new Event("input", { bubbles: true }));
    closeModal();
  });

  document.body.appendChild(modal);
  state.modal = modal;
};

const handleFocus = (event) => {
  const target = event.target;
  if (!(target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement)) {
    return;
  }
  if (target instanceof HTMLInputElement && target.type !== "text") {
    return;
  }

  state.activeField = target;
  positionButton(target);
};

const handleBlur = () => {
  // Delay hiding to allow button click to register
  setTimeout(() => {
    if (state.button && !state.modal) {
      state.button.hidden = true;
    }
  }, 150);
};

window.addEventListener("focusin", handleFocus);
window.addEventListener("focusout", handleBlur);
window.addEventListener("scroll", () => {
  if (state.activeField) {
    positionButton(state.activeField);
  }
});
window.addEventListener("resize", () => {
  if (state.activeField) {
    positionButton(state.activeField);
  }
});
