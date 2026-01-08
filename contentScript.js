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
];

const state = {
  activeField: null,
  modal: null,
  button: null,
};

const normalizeText = (text) => text.replace(/\s+/g, " ").trim();

const extractSectionText = (element) => {
  if (!element) {
    return "";
  }
  return normalizeText(element.innerText || "");
};

const findJobSections = () => {
  const sections = [];
  const candidates = Array.from(
    document.querySelectorAll("h1, h2, h3, h4, strong, b")
  );

  candidates.forEach((heading) => {
    const headingText = normalizeText(heading.innerText || "").toLowerCase();
    if (!headingText) {
      return;
    }
    if (JOB_HINTS.some((hint) => headingText.includes(hint))) {
      const container =
        heading.closest("section, article, div") || heading.parentElement;
      const text = extractSectionText(container);
      if (text) {
        sections.push(text);
      }
    }
  });

  return sections;
};

const extractJobDescription = () => {
  const sections = findJobSections();
  if (sections.length > 0) {
    return sections.join("\n\n").slice(0, MAX_CONTEXT_CHARS);
  }

  const main = document.querySelector("main, article") || document.body;
  const text = extractSectionText(main);
  return text.slice(0, MAX_CONTEXT_CHARS);
};

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
  button.addEventListener("click", openModal);
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
  if (state.button) {
    state.button.hidden = true;
  }
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
