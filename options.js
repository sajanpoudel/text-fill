// Elements
const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.tab-panel');
const eyeButtons = document.querySelectorAll('.eye-btn');
const activeBadge = document.getElementById('activeBadge');

const openaiKeyInput = document.getElementById('openaiKey');
const anthropicKeyInput = document.getElementById('anthropicKey');
const geminiKeyInput = document.getElementById('geminiKey');
const openaiModelSelect = document.getElementById('openaiModel');
const anthropicModelSelect = document.getElementById('anthropicModel');
const geminiModelSelect = document.getElementById('geminiModel');
const resumeFileInput = document.getElementById('resumeFile');
const resumeTextInput = document.getElementById('resumeText');
const fileUploadArea = document.getElementById('fileUploadArea');
const uploadLabel = document.getElementById('uploadLabel');
const fileInfo = document.getElementById('fileInfo');
const fileName = document.getElementById('fileName');
const clearFileBtn = document.getElementById('clearFile');
const saveButton = document.getElementById('save');
const status = document.getElementById('status');

const MAX_RESUME_CHARS = 8000;

const providerNames = {
  openai: 'OpenAI',
  anthropic: 'Anthropic', 
  gemini: 'Gemini'
};

let activeProvider = 'openai';

// Update the active badge
const updateActiveBadge = (provider) => {
  activeBadge.textContent = `Active: ${providerNames[provider]}`;
};

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
    updateActiveBadge(provider);
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
    'resumeFileName',
  ]);

  activeProvider = data.provider || 'openai';
  
  // Set active tab
  tabs.forEach(t => t.classList.remove('active'));
  panels.forEach(p => p.classList.remove('active'));
  document.querySelector(`[data-provider="${activeProvider}"]`).classList.add('active');
  document.querySelector(`[data-panel="${activeProvider}"]`).classList.add('active');
  
  // Update badge
  updateActiveBadge(activeProvider);

  // Set values
  openaiKeyInput.value = data.openaiKey || '';
  anthropicKeyInput.value = data.anthropicKey || '';
  geminiKeyInput.value = data.geminiKey || '';
  resumeTextInput.value = data.resumeText || '';

  // Show file info if we have a saved file name
  if (data.resumeFileName) {
    showFileInfo(data.resumeFileName);
  }

  // Set model selections
  if (data.model) {
    if (data.provider === 'openai') openaiModelSelect.value = data.model;
    else if (data.provider === 'anthropic') anthropicModelSelect.value = data.model;
    else if (data.provider === 'gemini') geminiModelSelect.value = data.model;
  }
};

// Show file info
const showFileInfo = (name) => {
  fileInfo.style.display = 'flex';
  fileName.textContent = name;
  fileUploadArea.style.display = 'none';
};

// Hide file info
const hideFileInfo = () => {
  fileInfo.style.display = 'none';
  fileUploadArea.style.display = 'flex';
  resumeFileInput.value = '';
};

// Clear file button
clearFileBtn.addEventListener('click', () => {
  hideFileInfo();
  resumeTextInput.value = '';
  chrome.storage.local.remove('resumeFileName');
  showStatus('Resume cleared.');
});

// Drag and drop handling
fileUploadArea.addEventListener('dragover', (e) => {
  e.preventDefault();
  fileUploadArea.classList.add('drag-over');
});

fileUploadArea.addEventListener('dragleave', () => {
  fileUploadArea.classList.remove('drag-over');
});

fileUploadArea.addEventListener('drop', async (e) => {
  e.preventDefault();
  fileUploadArea.classList.remove('drag-over');
  
  const file = e.dataTransfer.files[0];
  if (file) {
    await handleFileUpload(file);
  }
});

// Handle file upload (both PDF and text)
const handleFileUpload = async (file) => {
  const isPDF = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  
  uploadLabel.textContent = 'Processing...';
  
  try {
    let text = '';
    
    if (isPDF) {
      // Use our PDF extractor
      if (window.PDFExtractor) {
        text = await window.PDFExtractor.extractText(file);
        
        if (!text || text.length < 50) {
          showStatus('Could not extract text from PDF. Try a text file instead.', true);
          uploadLabel.textContent = 'Drop PDF or text file here, or click to browse';
          return;
        }
      } else {
        showStatus('PDF parser not loaded. Please refresh the page.', true);
        uploadLabel.textContent = 'Drop PDF or text file here, or click to browse';
        return;
      }
    } else {
      // Plain text file
      text = await file.text();
    }
    
    // Sanitize and set
    const sanitized = sanitizeText(text, MAX_RESUME_CHARS);
    resumeTextInput.value = sanitized;
    
    // Show file info
    showFileInfo(file.name);
    
    // Save file name
    chrome.storage.local.set({ resumeFileName: file.name });
    
    showStatus(`Resume loaded: ${sanitized.length} characters extracted.`);
    
  } catch (error) {
    console.error('File processing error:', error);
    showStatus('Failed to process file: ' + error.message, true);
    uploadLabel.textContent = 'Drop PDF or text file here, or click to browse';
  }
};

// File input change handler
resumeFileInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (file) {
    await handleFileUpload(file);
  }
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
