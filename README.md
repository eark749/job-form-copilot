# Jeddy — AI Job Form Assistant

A Chrome extension that auto-fills job application forms using your resume.

## Install

1. Go to `chrome://extensions`, enable **Developer mode**
2. Click **Load unpacked** and select this folder
3. Click the Jeddy icon in your toolbar to open the side panel

## API Keys (.env)

The extension reads API keys from a `.env` file inside this folder.

1. Duplicate `env.example` and rename it to `.env`
2. Fill in your keys:
   ```
   OPENAI_API_KEY=sk-...
   MISTRAL_API_KEY=...
   ```
3. Save the file — that's it, no restart needed

> **Where to get them**
> - OpenAI key → [platform.openai.com/api-keys](https://platform.openai.com/api-keys)
> - Mistral key → [console.mistral.ai/api-keys](https://console.mistral.ai/api-keys) (only needed if your PDF is scanned/image-based)

## First-time Setup

1. **Resume** — Upload your resume PDF or paste the text
2. **Social Links** — Add LinkedIn, GitHub, Twitter URLs and hit **Save** on each
3. **Settings** — Choose your GPT model

## Using It

- Open the side panel on any job application page by clicking the Jeddy icon
- **Click any form field** — Jeddy shows AI suggestions based on your resume, click one to fill it
- **Auto-fill Page** — Click the button in the panel to fill all empty fields at once
- Toggle **Assistant** on/off from the panel header
