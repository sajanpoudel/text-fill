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
  buttons: new Map(), // Map of field -> button for each text field
  cachedJobDescription: null,
  currentJobUrl: null, // Track current job URL to detect navigation
  isGenerating: false,
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

// Create or get the AI fill button for a specific field
const getOrCreateButton = (field) => {
  if (state.buttons.has(field)) {
    return state.buttons.get(field);
  }

  const button = document.createElement("button");
  button.className = "tfa-icon-button";
  button.type = "button";
  button.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/></svg>`;
  button.title = "Fill with AI";
  
  button.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    await generateAndFill(field, button);
  });

  state.buttons.set(field, button);
  return button;
};

// Position the button inside/near the field
const positionButton = (field, button) => {
  const rect = field.getBoundingClientRect();
  const isTextarea = field.tagName === 'TEXTAREA';
  
  // Position at top-right corner of the field
  button.style.position = 'fixed';
  button.style.top = `${rect.top + 8}px`;
  button.style.left = `${rect.right - 36}px`;
  button.style.zIndex = '2147483647';
  
  if (!button.parentElement) {
    document.body.appendChild(button);
  }
};

// Main function: Generate answer and fill directly
const generateAndFill = async (field, button) => {
  if (state.isGenerating) return;
  state.isGenerating = true;
  
  // Show loading state
  const originalHTML = button.innerHTML;
  button.innerHTML = `<svg class="tfa-spin" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><path d="M12 2a10 10 0 0 1 10 10"/></svg>`;
  button.disabled = true;
  button.title = "Generating...";

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
      fieldValue: field.value,
      jobDescription,
      pageContext,
    });

    if (!response?.ok) {
      showToast(response?.error || "Failed to generate. Check settings.", true);
      return;
    }

    // Fill the field directly
    field.value = response.answer;
    field.dispatchEvent(new Event("input", { bubbles: true }));
    field.dispatchEvent(new Event("change", { bubbles: true }));
    
    // Brief success indication
    button.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#10b981" stroke-width="2"><path d="M20 6L9 17l-5-5"/></svg>`;
    setTimeout(() => {
      button.innerHTML = originalHTML;
    }, 1500);

  } catch (err) {
    showToast(err.message || "Something went wrong", true);
    button.innerHTML = originalHTML;
  } finally {
    state.isGenerating = false;
    button.disabled = false;
    button.title = "Fill with AI";
  }
};

// Show a simple toast notification
const showToast = (message, isError = false) => {
  const existing = document.querySelector('.tfa-toast');
  if (existing) existing.remove();
  
  const toast = document.createElement('div');
  toast.className = `tfa-toast ${isError ? 'tfa-toast-error' : ''}`;
  toast.textContent = message;
  document.body.appendChild(toast);
  
  setTimeout(() => toast.remove(), 4000);
};

// Scan for text fields and add buttons
const scanAndAddButtons = () => {
  const fields = document.querySelectorAll('textarea, input[type="text"]');
  
  fields.forEach(field => {
    // Skip if already has a button or is too small
    if (state.buttons.has(field)) {
      positionButton(field, state.buttons.get(field));
      return;
    }
    
    const rect = field.getBoundingClientRect();
    // Only add to visible fields with reasonable size
    if (rect.width < 100 || rect.height < 20 || rect.top < 0 || rect.bottom > window.innerHeight + 500) {
      return;
    }
    
    // Skip fields that look like search boxes or short inputs
    const isTextarea = field.tagName === 'TEXTAREA';
    const placeholder = (field.placeholder || '').toLowerCase();
    const isSearchField = placeholder.includes('search') || placeholder.includes('filter');
    
    if (!isTextarea && !isSearchField) {
      // For input fields, only add if they seem like answer fields
      const label = getQuestionText(field).toLowerCase();
      const isLikelyAnswerField = label.length > 20 || 
        label.includes('why') || 
        label.includes('what') || 
        label.includes('describe') ||
        label.includes('tell us') ||
        label.includes('explain');
      if (!isLikelyAnswerField) return;
    }
    
    if (isSearchField) return;
    
    const button = getOrCreateButton(field);
    positionButton(field, button);
  });
};

// Update button positions on scroll/resize
const updateButtonPositions = () => {
  state.buttons.forEach((button, field) => {
    const rect = field.getBoundingClientRect();
    // Hide if field is not visible
    if (rect.bottom < 0 || rect.top > window.innerHeight) {
      button.style.display = 'none';
    } else {
      button.style.display = '';
      positionButton(field, button);
    }
  });
};

// Initial scan and setup observers
const initializeButtons = () => {
  scanAndAddButtons();
  
  // Re-scan periodically for dynamically loaded content
  const observer = new MutationObserver(() => {
    setTimeout(scanAndAddButtons, 100);
  });
  
  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
  
  // Update positions on scroll/resize
  window.addEventListener('scroll', updateButtonPositions, { passive: true });
  window.addEventListener('resize', updateButtonPositions, { passive: true });
};

// Start when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initializeButtons);
} else {
  initializeButtons();
}
