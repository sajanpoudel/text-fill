// Elements
const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.tab-panel');
const eyeButtons = document.querySelectorAll('.eye-btn');

const openaiKeyInput = document.getElementById('openaiKey');
const anthropicKeyInput = document.getElementById('anthropicKey');
const geminiKeyInput = document.getElementById('geminiKey');
const openaiModelSelect = document.getElementById('openaiModel');
const anthropicModelSelect = document.getElementById('anthropicModel');
const geminiModelSelect = document.getElementById('geminiModel');
const resumeFileInput = document.getElementById('resumeFile');
const resumeTextInput = document.getElementById('resumeText');
const saveButton = document.getElementById('save');
const status = document.getElementById('status');

const MAX_RESUME_CHARS = 6000;

let activeProvider = 'openai';

// Tab switching
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const provider = tab.dataset.provider;
    
    // Update active tab
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    
    // Update active panel
    panels.forEach(p => p.classList.remove('active'));
    document.querySelector(`[data-panel="${provider}"]`).classList.add('active');
    
    activeProvider = provider;
  });
});

// Eye button toggle
eyeButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const targetId = btn.dataset.target;
    const input = document.getElementById(targetId);
    const eyeOpen = btn.querySelector('.eye-open');
    const eyeClosed = btn.querySelector('.eye-closed');
    
    if (input.type === 'password') {
      input.type = 'text';
      eyeOpen.style.display = 'none';
      eyeClosed.style.display = 'block';
    } else {
      input.type = 'password';
      eyeOpen.style.display = 'block';
      eyeClosed.style.display = 'none';
    }
  });
});

// Show status message
const showStatus = (message, isError = false) => {
  status.textContent = message;
  status.className = isError ? 'error' : 'success';
  setTimeout(() => {
    status.textContent = '';
    status.className = '';
  }, 3000);
};

// Sanitize text
const sanitizeText = (text, maxChars) =>
  text.replace(/\s+/g, ' ').trim().slice(0, maxChars);

// Load settings
const loadSettings = async () => {
  const data = await chrome.storage.local.get([
    'provider',
    'model',
    'openaiKey',
    'anthropicKey',
    'geminiKey',
    'resumeText',
  ]);

  activeProvider = data.provider || 'openai';
  
  // Set active tab
  tabs.forEach(t => t.classList.remove('active'));
  panels.forEach(p => p.classList.remove('active'));
  document.querySelector(`[data-provider="${activeProvider}"]`).classList.add('active');
  document.querySelector(`[data-panel="${activeProvider}"]`).classList.add('active');

  // Set values
  openaiKeyInput.value = data.openaiKey || '';
  anthropicKeyInput.value = data.anthropicKey || '';
  geminiKeyInput.value = data.geminiKey || '';
  resumeTextInput.value = data.resumeText || '';

  // Set model selections
  if (data.model) {
    if (data.provider === 'openai') openaiModelSelect.value = data.model;
    else if (data.provider === 'anthropic') anthropicModelSelect.value = data.model;
    else if (data.provider === 'gemini') geminiModelSelect.value = data.model;
  }
};

// File upload handler
resumeFileInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (!file) return;

  if (file.type === 'application/pdf') {
    showStatus('PDF not supported. Please upload a .txt file.', true);
    resumeFileInput.value = '';
    return;
  }

  const text = await file.text();
  resumeTextInput.value = sanitizeText(text, MAX_RESUME_CHARS);
  showStatus('Resume loaded.');
});

// Save settings
saveButton.addEventListener('click', async () => {
  const openaiKey = openaiKeyInput.value.trim();
  const anthropicKey = anthropicKeyInput.value.trim();
  const geminiKey = geminiKeyInput.value.trim();
  const resumeText = sanitizeText(resumeTextInput.value, MAX_RESUME_CHARS);

  // Get the model for the active provider
  let model;
  if (activeProvider === 'openai') model = openaiModelSelect.value;
  else if (activeProvider === 'anthropic') model = anthropicModelSelect.value;
  else if (activeProvider === 'gemini') model = geminiModelSelect.value;

  // Get the active API key
  const activeKey =
    activeProvider === 'anthropic' ? anthropicKey :
    activeProvider === 'gemini' ? geminiKey : openaiKey;

  if (!activeKey) {
    showStatus('API key is required.', true);
    return;
  }

  await chrome.storage.local.set({
    provider: activeProvider,
    model,
    openaiKey,
    anthropicKey,
    geminiKey,
    resumeText,
  });

  showStatus('Settings saved.');
});

// Initialize
loadSettings();
