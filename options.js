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
let activeProvider = 'openai';

// ── Provider tabs ─────────────────────────────────────────────────────────────
providerTabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    const p = tab.dataset.provider;
    providerTabs.forEach((t) => t.classList.remove('active'));
    tab.classList.add('active');
    providerPanels.forEach((panel) => panel.classList.remove('active'));
    document.querySelector(`.provider-panel[data-panel="${p}"]`).classList.add('active');
    activeProvider = p;
    activeBadge.textContent = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini' }[p] || p;
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

const makeUploadConfig = (ctx) => ({
  work:   { file: workFileInput,   labelEl: workUploadLabel,   textInput: workTextInput,   infoEl: workFileInfo,   uploadEl: workUploadArea,   fileNameEl: workFileName,   storageKey: 'workFileName',   label: 'Career context' },
  social: { file: socialFileInput, labelEl: socialUploadLabel, textInput: socialTextInput, infoEl: socialFileInfo, uploadEl: socialUploadArea, fileNameEl: socialFileName, storageKey: 'socialFileName', label: 'Social context' },
})[ctx];

// File input change
workFileInput.addEventListener('change', async (e) => {
  const f = e.target.files?.[0]; if (f) await handleFileUpload({ file: f, fileInput: workFileInput, ...makeUploadConfig('work') });
});
socialFileInput.addEventListener('change', async (e) => {
  const f = e.target.files?.[0]; if (f) await handleFileUpload({ file: f, fileInput: socialFileInput, ...makeUploadConfig('social') });
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

setupDrag(workUploadArea,   makeUploadConfig('work'));
setupDrag(socialUploadArea, makeUploadConfig('social'));

// ── Load settings ─────────────────────────────────────────────────────────────
const loadSettings = async () => {
  const data = await chrome.storage.local.get([
    'provider', 'model',
    'openaiKey', 'anthropicKey', 'geminiKey',
    // New context keys
    'workContextText', 'workFileName',
    'socialContextText', 'socialFileName',
    'alwaysContextText',
    // Legacy — migrate to work context
    'generalContextText', 'generalFileName',
    'systemPrompt',
  ]);

  activeProvider = data.provider || 'openai';

  providerTabs.forEach((t) => t.classList.remove('active'));
  providerPanels.forEach((p) => p.classList.remove('active'));
  document.querySelector(`[data-provider="${activeProvider}"]`)?.classList.add('active');
  document.querySelector(`.provider-panel[data-panel="${activeProvider}"]`)?.classList.add('active');
  activeBadge.textContent = { openai: 'OpenAI', anthropic: 'Anthropic', gemini: 'Gemini' }[activeProvider] || activeProvider;

  openaiKeyInput.value       = data.openaiKey    || '';
  anthropicKeyInput.value    = data.anthropicKey || '';
  geminiKeyInput.value       = data.geminiKey    || '';
  systemPromptInput.value    = data.systemPrompt || '';
  alwaysTextInput.value      = data.alwaysContextText || '';

  // Populate work context — fall back to legacy generalContextText
  workTextInput.value = data.workContextText || data.generalContextText || '';
  const wfn = data.workFileName || data.generalFileName || '';
  if (wfn) showFileInfo(workFileInfo, workUploadArea, workFileName, wfn);

  // Populate social context
  socialTextInput.value = data.socialContextText || '';
  if (data.socialFileName) showFileInfo(socialFileInfo, socialUploadArea, socialFileName, data.socialFileName);

  // Model selection
  if (data.model) {
    if (data.provider === 'openai')    openaiModelSelect.value    = data.model;
    if (data.provider === 'anthropic') anthropicModelSelect.value = data.model;
    if (data.provider === 'gemini')    geminiModelSelect.value    = data.model;
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

  let model;
  if (activeProvider === 'openai')    model = openaiModelSelect.value;
  if (activeProvider === 'anthropic') model = anthropicModelSelect.value;
  if (activeProvider === 'gemini')    model = geminiModelSelect.value;

  const workContextText   = sanitize(workTextInput.value,   MAX_CHARS);
  const socialContextText = sanitize(socialTextInput.value, MAX_CHARS);
  const alwaysContextText = sanitize(alwaysTextInput.value, MAX_CHARS);
  const systemPrompt      = sanitize(systemPromptInput.value, MAX_CHARS);

  await chrome.storage.local.set({
    provider: activeProvider,
    model,
    openaiKey,
    anthropicKey,
    geminiKey,
    workContextText,
    socialContextText,
    alwaysContextText,
    systemPrompt,
    // Keep generalContextText in sync for backward-compat (background.js reads it as fallback)
    generalContextText: workContextText,
    mode: 'general',
  });

  showStatus('Settings saved.');
});

loadSettings();
