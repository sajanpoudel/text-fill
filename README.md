# Text Fill Assistant

Chrome extension that drafts job application answers using your resume and the current page's job description.

## Setup

1. **Create an OpenAI key** and keep it ready.
2. **Load the extension**:
   - Open `chrome://extensions`.
   - Enable **Developer mode**.
   - Click **Load unpacked** and select this repo.
3. **Open settings**:
   - Click the extension icon.
   - Choose **Open Settings**.
   - Select a provider/model, add the matching API key, and choose a mode.
   - For **Job application**, upload or paste your resume text (TXT only).
   - For **General writing**, provide a custom system prompt and optional reference context.

## Usage

1. Navigate to a job application page.
2. Click inside a text area or text input.
3. Use **Fill with AI** to generate a response.
4. Click **Insert** to place the answer in the field.

## Notes

- The extension reads the surrounding page content as job description context and surfaces it in the modal.
- Em dashes are normalized to commas.
- PDF parsing is not supported yet in the extension UI.
- The `.env.example` file is provided to document configuration, but the extension reads the API key from local extension storage after you save it in Settings.
