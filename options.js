// Elements
const providerTabs = document.querySelectorAll('.provider-tab');
const providerPanels = document.querySelectorAll('.provider-panel');
const modeTabs = document.querySelectorAll('.mode-tab');
const modePanels = document.querySelectorAll('.mode-panel');
const eyeButtons = document.querySelectorAll('.eye-btn');
const activeBadge = document.getElementById('activeBadge');
const modeBadge = document.getElementById('modeBadge');

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
const generalFileInput = document.getElementById('generalFile');
const generalTextInput = document.getElementById('generalText');
const generalUploadArea = document.getElementById('generalUploadArea');
const generalUploadLabel = document.getElementById('generalUploadLabel');
const generalFileInfo = document.getElementById('generalFileInfo');
const generalFileName = document.getElementById('generalFileName');
const clearGeneralFileBtn = document.getElementById('clearGeneralFile');
const socialFileInput = document.getElementById('socialFile');
const socialTextInput = document.getElementById('socialText');
const socialUploadArea = document.getElementById('socialUploadArea');
const socialUploadLabel = document.getElementById('socialUploadLabel');
const socialFileInfo = document.getElementById('socialFileInfo');
const socialFileName = document.getElementById('socialFileName');
const clearSocialFileBtn = document.getElementById('clearSocialFile');
const systemPromptInput = document.getElementById('systemPrompt');
const saveButton = document.getElementById('save');
const status = document.getElementById('status');
const socialStyleSelector = document.getElementById('socialStyleSelector');
const styleTabs = document.querySelectorAll('.style-tab');

const MAX_RESUME_CHARS = 8000;

const providerNames = {
  openai: 'OpenAI',
  anthropic: 'Anthropic', 
  gemini: 'Gemini'
};

let activeProvider = 'openai';
let activeMode = 'general';
let activeSocialStyle = 'genz';

// Update the active badge
const updateActiveBadge = (provider) => {
  activeBadge.textContent = `Active: ${providerNames[provider]}`;
};

const updateModeBadge = (mode) => {
  const modeNames = { job: 'Job', general: 'General', social: 'Social' };
  modeBadge.textContent = `Active: ${modeNames[mode] || 'General'}`;
};

const updateStyleSelector = (mode) => {
  if (socialStyleSelector) {
    socialStyleSelector.style.display = mode === 'social' ? 'block' : 'none';
  }
};

// Provider tab switching
providerTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const provider = tab.dataset.provider;
    
    // Update active tab
    providerTabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    
    // Update active panel
    providerPanels.forEach(p => p.classList.remove('active'));
    document.querySelector(`[data-panel="${provider}"]`).classList.add('active');
    
    activeProvider = provider;
    updateActiveBadge(provider);
  });
});

// Mode tab switching
modeTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const mode = tab.dataset.mode;

    modeTabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');

    modePanels.forEach(p => p.classList.remove('active'));
    const modePanel = document.querySelector(`.mode-panel[data-panel="${mode}"]`);
    if (modePanel) modePanel.classList.add('active');

    activeMode = mode;
    updateModeBadge(mode);
    updateStyleSelector(mode);
  });
});

// Style tab switching (for Social mode)
styleTabs.forEach(tab => {
  tab.addEventListener('click', () => {
    styleTabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    activeSocialStyle = tab.dataset.style;
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
    'mode',
    'socialStyle',
    'openaiKey',
    'anthropicKey',
    'geminiKey',
    'resumeText',
    'resumeFileName',
    'generalContextText',
    'generalFileName',
    'socialContextText',
    'socialFileName',
    'systemPrompt',
  ]);

  activeProvider = data.provider || 'openai';
  activeMode = data.mode || 'general';
  activeSocialStyle = data.socialStyle || 'genz';
  
  // Set active tab
  providerTabs.forEach(t => t.classList.remove('active'));
  providerPanels.forEach(p => p.classList.remove('active'));
  document.querySelector(`[data-provider="${activeProvider}"]`).classList.add('active');
  document.querySelector(`.provider-panel[data-panel="${activeProvider}"]`).classList.add('active');

  modeTabs.forEach(t => t.classList.remove('active'));
  modePanels.forEach(p => p.classList.remove('active'));
  document.querySelector(`[data-mode="${activeMode}"]`).classList.add('active');
  document.querySelector(`.mode-panel[data-panel="${activeMode}"]`).classList.add('active');
  
  // Update badges and style selector
  updateActiveBadge(activeProvider);
  updateModeBadge(activeMode);
  updateStyleSelector(activeMode);

  // Set active style tab
  styleTabs.forEach(t => t.classList.remove('active'));
  const activeStyleTab = document.querySelector(`[data-style="${activeSocialStyle}"]`);
  if (activeStyleTab) activeStyleTab.classList.add('active');

  // Set values
  openaiKeyInput.value = data.openaiKey || '';
  anthropicKeyInput.value = data.anthropicKey || '';
  geminiKeyInput.value = data.geminiKey || '';
  resumeTextInput.value = data.resumeText || '';
  generalTextInput.value = data.generalContextText || '';
  socialTextInput.value = data.socialContextText || '';
  systemPromptInput.value = data.systemPrompt || '';

  // Show file info if we have a saved file name
  if (data.resumeFileName) {
    showFileInfo(data.resumeFileName);
  }
  if (data.generalFileName) {
    showGeneralFileInfo(data.generalFileName);
  }
  if (data.socialFileName) {
    showSocialFileInfo(data.socialFileName);
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

const showGeneralFileInfo = (name) => {
  generalFileInfo.style.display = 'flex';
  generalFileName.textContent = name;
  generalUploadArea.style.display = 'none';
};

const hideGeneralFileInfo = () => {
  generalFileInfo.style.display = 'none';
  generalUploadArea.style.display = 'flex';
  generalFileInput.value = '';
};

const showSocialFileInfo = (name) => {
  socialFileInfo.style.display = 'flex';
  socialFileName.textContent = name;
  socialUploadArea.style.display = 'none';
};

const hideSocialFileInfo = () => {
  socialFileInfo.style.display = 'none';
  socialUploadArea.style.display = 'flex';
  socialFileInput.value = '';
};

// Clear file button
clearFileBtn.addEventListener('click', () => {
  hideFileInfo();
  resumeTextInput.value = '';
  chrome.storage.local.remove('resumeFileName');
  showStatus('Resume cleared.');
});

clearGeneralFileBtn.addEventListener('click', () => {
  hideGeneralFileInfo();
  generalTextInput.value = '';
  chrome.storage.local.remove('generalFileName');
  showStatus('General context cleared.');
});

clearSocialFileBtn.addEventListener('click', () => {
  hideSocialFileInfo();
  socialTextInput.value = '';
  chrome.storage.local.remove('socialFileName');
  showStatus('Social context cleared.');
});

// Drag and drop handling
const setupDragAndDrop = (area, onDrop) => {
  area.addEventListener('dragover', (e) => {
    e.preventDefault();
    area.classList.add('drag-over');
  });

  area.addEventListener('dragleave', () => {
    area.classList.remove('drag-over');
  });

  area.addEventListener('drop', async (e) => {
    e.preventDefault();
    area.classList.remove('drag-over');

    const file = e.dataTransfer.files[0];
    if (file) {
      await onDrop(file);
    }
  });
};

// Handle file upload (both PDF and text)
const handleFileUpload = async ({
  file,
  uploadLabelElement,
  textInput,
  showInfo,
  fileNameKey,
  maxChars,
  successLabel,
}) => {
  const isPDF = file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf');
  
  uploadLabelElement.textContent = 'Processing...';
  
  try {
    let text = '';
    
    if (isPDF) {
      // Use our PDF extractor
      if (window.PDFExtractor) {
        text = await window.PDFExtractor.extractText(file);
        
        if (!text || text.length < 50) {
          showStatus('Could not extract text from PDF. Try a text file instead.', true);
          uploadLabelElement.textContent = 'Drop PDF or text file here, or click to browse';
          return;
        }
      } else {
        showStatus('PDF parser not loaded. Please refresh the page.', true);
        uploadLabelElement.textContent = 'Drop PDF or text file here, or click to browse';
        return;
      }
    } else {
      // Plain text file
      text = await file.text();
    }
    
    // Sanitize and set
    const sanitized = sanitizeText(text, maxChars);
    textInput.value = sanitized;
    
    // Show file info
    showInfo(file.name);
    
    // Save file name
    chrome.storage.local.set({ [fileNameKey]: file.name });
    
    showStatus(`${successLabel} loaded: ${sanitized.length} characters extracted.`);
    
  } catch (error) {
    console.error('File processing error:', error);
    showStatus('Failed to process file: ' + error.message, true);
    uploadLabelElement.textContent = 'Drop PDF or text file here, or click to browse';
  }
};

// File input change handler
resumeFileInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (file) {
    await handleFileUpload({
      file,
      uploadLabelElement: uploadLabel,
      textInput: resumeTextInput,
      showInfo: showFileInfo,
      fileNameKey: 'resumeFileName',
      maxChars: MAX_RESUME_CHARS,
      successLabel: 'Resume',
    });
  }
});

generalFileInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (file) {
    await handleFileUpload({
      file,
      uploadLabelElement: generalUploadLabel,
      textInput: generalTextInput,
      showInfo: showGeneralFileInfo,
      fileNameKey: 'generalFileName',
      maxChars: MAX_RESUME_CHARS,
      successLabel: 'General context',
    });
  }
});

socialFileInput.addEventListener('change', async (event) => {
  const file = event.target.files?.[0];
  if (file) {
    await handleFileUpload({
      file,
      uploadLabelElement: socialUploadLabel,
      textInput: socialTextInput,
      showInfo: showSocialFileInfo,
      fileNameKey: 'socialFileName',
      maxChars: MAX_RESUME_CHARS,
      successLabel: 'Social context',
    });
  }
});

setupDragAndDrop(fileUploadArea, async (file) => {
  await handleFileUpload({
    file,
    uploadLabelElement: uploadLabel,
    textInput: resumeTextInput,
    showInfo: showFileInfo,
    fileNameKey: 'resumeFileName',
    maxChars: MAX_RESUME_CHARS,
    successLabel: 'Resume',
  });
});

setupDragAndDrop(generalUploadArea, async (file) => {
  await handleFileUpload({
    file,
    uploadLabelElement: generalUploadLabel,
    textInput: generalTextInput,
    showInfo: showGeneralFileInfo,
    fileNameKey: 'generalFileName',
    maxChars: MAX_RESUME_CHARS,
    successLabel: 'General context',
  });
});

setupDragAndDrop(socialUploadArea, async (file) => {
  await handleFileUpload({
    file,
    uploadLabelElement: socialUploadLabel,
    textInput: socialTextInput,
    showInfo: showSocialFileInfo,
    fileNameKey: 'socialFileName',
    maxChars: MAX_RESUME_CHARS,
    successLabel: 'Social context',
  });
});

// Save settings
saveButton.addEventListener('click', async () => {
  const openaiKey = openaiKeyInput.value.trim();
  const anthropicKey = anthropicKeyInput.value.trim();
  const geminiKey = geminiKeyInput.value.trim();
  const resumeText = sanitizeText(resumeTextInput.value, MAX_RESUME_CHARS);
  const generalContextText = sanitizeText(generalTextInput.value, MAX_RESUME_CHARS);
  const socialContextText = sanitizeText(socialTextInput.value, MAX_RESUME_CHARS);
  const systemPrompt = sanitizeText(systemPromptInput.value, MAX_RESUME_CHARS);

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
    mode: activeMode,
    socialStyle: activeSocialStyle,
    openaiKey,
    anthropicKey,
    geminiKey,
    resumeText,
    generalContextText,
    socialContextText,
    systemPrompt,
  });

  showStatus('Settings saved.');
});

// Initialize
loadSettings();
