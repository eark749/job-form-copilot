const resumeTextEl = document.getElementById("resumeText");
const apiKeyEl = document.getElementById("apiKey");
const modelEl = document.getElementById("model");
const mistralApiKeyEl = document.getElementById("mistralApiKey");
const saveBtn = document.getElementById("saveBtn");
const statusEl = document.getElementById("status");
const resumeFileEl = document.getElementById("resumeFile");
const extractBtn = document.getElementById("extractBtn");
const pdfMetaEl = document.getElementById("pdfMeta");

const MAX_PDF_BYTES = 6 * 1024 * 1024;
let envKeysCache = null;

function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#bb1e1e" : "#0a7f38";
}

function decodePdfEscapedString(input) {
  return input
    .replace(/\\([0-7]{1,3})/g, (_m, oct) => String.fromCharCode(parseInt(oct, 8)))
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t")
    .replace(/\\b/g, "\b")
    .replace(/\\f/g, "\f")
    .replace(/\\\\/g, "\\")
    .replace(/\\\(/g, "(")
    .replace(/\\\)/g, ")");
}

function hexToText(hex) {
  const clean = hex.replace(/\s+/g, "");
  if (!clean) return "";
  const bytes = [];
  for (let i = 0; i < clean.length - 1; i += 2) {
    bytes.push(parseInt(clean.slice(i, i + 2), 16));
  }

  // Try UTF-16BE first if BOM exists, else latin1 fallback.
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = "";
    for (let i = 2; i < bytes.length - 1; i += 2) {
      out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    }
    return out;
  }

  return bytes.map((b) => String.fromCharCode(b)).join("");
}

function extractPdfTextFromArrayBuffer(arrayBuffer) {
  const raw = new TextDecoder("latin1").decode(arrayBuffer);
  const blocks = raw.match(/BT[\s\S]*?ET/g) || [raw];
  const parts = [];

  for (const block of blocks) {
    const tjStrings = block.match(/\((?:\\.|[^\\()])*\)\s*Tj/g) || [];
    for (const token of tjStrings) {
      const core = token.replace(/\s*Tj$/, "").trim();
      const text = core.slice(1, -1);
      const decoded = decodePdfEscapedString(text);
      if (decoded.trim()) parts.push(decoded);
    }

    const tjHex = block.match(/<([0-9A-Fa-f\s]+)>\s*Tj/g) || [];
    for (const token of tjHex) {
      const hex = token.replace(/\s*Tj$/, "").trim().slice(1, -1);
      const decoded = hexToText(hex);
      if (decoded.trim()) parts.push(decoded);
    }

    const tjArrayMatches = block.match(/\[(.*?)\]\s*TJ/gs) || [];
    for (const arrToken of tjArrayMatches) {
      const body = arrToken.replace(/\s*TJ$/, "").trim().slice(1, -1);
      const stringParts = body.match(/\((?:\\.|[^\\()])*\)|<([0-9A-Fa-f\s]+)>/g) || [];
      for (const item of stringParts) {
        if (item.startsWith("(")) {
          const decoded = decodePdfEscapedString(item.slice(1, -1));
          if (decoded.trim()) parts.push(decoded);
        } else if (item.startsWith("<")) {
          const decoded = hexToText(item.slice(1, -1));
          if (decoded.trim()) parts.push(decoded);
        }
      }
    }
  }

  return parts
    .join(" ")
    .replace(/[\u0000-\u001f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }
      resolve(response);
    });
  });
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read file as data URL."));
    reader.readAsDataURL(file);
  });
}

function normalizeExtractedText(text) {
  return String(text || "")
    .replace(/\r/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function parseEnv(raw) {
  const lines = String(raw || "").split("\n");
  const out = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx < 1) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    out[key] = value;
  }
  return out;
}

async function loadMistralKeyFromEnv() {
  const keys = await loadEnvKeys();
  return keys.MISTRAL_API_KEY || "";
}

async function loadOpenAIKeyFromEnv() {
  const keys = await loadEnvKeys();
  return keys.OPENAI_API_KEY || "";
}

async function loadEnvKeys() {
  if (envKeysCache) return envKeysCache;
  try {
    const res = await fetch(chrome.runtime.getURL(".env"), { cache: "no-store" });
    if (!res.ok) return {};
    const text = await res.text();
    envKeysCache = parseEnv(text);
    return envKeysCache;
  } catch {
    return {};
  }
}

async function extractResumeTextWithMistral(file, mistralApiKey) {
  const pdfDataUrl = await fileToDataUrl(file);
  if (!pdfDataUrl || !pdfDataUrl.startsWith("data:application/pdf;base64,")) {
    throw new Error("Could not prepare PDF bytes for OCR extraction.");
  }

  const response = await fetch("https://api.mistral.ai/v1/ocr", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${mistralApiKey}`
    },
    body: JSON.stringify({
      model: "mistral-ocr-latest",
      document: {
        type: "document_url",
        document_url: pdfDataUrl
      },
      include_image_base64: false
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Mistral OCR error: ${response.status} ${errText}`);
  }

  const data = await response.json();
  let text = "";
  if (Array.isArray(data.pages)) {
    text = data.pages
      .map((p) => p?.markdown || p?.text || "")
      .filter(Boolean)
      .join("\n\n");
  }
  if (!text) text = data.output_text || data.text || "";
  const normalized = normalizeExtractedText(text);
  if (!normalized || normalized.length < 50) {
    throw new Error("Mistral OCR extracted too little text from PDF.");
  }
  return normalized;
}

async function extractResumeFromPdf() {
  const file = resumeFileEl.files?.[0];
  if (!file) {
    setStatus("Please choose a PDF file first.", true);
    return;
  }

  if (file.size > MAX_PDF_BYTES) {
    setStatus("PDF is too large. Keep it under 6MB for quick extraction.", true);
    return;
  }

  if (file.type !== "application/pdf") {
    setStatus("Selected file is not a PDF.", true);
    return;
  }

  setStatus("Extracting text from PDF...");
  const arrayBuffer = await file.arrayBuffer();
  const extracted = extractPdfTextFromArrayBuffer(arrayBuffer);

  if (extracted && extracted.length >= 50) {
    resumeTextEl.value = extracted;
    pdfMetaEl.textContent = `Loaded: ${file.name} (${Math.round(file.size / 1024)} KB) | ${extracted.length} chars extracted`;
    setStatus("PDF text extracted. Click Save Settings.");
    return;
  }

  const mistralApiKey = mistralApiKeyEl.value.trim() || (await loadMistralKeyFromEnv());
  if (!mistralApiKey) {
    setStatus("Local extract was weak. Add Mistral key in popup or .env, then click Extract PDF again.", true);
    return;
  }

  setStatus("Local extract was weak. Trying Mistral OCR...");
  const ocrText = await extractResumeTextWithMistral(file, mistralApiKey);
  resumeTextEl.value = ocrText;
  pdfMetaEl.textContent = `Loaded: ${file.name} (${Math.round(file.size / 1024)} KB) | Mistral OCR extracted ${ocrText.length} chars`;
  setStatus("Mistral OCR extraction complete. Click Save Settings.");
}

async function loadSettings() {
  const stored = await chrome.storage.local.get([
    "resumeText",
    "openaiApiKey",
    "openaiModel",
    "mistralApiKey",
    "resumePdfName"
  ]);
  resumeTextEl.value = stored.resumeText || "";
  apiKeyEl.value = stored.openaiApiKey || (await loadOpenAIKeyFromEnv()) || "";
  modelEl.value = stored.openaiModel || "gpt-4o-mini";
  mistralApiKeyEl.value = stored.mistralApiKey || (await loadMistralKeyFromEnv()) || "";
  pdfMetaEl.textContent = stored.resumePdfName ? `Last PDF: ${stored.resumePdfName}` : "No PDF selected.";
}

async function saveSettings() {
  const resumeText = resumeTextEl.value.trim();
  const openaiApiKey = apiKeyEl.value.trim();
  const openaiModel = modelEl.value.trim() || "gpt-4o-mini";
  const mistralApiKey = mistralApiKeyEl.value.trim();
  const resumePdfName = resumeFileEl.files?.[0]?.name || "";

  await chrome.storage.local.set({ resumeText, openaiApiKey, openaiModel, mistralApiKey, resumePdfName });
  setStatus("Saved. Suggestions are ready on job forms.");
}

resumeFileEl.addEventListener("change", () => {
  const file = resumeFileEl.files?.[0];
  pdfMetaEl.textContent = file ? `Selected: ${file.name}` : "No PDF selected.";
});

extractBtn.addEventListener("click", () => {
  extractResumeFromPdf().catch((error) => {
    console.error(error);
    setStatus("Failed to extract PDF text.", true);
  });
});

saveBtn.addEventListener("click", () => {
  saveSettings().catch((error) => {
    console.error(error);
    setStatus("Failed to save settings.", true);
  });
});

loadSettings().catch((error) => {
  console.error(error);
  setStatus("Failed to load saved settings.", true);
});
