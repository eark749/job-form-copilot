# Job Form AI Assistant (Chrome Extension)

This extension helps you fill job applications faster.
When you click a question field, it shows resume-based AI suggestions directly under that field.

## New in this version
- Resume PDF upload support from popup.
- Local PDF text extraction (for text-based PDFs).
- OCR fallback extraction for difficult/scanned PDFs now uses Mistral OCR.
- Better UI in popup and in-page suggestion card.
- Suggestion style tabs: `Concise`, `Balanced`, `Detailed`.
- Per-browser-tab question history context so each tab's flow stays separate.

## Setup
1. Open Chrome and go to `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select this folder:
   - `/Users/vansh/Documents/Codex/2026-04-18-see-i-want-to-create-a`
5. Open extension popup.
6. Upload your resume PDF and click **Extract PDF**.
7. Add your OpenAI API key (for job-form answers).
8. Add Mistral API key for PDF OCR in either:
   - popup `Mistral API Key` field, or
   - `.env` file: `MISTRAL_API_KEY=...`
9. Add OpenAI key for answer suggestions in either:
   - popup `OpenAI API Key` field, or
   - `.env` file: `OPENAI_API_KEY=...`
10. Click **Save Settings**.

## Usage
1. Open any job application page.
2. Click a text field.
3. Pick a tone tab (`Concise`, `Balanced`, `Detailed`).
4. Click the suggestion you want to paste.

## Notes
- If API key is missing or API fails, fallback suggestions are still shown.
- Scanned/image-only PDFs may not extract correctly; paste text manually in that case.
- Default model is `gpt-4o-mini` and can be changed in popup.

## Current limitations
- Dropdown/radio auto-select is not implemented yet.
- Some websites with strict anti-automation behavior may block scripted input.
