// ── Elements ──────────────────────────────────────────────────────────────────
const providerTabs   = document.querySelectorAll('.provider-tab');
const providerPanels = document.querySelectorAll('.provider-panel');
const eyeButtons     = document.querySelectorAll('.eye-btn');
const activeBadge    = document.getElementById('activeBadge');

const openaiKeyInput      = document.getElementById('openaiKey');
const anthropicKeyInput   = document.getElementById('anthropicKey');
const geminiKeyInput      = document.getElementById('geminiKey');
const openaiModelSelect   = document.getElementById('openaiModel');
const anthropicModelSelect= document.getElementById('anthropicModel');
const geminiModelSelect   = document.getElementById('geminiModel');

// Memory model selects (per provider)
const openaiMemoryModelSelect    = document.getElementById('openaiMemoryModel');
const anthropicMemoryModelSelect = document.getElementById('anthropicMemoryModel');
const geminiMemoryModelSelect    = document.getElementById('geminiMemoryModel');
const openaiEmbeddingModelSelect = document.getElementById('openaiEmbeddingModel');
const geminiEmbeddingModelSelect = document.getElementById('geminiEmbeddingModel');

// Context inputs — Career & Work
const workFileInput   = document.getElementById('workFile');
const workTextInput   = document.getElementById('workText');
const workUploadArea  = document.getElementById('workUploadArea');
const workUploadLabel = document.getElementById('workUploadLabel');
const workFileInfo    = document.getElementById('workFileInfo');
const workFileName    = document.getElementById('workFileName');
const clearWorkBtn    = document.getElementById('clearWorkFile');

// Context inputs — Social & Personal
const socialFileInput   = document.getElementById('socialFile');
const socialTextInput   = document.getElementById('socialText');
const socialUploadArea  = document.getElementById('socialUploadArea');
const socialUploadLabel = document.getElementById('socialUploadLabel');
const socialFileInfo    = document.getElementById('socialFileInfo');
const socialFileName    = document.getElementById('socialFileName');
const clearSocialBtn    = document.getElementById('clearSocialFile');

// Context inputs — Always Active
const alwaysTextInput = document.getElementById('alwaysText');

const systemPromptInput = document.getElementById('systemPrompt');
const saveButton        = document.getElementById('save');
const statusEl          = document.getElementById('status');

const MAX_CHARS = 8000;
const PROVIDER_LABELS = {
  openai: 'OpenAI',
  anthropic: 'Anthropic',
  gemini: 'Gemini',
};
const MAIN_MODEL_SELECT_BY_PROVIDER = {
  openai: openaiModelSelect,
  anthropic: anthropicModelSelect,
  gemini: geminiModelSelect,
};
const GEMINI_EMBEDDING_MODELS = new Set(['gemini-embedding-001']);
let activeProvider = 'openai';

const setActiveProvider = (provider) => {
  const nextProvider = PROVIDER_LABELS[provider] ? provider : 'openai';
  activeProvider = nextProvider;
  providerTabs.forEach((t) => {
    t.classList.toggle('active', t.dataset.provider === nextProvider);
  });
  providerPanels.forEach((panel) => {
    panel.classList.toggle('active', panel.dataset.panel === nextProvider);
  });
  activeBadge.textContent = PROVIDER_LABELS[nextProvider] || nextProvider;
};

const getActiveModel = () =>
  MAIN_MODEL_SELECT_BY_PROVIDER[activeProvider]?.value || openaiModelSelect.value;

const setSelectValue = (selectEl, value, fallbackValue) => {
  if (!selectEl) return fallbackValue;
  const options = Array.from(selectEl.options || []).map((o) => o.value);
  const nextValue = options.includes(value) ? value : fallbackValue;
  selectEl.value = nextValue;
  return nextValue;
};

// ── Provider tabs ─────────────────────────────────────────────────────────────
providerTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    setActiveProvider(tab.dataset.provider);
  });
});

// ── Eye buttons ───────────────────────────────────────────────────────────────
eyeButtons.forEach((btn) => {
  btn.addEventListener('click', () => {
    const input    = document.getElementById(btn.dataset.target);
    const eyeOpen  = btn.querySelector('.eye-open');
    const eyeClosed= btn.querySelector('.eye-closed');
    if (input.type === 'password') {
      input.type = 'text';
      eyeOpen.style.display  = 'none';
      eyeClosed.style.display = 'block';
    } else {
      input.type = 'password';
      eyeOpen.style.display  = 'block';
      eyeClosed.style.display = 'none';
    }
  });
});

// ── Context accordion ─────────────────────────────────────────────────────────
document.querySelectorAll('.ctx-accordion').forEach((acc) => {
  const headerBtn = acc.querySelector('.ctx-header');
  headerBtn.addEventListener('click', () => {
    const isOpen = acc.classList.toggle('open');
    headerBtn.setAttribute('aria-expanded', String(isOpen));
  });
});

// ── Status message ────────────────────────────────────────────────────────────
const showStatus = (msg, isError = false) => {
  statusEl.textContent = msg;
  statusEl.className   = isError ? 'error' : 'success';
  setTimeout(() => { statusEl.textContent = ''; statusEl.className = ''; }, 3000);
};

const sanitize = (text, max) => text.replace(/\s+/g, ' ').trim().slice(0, max);

// ── File info helpers ─────────────────────────────────────────────────────────
const showFileInfo = (infoEl, uploadEl, nameEl, name) => {
  nameEl.textContent    = name;
  infoEl.style.display  = 'flex';
  uploadEl.style.display = 'none';
};
const hideFileInfo = (infoEl, uploadEl, fileInput) => {
  infoEl.style.display  = 'none';
  uploadEl.style.display = 'flex';
  fileInput.value = '';
};

clearWorkBtn.addEventListener('click', () => {
  hideFileInfo(workFileInfo, workUploadArea, workFileInput);
  workTextInput.value = '';
  chrome.storage.local.remove('workFileName');
  showStatus('Work context cleared.');
});

clearSocialBtn.addEventListener('click', () => {
  hideFileInfo(socialFileInfo, socialUploadArea, socialFileInput);
  socialTextInput.value = '';
  chrome.storage.local.remove('socialFileName');
  showStatus('Social context cleared.');
});

// ── File upload handler ───────────────────────────────────────────────────────
const handleFileUpload = async ({ file, labelEl, textInput, infoEl, uploadEl, fileInput, fileNameEl, storageKey, label }) => {
  const isPDF = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  labelEl.textContent = 'Processing…';

  try {
    let text = '';
    if (isPDF) {
      if (!window.PDFExtractor) {
        showStatus('PDF parser not loaded. Refresh the page.', true);
        labelEl.textContent = 'Drop PDF or text file, or click to browse';
        return;
      }
      text = await window.PDFExtractor.extractText(file);
      if (!text || text.length < 50) {
        showStatus('Could not extract text from PDF. Try a text file.', true);
        labelEl.textContent = 'Drop PDF or text file, or click to browse';
        return;
      }
    } else {
      text = await file.text();
    }

    const sanitized = sanitize(text, MAX_CHARS);
    textInput.value = sanitized;
    showFileInfo(infoEl, uploadEl, fileNameEl, file.name);
    chrome.storage.local.set({ [storageKey]: file.name });
    showStatus(`${label}: ${sanitized.length.toLocaleString()} chars loaded.`);
  } catch (err) {
    showStatus('Failed to process file: ' + err.message, true);
    labelEl.textContent = 'Drop PDF or text file, or click to browse';
  }
};

const UPLOAD_CONFIG = {
  work: {
    file: workFileInput,
    labelEl: workUploadLabel,
    textInput: workTextInput,
    infoEl: workFileInfo,
    uploadEl: workUploadArea,
    fileNameEl: workFileName,
    storageKey: 'workFileName',
    label: 'Career context',
  },
  social: {
    file: socialFileInput,
    labelEl: socialUploadLabel,
    textInput: socialTextInput,
    infoEl: socialFileInfo,
    uploadEl: socialUploadArea,
    fileNameEl: socialFileName,
    storageKey: 'socialFileName',
    label: 'Social context',
  },
};

const getUploadConfig = (ctx) => UPLOAD_CONFIG[ctx];

// File input change
workFileInput.addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (f) await handleFileUpload({ file: f, fileInput: workFileInput, ...getUploadConfig('work') });
});
socialFileInput.addEventListener('change', async (e) => {
  const f = e.target.files?.[0];
  if (f) await handleFileUpload({ file: f, fileInput: socialFileInput, ...getUploadConfig('social') });
});

// Drag and drop
const setupDrag = (area, cfg) => {
  area.addEventListener('dragover', (e) => { e.preventDefault(); area.classList.add('drag-over'); });
  area.addEventListener('dragleave', () => area.classList.remove('drag-over'));
  area.addEventListener('drop', async (e) => {
    e.preventDefault();
    area.classList.remove('drag-over');
    const f = e.dataTransfer.files[0];
    if (f) await handleFileUpload({ file: f, fileInput: cfg.file, ...cfg });
  });
};

setupDrag(workUploadArea, getUploadConfig('work'));
setupDrag(socialUploadArea, getUploadConfig('social'));

// ── Load settings ─────────────────────────────────────────────────────────────
const loadSettings = async () => {
  const data = await chrome.storage.local.get([
    'provider', 'model',
    'openaiKey', 'anthropicKey', 'geminiKey',
    // Memory models (per provider)
    'openaiMemoryModel', 'anthropicMemoryModel', 'geminiMemoryModel',
    // Embedding models (providers that support embeddings)
    'openaiEmbeddingModel', 'geminiEmbeddingModel',
    'workContextText', 'workFileName',
    'socialContextText', 'socialFileName',
    'alwaysContextText',
    'systemPrompt',
  ]);

  activeProvider = data.provider || 'openai';
  setActiveProvider(activeProvider);

  openaiKeyInput.value       = data.openaiKey    || '';
  anthropicKeyInput.value    = data.anthropicKey || '';
  geminiKeyInput.value       = data.geminiKey    || '';
  systemPromptInput.value    = data.systemPrompt || '';
  alwaysTextInput.value      = data.alwaysContextText || '';

  workTextInput.value = data.workContextText || '';
  const wfn = data.workFileName || '';
  if (wfn) showFileInfo(workFileInfo, workUploadArea, workFileName, wfn);

  // Populate social context
  socialTextInput.value = data.socialContextText || '';
  if (data.socialFileName) showFileInfo(socialFileInfo, socialUploadArea, socialFileName, data.socialFileName);

  // Main model selection
  if (data.model) {
    const modelSelect = MAIN_MODEL_SELECT_BY_PROVIDER[data.provider];
    if (modelSelect) modelSelect.value = data.model;
  }

  // Memory model selection (defaults: gpt-5-nano, claude-haiku-3-5, gemini-2.5-flash-lite)
  setSelectValue(openaiMemoryModelSelect, data.openaiMemoryModel, 'gpt-5-nano');
  setSelectValue(anthropicMemoryModelSelect, data.anthropicMemoryModel, 'claude-haiku-3-5');
  setSelectValue(geminiMemoryModelSelect, data.geminiMemoryModel, 'gemini-2.5-flash-lite');
  setSelectValue(openaiEmbeddingModelSelect, data.openaiEmbeddingModel, 'text-embedding-3-small');

  const resolvedGeminiEmbeddingModel = setSelectValue(
    geminiEmbeddingModelSelect,
    data.geminiEmbeddingModel,
    'gemini-embedding-001'
  );
  if (
    data.geminiEmbeddingModel &&
    !GEMINI_EMBEDDING_MODELS.has(data.geminiEmbeddingModel) &&
    data.geminiEmbeddingModel !== resolvedGeminiEmbeddingModel
  ) {
    await chrome.storage.local.set({ geminiEmbeddingModel: resolvedGeminiEmbeddingModel });
  }
};

// ── Save settings ─────────────────────────────────────────────────────────────
saveButton.addEventListener('click', async () => {
  const openaiKey    = openaiKeyInput.value.trim();
  const anthropicKey = anthropicKeyInput.value.trim();
  const geminiKey    = geminiKeyInput.value.trim();

  const activeKey = activeProvider === 'anthropic' ? anthropicKey
                  : activeProvider === 'gemini'    ? geminiKey
                  : openaiKey;

  if (!activeKey) { showStatus('API key is required.', true); return; }

  const model = getActiveModel();

  const workContextText   = sanitize(workTextInput.value,   MAX_CHARS);
  const socialContextText = sanitize(socialTextInput.value, MAX_CHARS);
  const alwaysContextText = sanitize(alwaysTextInput.value, MAX_CHARS);
  const systemPrompt      = sanitize(systemPromptInput.value, MAX_CHARS);
  const geminiEmbeddingModel = GEMINI_EMBEDDING_MODELS.has(geminiEmbeddingModelSelect.value)
    ? geminiEmbeddingModelSelect.value
    : 'gemini-embedding-001';

  await chrome.storage.local.set({
    provider: activeProvider,
    model,
    openaiKey,
    anthropicKey,
    geminiKey,
    openaiMemoryModel:    openaiMemoryModelSelect.value,
    anthropicMemoryModel: anthropicMemoryModelSelect.value,
    geminiMemoryModel:    geminiMemoryModelSelect.value,
    openaiEmbeddingModel: openaiEmbeddingModelSelect.value,
    geminiEmbeddingModel,
    workContextText,
    socialContextText,
    alwaysContextText,
    systemPrompt,
  });

  showStatus('Settings saved.');
});

loadSettings();
