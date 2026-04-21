// Selectors
const resumeTextEl = document.getElementById("resumeText");
const apiKeyEl = document.getElementById("apiKey") || document.getElementById("openaiApiKey");
const modelEl = document.getElementById("model") || document.getElementById("openaiModel");
const mistralApiKeyEl = document.getElementById("mistralApiKey");
const assistantEnabledEl = document.getElementById("assistantEnabled");
const statusEl = document.getElementById("status");
const resumeFileEl = document.getElementById("resumeFile");
const extractBtn = document.getElementById("extractBtn");
const pdfMetaEl = document.getElementById("pdfMeta");

// Social Link Selectors
const linkedinUrlEl = document.getElementById("linkedinUrl");
const githubUrlEl = document.getElementById("githubUrl");
const twitterUrlEl = document.getElementById("twitterUrl");

// View Selectors
const views = {
  step1: document.getElementById("step1"),
  step2: document.getElementById("step2"),
  step3: document.getElementById("step3"),
  dashboard: document.getElementById("dashboard")
};
const progressContainer = document.getElementById("onboardingProgress");
const mainToggle = document.getElementById("mainToggle");

const MAX_PDF_BYTES = 6 * 1024 * 1024;
let envKeysCache = null;

/* ─────────────────────────────────────────────────────────────────
   NAVIGATION LOGIC
───────────────────────────────────────────────────────────────── */
function showView(viewId) {
  Object.values(views).forEach(v => v.classList.remove("active"));
  views[viewId].classList.add("active");
  
  // Update progress dots
  const stepMatch = viewId.match(/step(\d)/);
  if (stepMatch) {
    const step = parseInt(stepMatch[1]);
    document.querySelectorAll(".step-dot").forEach(dot => {
      const dotStep = parseInt(dot.dataset.step);
      dot.classList.toggle("active", dotStep === step);
    });
    progressContainer.style.display = "flex";
    mainToggle.style.display = "none";
  } else {
    progressContainer.style.display = "none";
    mainToggle.style.display = "flex";
  }
}

document.getElementById("nextToStep2").addEventListener("click", async () => {
  const file = resumeFileEl.files?.[0];
  const hasManualText = resumeTextEl.value.trim().length > 50;

  if (file && !hasManualText) {
    const btn = document.getElementById("nextToStep2");
    const originalText = btn.innerText;
    btn.classList.add("loading");
    btn.innerText = "Extracting...";
    setStatus("Extracting your resume...");

    try {
      const arrayBuffer = await file.arrayBuffer();
      let text = extractPdfTextFromArrayBuffer(arrayBuffer);
      
      if (text.length < 50) {
        const mKey = mistralApiKeyEl.value.trim() || (await loadEnvKeys()).MISTRAL_API_KEY;
        if (mKey) {
          setStatus("Trying Mistral OCR...");
          text = await extractWithMistral(file, mKey);
        }
      }

      if (text.length > 50) {
        resumeTextEl.value = text;
        await chrome.storage.local.set({ resumePdfName: file.name, resumeText: text });
        setStatus("Resume ready!");
        showView("step2");
      } else {
        setStatus("Could not read PDF. Please paste text.", true);
      }
    } catch (err) {
      console.error(err);
      setStatus("Extraction error", true);
    } finally {
      btn.classList.remove("loading");
      btn.innerText = originalText;
    }
  } else if (hasManualText) {
    showView("step2");
  } else {
    setStatus("Please upload or paste your resume first.", true);
  }
});
document.getElementById("backToStep1").addEventListener("click", () => showView("step1"));
document.getElementById("nextToStep3").addEventListener("click", () => showView("step3"));
document.getElementById("backToStep2").addEventListener("click", () => showView("step2"));

document.getElementById("btnEditResume").addEventListener("click", () => showView("step1"));
document.getElementById("btnEditSocials").addEventListener("click", () => showView("step2"));
document.getElementById("btnEditSettings").addEventListener("click", () => showView("step3"));

/* ─────────────────────────────────────────────────────────────────
   CORE UTILS
───────────────────────────────────────────────────────────────── */
function setStatus(message, isError = false) {
  statusEl.textContent = message;
  statusEl.style.color = isError ? "#ff4d4d" : "#10b981";
  setTimeout(() => { if(statusEl.textContent === message) statusEl.textContent = ""; }, 3000);
}

// PDF Extraction (Reused from original)
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
      const text = token.replace(/\s*Tj$/, "").trim().slice(1, -1);
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
  return parts.join(" ").replace(/[\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim();
}

async function loadEnvKeys() {
  if (envKeysCache) return envKeysCache;
  try {
    const res = await fetch(chrome.runtime.getURL(".env"), { cache: "no-store" });
    if (!res.ok) return {};
    const text = await res.text();
    const lines = text.split("\n");
    const out = {};
    for (const line of lines) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const idx = t.indexOf("=");
      if (idx > 0) out[t.slice(0, idx).trim()] = t.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    }
    envKeysCache = out;
    return out;
  } catch { return {}; }
}

/* ─────────────────────────────────────────────────────────────────
   SAVE & LOAD
───────────────────────────────────────────────────────────────── */
async function loadSettings() {
  const stored = await chrome.storage.local.get([
    "resumeText",
    "openaiApiKey",
    "openaiModel",
    "mistralApiKey",
    "resumePdfName",
    "assistantEnabled",
    "linkedinUrl",
    "githubUrl",
    "twitterUrl"
  ]);

  resumeTextEl.value = stored.resumeText || "";
  apiKeyEl.value = stored.openaiApiKey || (await loadEnvKeys()).OPENAI_API_KEY || "";
  modelEl.value = stored.openaiModel || "gpt-4o-mini";
  mistralApiKeyEl.value = stored.mistralApiKey || (await loadEnvKeys()).MISTRAL_API_KEY || "";
  assistantEnabledEl.checked = stored.assistantEnabled === true;
  
  linkedinUrlEl.value = stored.linkedinUrl || "";
  githubUrlEl.value = stored.githubUrl || "";
  twitterUrlEl.value = stored.twitterUrl || "";

  if (stored.resumePdfName) {
    pdfMetaEl.textContent = `PDF: ${stored.resumePdfName}`;
  }

  // If onboarding is done, go to dashboard
  if (stored.resumeText) {
    showView("dashboard");
  } else {
    showView("step1");
  }
}

async function saveAll() {
  const data = {
    resumeText: resumeTextEl.value.trim(),
    openaiApiKey: apiKeyEl.value.trim(),
    openaiModel: modelEl.value.trim(),
    mistralApiKey: mistralApiKeyEl.value.trim(),
    assistantEnabled: assistantEnabledEl.checked,
    linkedinUrl: linkedinUrlEl.value.trim(),
    githubUrl: githubUrlEl.value.trim(),
    twitterUrl: twitterUrlEl.value.trim()
  };
  
  await chrome.storage.local.set(data);
  showView("dashboard");
  setStatus("All settings saved!");
}

document.getElementById("saveAll").addEventListener("click", saveAll);

// Old extract listener removed - now automatic on Continue

assistantEnabledEl.addEventListener("change", () => {
  chrome.storage.local.set({ assistantEnabled: assistantEnabledEl.checked });
  setStatus(assistantEnabledEl.checked ? "Assistant ON" : "Assistant OFF");
});

// Dropzone helper
document.getElementById("dropZone").addEventListener("click", () => resumeFileEl.click());
resumeFileEl.addEventListener("change", () => {
    if (resumeFileEl.files[0]) pdfMetaEl.textContent = `Selected: ${resumeFileEl.files[0].name}`;
});

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(new Error("Failed to read file"));
    reader.readAsDataURL(file);
  });
}

async function extractWithMistral(file, apiKey) {
  const pdfDataUrl = await fileToDataUrl(file);
  const response = await fetch("https://api.mistral.ai/v1/ocr", {
    method: "POST",
    headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: "mistral-ocr-latest",
      document: { type: "document_url", document_url: pdfDataUrl }
    })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Mistral error ${response.status}: ${errText}`);
  }
  const data = await response.json();
  const text = (data.pages || []).map(p => p.markdown || p.text || "").join("\n\n");
  return text.trim();
}

// Init
loadSettings();
