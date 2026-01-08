const providerSelect = document.getElementById("provider");
const modelSelect = document.getElementById("model");
const modeSelect = document.getElementById("mode");
const openaiKeyInput = document.getElementById("openaiKey");
const anthropicKeyInput = document.getElementById("anthropicKey");
const geminiKeyInput = document.getElementById("geminiKey");
const resumeFileInput = document.getElementById("resumeFile");
const resumeTextInput = document.getElementById("resumeText");
const systemPromptInput = document.getElementById("systemPrompt");
const generalFileInput = document.getElementById("generalFile");
const generalContextInput = document.getElementById("generalContextText");
const saveButton = document.getElementById("save");
const status = document.getElementById("status");
const jobSettings = document.getElementById("jobSettings");
const generalSettings = document.getElementById("generalSettings");
const MAX_RESUME_CHARS = 6000;
const MAX_GENERAL_CHARS = 6000;

const providerModels = {
  openai: [
    { value: "gpt-5-nano", label: "gpt-5-nano" },
    { value: "gpt-4.1-mini", label: "gpt-4.1-mini" },
  ],
  anthropic: [
    { value: "claude-3-5-sonnet-20241022", label: "claude-3.5-sonnet" },
    { value: "claude-3-5-haiku-20241022", label: "claude-3.5-haiku" },
  ],
  gemini: [
    { value: "gemini-1.5-pro", label: "gemini-1.5-pro" },
    { value: "gemini-1.5-flash", label: "gemini-1.5-flash" },
  ],
};

const showStatus = (message, isError = false) => {
  status.textContent = message;
  status.className = isError ? "error" : "success";
  setTimeout(() => {
    status.textContent = "";
    status.className = "";
  }, 3000);
};

const sanitizeText = (text, maxChars) =>
  text.replace(/\s+/g, " ").trim().slice(0, maxChars);

const renderModels = (provider, selected) => {
  modelSelect.innerHTML = "";
  const models = providerModels[provider] || [];
  models.forEach((model) => {
    const option = document.createElement("option");
    option.value = model.value;
    option.textContent = model.label;
    if (model.value === selected) {
      option.selected = true;
    }
    modelSelect.appendChild(option);
  });
};

const updateModeVisibility = (mode) => {
  if (mode === "general") {
    jobSettings.classList.add("hidden");
    generalSettings.classList.remove("hidden");
  } else {
    jobSettings.classList.remove("hidden");
    generalSettings.classList.add("hidden");
  }
};

const loadSettings = async () => {
  const {
    provider,
    model,
    mode,
    openaiKey,
    anthropicKey,
    geminiKey,
    resumeText,
    systemPrompt,
    generalContextText,
  } = await chrome.storage.local.get([
    "provider",
    "model",
    "mode",
    "openaiKey",
    "anthropicKey",
    "geminiKey",
    "resumeText",
    "systemPrompt",
    "generalContextText",
  ]);

  const activeProvider = provider || "openai";
  const activeModel =
    model ||
    (activeProvider === "anthropic"
      ? "claude-3-5-sonnet-20241022"
      : activeProvider === "gemini"
        ? "gemini-1.5-pro"
        : "gpt-5-nano");

  providerSelect.value = activeProvider;
  renderModels(activeProvider, activeModel);
  modeSelect.value = mode || "job";
  updateModeVisibility(modeSelect.value);
  openaiKeyInput.value = openaiKey || "";
  anthropicKeyInput.value = anthropicKey || "";
  geminiKeyInput.value = geminiKey || "";
  resumeTextInput.value = resumeText || "";
  systemPromptInput.value = systemPrompt || "";
  generalContextInput.value = generalContextText || "";
};

resumeFileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  if (file.type === "application/pdf") {
    showStatus("PDF parsing is not supported yet. Upload a .txt file.", true);
    resumeFileInput.value = "";
    return;
  }

  const text = await file.text();
  resumeTextInput.value = sanitizeText(text, MAX_RESUME_CHARS);
});

generalFileInput.addEventListener("change", async (event) => {
  const file = event.target.files?.[0];
  if (!file) {
    return;
  }

  if (file.type === "application/pdf") {
    showStatus("PDF parsing is not supported yet. Upload a .txt file.", true);
    generalFileInput.value = "";
    return;
  }

  const text = await file.text();
  generalContextInput.value = sanitizeText(text, MAX_GENERAL_CHARS);
});

providerSelect.addEventListener("change", () => {
  renderModels(providerSelect.value, null);
});

modeSelect.addEventListener("change", () => {
  updateModeVisibility(modeSelect.value);
});

saveButton.addEventListener("click", async () => {
  const provider = providerSelect.value;
  const model = modelSelect.value;
  const mode = modeSelect.value;
  const openaiKey = openaiKeyInput.value.trim();
  const anthropicKey = anthropicKeyInput.value.trim();
  const geminiKey = geminiKeyInput.value.trim();
  const resumeText = sanitizeText(resumeTextInput.value, MAX_RESUME_CHARS);
  const systemPrompt = systemPromptInput.value.trim();
  const generalContextText = sanitizeText(
    generalContextInput.value,
    MAX_GENERAL_CHARS
  );

  const activeKey =
    provider === "anthropic"
      ? anthropicKey
      : provider === "gemini"
        ? geminiKey
        : openaiKey;

  if (!activeKey) {
    showStatus("API key is required.", true);
    return;
  }

  if (mode === "general" && !systemPrompt) {
    showStatus("System prompt is required for general mode.", true);
    return;
  }

  await chrome.storage.local.set({
    provider,
    model,
    mode,
    openaiKey,
    anthropicKey,
    geminiKey,
    resumeText,
    systemPrompt,
    generalContextText,
  });
  showStatus("Saved.");
});

loadSettings();
