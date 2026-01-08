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

const extractJobDescription = () => {
  // Return cached description if available
  if (state.cachedJobDescription) {
    return state.cachedJobDescription;
  }

  // Try to get from session storage (persists across tab switches)
  const storageKey = `tfa_job_${window.location.hostname}${window.location.pathname.split('/').slice(0, -1).join('/')}`;
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
    const visibleContent = findJobSections(false);
    if (visibleContent.length > 0) {
      const text = visibleContent.join("\n\n").slice(0, MAX_CONTEXT_CHARS);
      if (text.length > 300) {
        const storageKey = `tfa_job_${window.location.hostname}${window.location.pathname.split('/').slice(0, -1).join('/')}`;
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

const openModal = () => {
  closeModal();
  if (!state.activeField) {
    return;
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
  const contextText = extractJobDescription();
  modal.querySelector(".tfa-context").textContent =
    contextText || "No job description text detected.";
  const pageContext = extractPageContext(state.activeField);

  const output = modal.querySelector(".tfa-output");
  const error = modal.querySelector(".tfa-error");
  const generateButton = modal.querySelector(".tfa-secondary");
  const insertButton = modal.querySelector(".tfa-primary");

  generateButton.addEventListener("click", async () => {
    error.hidden = true;
    output.value = "";
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
