const apiKeyInput = document.getElementById("apiKey");
const resumeFileInput = document.getElementById("resumeFile");
const resumeTextInput = document.getElementById("resumeText");
const saveButton = document.getElementById("save");
const status = document.getElementById("status");

const showStatus = (message, isError = false) => {
  status.textContent = message;
  status.className = isError ? "error" : "success";
  setTimeout(() => {
    status.textContent = "";
    status.className = "";
  }, 3000);
};

const loadSettings = async () => {
  const { apiKey, resumeText } = await chrome.storage.local.get([
    "apiKey",
    "resumeText",
  ]);
  apiKeyInput.value = apiKey || "";
  resumeTextInput.value = resumeText || "";
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
  resumeTextInput.value = text.trim();
});

saveButton.addEventListener("click", async () => {
  const apiKey = apiKeyInput.value.trim();
  const resumeText = resumeTextInput.value.trim();

  if (!apiKey) {
    showStatus("API key is required.", true);
    return;
  }

  await chrome.storage.local.set({ apiKey, resumeText });
  showStatus("Saved.");
});

loadSettings();
