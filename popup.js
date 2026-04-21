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
const dashResumeSummaryEl = document.getElementById("dashResumeSummary");
const dashSocialSummaryEl = document.getElementById("dashSocialSummary");
const dashSettingsSummaryEl = document.getElementById("dashSettingsSummary");

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
const homeBar = document.getElementById("homeBar");
const homeBtn = document.getElementById("homeBtn");

const MAX_PDF_BYTES = 6 * 1024 * 1024;
let envKeysCache = null;

/* ─────────────────────────────────────────────────────────────────
   NAVIGATION LOGIC
───────────────────────────────────────────────────────────────── */
function showView(viewId) {
  Object.values(views).forEach(v => v.classList.remove("active"));
  views[viewId].classList.add("active");
  document.body.dataset.view = viewId;
  
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
    if (homeBar) homeBar.style.display = "flex";
  } else {
    progressContainer.style.display = "none";
    mainToggle.style.display = "flex";
    if (homeBar) homeBar.style.display = "none";
  }
}

function safePreview(text, max = 100) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max)}...` : value;
}

function renderDashboardSummary(stored) {
  if (dashResumeSummaryEl) {
    if (stored.resumePdfName) {
      dashResumeSummaryEl.textContent = `PDF loaded: ${stored.resumePdfName}`;
    } else if (stored.resumeText) {
      dashResumeSummaryEl.textContent = `Text loaded: ${safePreview(stored.resumeText, 90)}`;
    } else {
      dashResumeSummaryEl.textContent = "No resume added yet.";
    }
  }

  if (dashSocialSummaryEl) {
    const social = [stored.linkedinUrl, stored.githubUrl, stored.twitterUrl].filter(Boolean);
    dashSocialSummaryEl.textContent = social.length ? social.join(" | ") : "No social links saved yet.";
  }

  if (dashSettingsSummaryEl) {
    const model = stored.openaiModel || "gpt-4o-mini";
    const sourceLabel = "Keys hidden (internal config)";
    dashSettingsSummaryEl.textContent = `Model: ${model} | ${sourceLabel}`;
  }
}

document.querySelectorAll("#onboardingProgress .step-dot").forEach((stepBtn) => {
  stepBtn.addEventListener("click", () => {
    const step = String(stepBtn.dataset.step || "").trim();
    if (!step) return;
    showView(`step${step}`);
  });
});

if (homeBtn) {
  homeBtn.addEventListener("click", () => {
    showView("dashboard");
  });
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
document.getElementById("nextToStep3").addEventListener("click", async () => {
  await saveSocialLinksOnly();
  showView("step3");
});
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
  const env = await loadEnvKeys();
  if (apiKeyEl) apiKeyEl.value = stored.openaiApiKey || env.OPENAI_API_KEY || "";
  modelEl.value = stored.openaiModel || "gpt-4o-mini";
  if (mistralApiKeyEl) mistralApiKeyEl.value = stored.mistralApiKey || env.MISTRAL_API_KEY || "";
  assistantEnabledEl.checked = stored.assistantEnabled === true;
  
  linkedinUrlEl.value = stored.linkedinUrl || "";
  githubUrlEl.value = stored.githubUrl || "";
  twitterUrlEl.value = stored.twitterUrl || "";

  if (stored.resumePdfName) {
    pdfMetaEl.textContent = `PDF: ${stored.resumePdfName}`;
  }

  renderDashboardSummary({
    ...stored,
    openaiModel: modelEl.value
  });

  // If onboarding is done, go to dashboard
  if (stored.resumeText) {
    showView("dashboard");
  } else {
    showView("step1");
  }
}

async function saveAll() {
  const env = await loadEnvKeys();
  const data = {
    resumeText: resumeTextEl.value.trim(),
    openaiApiKey: (apiKeyEl?.value || env.OPENAI_API_KEY || "").trim(),
    openaiModel: modelEl.value.trim(),
    mistralApiKey: (mistralApiKeyEl?.value || env.MISTRAL_API_KEY || "").trim(),
    assistantEnabled: assistantEnabledEl.checked,
    linkedinUrl: linkedinUrlEl.value.trim(),
    githubUrl: githubUrlEl.value.trim(),
    twitterUrl: twitterUrlEl.value.trim()
  };
  
  await chrome.storage.local.set(data);
  renderDashboardSummary(data);
  showView("dashboard");
  setStatus("All settings saved!");
}

async function saveSocialLinksOnly() {
  const socialData = {
    linkedinUrl: linkedinUrlEl.value.trim(),
    githubUrl: githubUrlEl.value.trim(),
    twitterUrl: twitterUrlEl.value.trim()
  };
  await chrome.storage.local.set(socialData);

  const base = await chrome.storage.local.get(["resumeText", "resumePdfName", "openaiModel"]);
  renderDashboardSummary({
    ...base,
    ...socialData
  });
}

document.getElementById("saveAll").addEventListener("click", saveAll);

// Old extract listener removed - now automatic on Continue

assistantEnabledEl.addEventListener("change", () => {
  chrome.storage.local.set({ assistantEnabled: assistantEnabledEl.checked });
  setStatus(assistantEnabledEl.checked ? "Assistant ON" : "Assistant OFF");
});

function saveSingleSocialField(fieldId, value) {
  chrome.storage.local.set({ [fieldId]: value.trim() });
}

function flashSaveBtn(btn) {
  btn.textContent = "✓";
  btn.classList.add("done");
  setTimeout(() => {
    btn.textContent = "Save";
    btn.classList.remove("done");
  }, 1500);
}

document.querySelectorAll(".save-link-btn").forEach((btn) => {
  const fieldId = btn.dataset.field;
  const input = document.getElementById(fieldId);
  if (!input) return;

  btn.addEventListener("click", () => {
    saveSingleSocialField(fieldId, input.value);
    flashSaveBtn(btn);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      saveSingleSocialField(fieldId, input.value);
      flashSaveBtn(btn);
    }
  });
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

// Auto-fill button
const autofillBtn = document.getElementById("autofillBtn");
const autofillStatusEl = document.getElementById("autofillStatus");

autofillBtn.addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) return;
  autofillBtn.disabled = true;
  autofillBtn.textContent = "Filling...";
  autofillStatusEl.textContent = "";

  chrome.tabs.sendMessage(tab.id, { type: "TRIGGER_AUTOFILL" }, (response) => {
    autofillBtn.disabled = false;
    autofillBtn.textContent = "✨ Auto-fill Page";
    if (chrome.runtime.lastError) {
      autofillStatusEl.style.color = "#ff4d4d";
      autofillStatusEl.textContent = "Could not reach page. Try refreshing.";
    } else if (response?.filled !== undefined) {
      autofillStatusEl.style.color = "#10b981";
      autofillStatusEl.textContent = `Done! ${response.filled} field${response.filled !== 1 ? "s" : ""} filled.`;
    }
    setTimeout(() => { autofillStatusEl.textContent = ""; }, 3000);
  });
});

// Init
loadSettings();
