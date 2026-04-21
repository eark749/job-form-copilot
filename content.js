const PANEL_ID = "job-form-ai-assistant-panel";
const LOADING_ID = "job-form-ai-assistant-loading";
const AUTOFILL_BTN_ID = "job-form-ai-autofill-btn";
const AUTOFILL_OVERLAY_ID = "job-form-ai-autofill-overlay";

let activeElement = null;
let requestCounter = 0;
let activeTone = "balanced";
const boundRoots = new WeakSet();
let assistantEnabled = false;
let assistantStateLoaded = false;
let assistantStateLastSyncMs = 0;
const ASSISTANT_SYNC_TTL_MS = 1200;
const REQUEST_TIMEOUT_MS = 22000;
let isAutoFilling = false;
let activePanelRequestId = 0;

console.log("[JobFormAI] content.js loaded. Protocol:", location.protocol);


/* ─────────────────────────────────────────────────────────────────
   FIELD HELPERS
───────────────────────────────────────────────────────────────── */
function isSupportedField(el) {
  if (!el || !(el instanceof Element)) return false;
  if (el.tagName === "TEXTAREA") return true;
  if (el.tagName === "SELECT") return true;

  if (el.tagName === "INPUT") {
    const t = (el.type || "text").toLowerCase();
    const blocked = new Set(["hidden", "password", "file", "checkbox", "radio", "submit", "button", "color", "range"]);
    return !blocked.has(t);
  }

  if (el.matches("[role='combobox'], [contenteditable='true']")) return true;
  return Boolean(el.isContentEditable);
}

function findLabelText(el) {
  if (!el) return "";

  if (el.id) {
    const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
    if (label?.innerText?.trim()) return label.innerText.trim();
  }

  const parentLabel = el.closest("label");
  if (parentLabel?.innerText?.trim()) return parentLabel.innerText.trim();

  const ariaLabel = el.getAttribute("aria-label");
  if (ariaLabel) return ariaLabel;

  return "";
}

function findQuestionLikeText(el) {
  const chunks = [];
  const section =
    el.closest("fieldset, form, [role='group'], [class*='question'], [class*='field'], [class*='form']") ||
    el.parentElement;

  if (section) {
    const headings = section.querySelectorAll("legend, h1, h2, h3, h4, p, span, div");
    for (const node of headings) {
      const txt = node.innerText?.trim();
      if (!txt) continue;
      if (txt.length > 4 && txt.length < 240) chunks.push(txt);
      if (chunks.length >= 6) break;
    }
  }

  return chunks.join(" | ").slice(0, 900);
}

function getFieldValue(el) {
  if (!el) return "";
  if (el.isContentEditable) return el.innerText || "";
  if (el.tagName === "SELECT") {
    return el.selectedOptions?.[0]?.text || el.value || "";
  }
  return el.value || "";
}

function normalizeSpace(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function extractFirstRegex(text, regex) {
  const match = String(text || "").match(regex);
  return match?.[0] ? String(match[0]).trim() : "";
}

function looksNarrative(text) {
  const value = normalizeSpace(text);
  if (!value) return false;
  return value.length > 90 && /\b(i|my|experience|background|worked|built|developed)\b/i.test(value);
}

function sanitizeValueForField(el, text, context = null) {
  const raw = normalizeSpace(text);
  if (!raw) return "";

  const ctx = context || buildContext(el);
  const fieldType = String(ctx.fieldType || "").toLowerCase();
  const isUrlLike = ctx.isLinkedIn || ctx.isGitHub || ctx.isUrl || fieldType === "url";
  const isEmailLike = ctx.isEmail || fieldType === "email";
  const isPhoneLike = ctx.isPhone || fieldType === "tel";

  if (isEmailLike) {
    return extractFirstRegex(raw, /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  }

  if (isUrlLike) {
    const url = extractFirstRegex(raw, /https?:\/\/[^\s)>"']+/i);
    if (url) return url;
    if (ctx.isLinkedIn) {
      const linkedinPath = extractFirstRegex(raw, /linkedin\.com\/[^\s)>"']+/i);
      return linkedinPath ? `https://${linkedinPath.replace(/^https?:\/\//i, "")}` : "";
    }
    if (ctx.isGitHub) {
      const githubPath = extractFirstRegex(raw, /github\.com\/[^\s)>"']+/i);
      return githubPath ? `https://${githubPath.replace(/^https?:\/\//i, "")}` : "";
    }
  }

  if (isPhoneLike) {
    const compact = raw.replace(/[^\d+()\-\s]/g, "").trim();
    const digits = compact.replace(/\D/g, "");
    return digits.length >= 7 ? compact : "";
  }

  if ((ctx.isFirstName || ctx.isLastName || ctx.isNameLike || ctx.isLocationLike) && looksNarrative(raw)) {
    return "";
  }

  return raw;
}

function pickBestSelectOption(el, suggestion) {
  const search = normalizeSpace(suggestion).toLowerCase();
  const options = Array.from(el.options || []);
  if (!options.length || !search) return null;

  const byExact = options.find((opt) => normalizeSpace(opt.text).toLowerCase() === search)
    || options.find((opt) => normalizeSpace(opt.value).toLowerCase() === search);
  if (byExact) return byExact;

  const byContains = options.find((opt) => normalizeSpace(opt.text).toLowerCase().includes(search))
    || options.find((opt) => search.includes(normalizeSpace(opt.text).toLowerCase()));
  if (byContains) return byContains;

  const suggestionTokens = search.split(/[^a-z0-9+]+/i).filter(Boolean);
  let best = null;
  let bestScore = 0;
  for (const opt of options) {
    const text = normalizeSpace(opt.text).toLowerCase();
    if (!text) continue;
    const score = suggestionTokens.reduce((acc, token) => (text.includes(token) ? acc + 1 : acc), 0);
    if (score > bestScore) {
      bestScore = score;
      best = opt;
    }
  }
  return bestScore > 0 ? best : null;
}

function setFieldValue(el, text, options = {}) {
  if (!el) return;
  const avoidFocus = options.avoidFocus === true;
  const context = options.context || buildContext(el);

  if (String(text).includes("[MISSING_DATA]")) {
    showFieldNotification(el, "Not found in resume");
    return;
  }

  if (el.isContentEditable) {
    if (!avoidFocus) el.focus();
    el.innerText = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    el.dispatchEvent(new Event("blur", { bubbles: true }));
    return;
  }

  if (el.tagName === "SELECT") {
    const option = pickBestSelectOption(el, text);

    if (option) {
      el.value = option.value;
      el.selectedIndex = Array.from(el.options).indexOf(option);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    } else {
      showFieldNotification(el, "No matching option found");
    }
    return;
  }

  const sanitized = sanitizeValueForField(el, text, context);
  if (!sanitized) {
    showFieldNotification(el, "No valid value found");
    return;
  }

  if (!avoidFocus) el.focus();
  el.value = sanitized;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  el.dispatchEvent(new Event("blur", { bubbles: true }));
}


function showFieldNotification(el, message) {
  const rect = el.getBoundingClientRect();
  const note = document.createElement("div");
  note.style.cssText = `
    position:fixed; z-index:2147483647;
    background:#ff4d4d; color:white; padding:4px 8px;
    border-radius:4px; font-size:11px; font-weight:bold;
    pointer-events:none; box-shadow:0 2px 8px rgba(0,0,0,0.2);
    top:${rect.top - 20}px; left:${rect.left}px;
    transition: opacity 0.5s;
  `;
  note.innerText = `⚠️ ${message}`;
  document.body.appendChild(note);

  const originalBorder = el.style.border;
  el.style.border = "2px solid #ff4d4d";

  setTimeout(() => {
    note.style.opacity = "0";
    setTimeout(() => note.remove(), 500);
    el.style.border = originalBorder;
  }, 3000);
}

function buildContext(el) {
  const ctx = {
    url: location.href,
    title: document.title,
    fieldType:
      el.tagName === "INPUT"
        ? el.type || "text"
        : el.tagName === "SELECT"
          ? "select"
          : el.tagName.toLowerCase(),
    name: el.getAttribute("name") || "",
    id: el.id || "",
    placeholder: el.getAttribute("placeholder") || "",
    required: el.required || el.getAttribute("aria-required") === "true",
    maxLength: el.maxLength && el.maxLength > 0 ? el.maxLength : null,
    fieldLabel: findLabelText(el).trim(),
    nearbyQuestionText: findQuestionLikeText(el),
    currentValue: getFieldValue(el).slice(0, 1200),
    options:
      el.tagName === "SELECT"
        ? Array.from(el.options || [])
            .map((opt) => String(opt.text || "").trim())
            .filter(Boolean)
            .slice(0, 80)
        : []
  };

  const labelLower = ctx.fieldLabel.toLowerCase();
  const nameLower = ctx.name.toLowerCase();
  const idLower = ctx.id.toLowerCase();
  const placeholderLower = ctx.placeholder.toLowerCase();
  const joined = `${labelLower} ${nameLower} ${idLower} ${placeholderLower}`;

  ctx.isFirstName = joined.includes("first");
  ctx.isLastName = joined.includes("last");
  ctx.isPhone = ctx.fieldType === "tel" || joined.includes("phone") || joined.includes("mobile");
  ctx.isEmail = ctx.fieldType === "email" || joined.includes("email");
  ctx.isLinkedIn = joined.includes("linkedin");
  ctx.isGitHub = joined.includes("github");
  ctx.isTwitter = joined.includes("twitter") || joined.includes("x.com");
  ctx.isUrl = ctx.fieldType === "url" || joined.includes("portfolio") || joined.includes("website") || joined.includes("url");
  ctx.isNameLike = joined.includes("name");
  ctx.isLocationLike =
    joined.includes("location") ||
    joined.includes("city") ||
    joined.includes("state") ||
    joined.includes("country") ||
    joined.includes("address") ||
    joined.includes("postal") ||
    joined.includes("zip");

  return ctx;
}

/* ─────────────────────────────────────────────────────────────────
   SUGGESTION PANEL
───────────────────────────────────────────────────────────────── */
function getOrCreatePanel() {
  let panel = document.getElementById(PANEL_ID);
  if (panel) return panel;

  panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.style.cssText = `
    position:fixed; z-index:2147483647;
    width:min(500px, calc(100vw - 20px)); max-height:52vh; overflow:auto;
    background:linear-gradient(155deg,#ffffff 0%,#f3fbf9 100%);
    border:1px solid #cfe2dd; border-radius:14px;
    box-shadow:0 20px 50px rgba(8,70,58,0.2); padding:12px;
    font-family:'Avenir Next','Segoe UI',sans-serif;
    color:#153038; display:none;
  `;
  document.documentElement.appendChild(panel);
  return panel;
}

function positionPanel(panel, target) {
  const rect = target.getBoundingClientRect();
  const margin = 8;
  const width = Math.min(500, window.innerWidth - 20);

  let top = rect.bottom + margin;
  let left = Math.min(rect.left, window.innerWidth - width - 10);

  if (top + 300 > window.innerHeight) top = Math.max(10, rect.top - 310);
  left = Math.max(10, left);

  panel.style.top = `${top}px`;
  panel.style.left = `${left}px`;
}

function hidePanel() {
  const panel = document.getElementById(PANEL_ID);
  if (panel) panel.style.display = "none";
}

function renderPanelLoading(panel) {
  panel.innerHTML = "";
  const box = document.createElement("div");
  box.id = LOADING_ID;
  box.style.cssText = "font-size:12px; color:#2e6168;";
  box.innerText = "Crafting suggestions...";
  panel.appendChild(box);
}

function updateLoadingText(message) {
  const node = document.getElementById(LOADING_ID);
  if (!node) return;
  node.innerText = message;
}

function renderPanelError(panel, message) {
  panel.innerHTML = "";
  const err = document.createElement("div");
  err.style.cssText = "font-size:12px; color:#a51f1f;";
  err.innerText = message;
  panel.appendChild(err);
}

function createSuggestionButton(text) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.innerText = text;
  btn.style.cssText = `
    width:100%; text-align:left; padding:10px; margin:0 0 8px;
    border:1px solid #cfe2dd; border-radius:10px; background:#ffffff;
    cursor:pointer; font-size:12px; line-height:1.45; color:#14333a;
  `;
  btn.addEventListener("mouseenter", () => { btn.style.background = "#edf8f5"; });
  btn.addEventListener("mouseleave", () => { btn.style.background = "#ffffff"; });
  btn.addEventListener("click", () => {
    if (activeElement) setFieldValue(activeElement, text);
    hidePanel();
  });
  return btn;
}

function renderPanelWithVariants(panel, variants, warning) {
  panel.innerHTML = "";
  const title = document.createElement("div");
  title.innerText = "Resume-Based Suggestions";
  title.style.cssText = "font-size:12px; font-weight:800; margin-bottom:8px; color:#10403a;";
  panel.appendChild(title);

  const suggestions = variants[activeTone] || variants.balanced || [];
  for (const suggestion of suggestions) {
    if (suggestion) panel.appendChild(createSuggestionButton(suggestion));
  }
  if (warning) {
    const w = document.createElement("div");
    w.style.cssText = "font-size:10px; opacity:0.6; margin-top:4px;";
    w.innerText = warning;
    panel.appendChild(w);
  }
}

async function refreshAssistantEnabledIfNeeded(force = false) {
  if (!globalThis.chrome?.storage?.local) return;
  const now = Date.now();
  if (!force && assistantStateLoaded && now - assistantStateLastSyncMs < ASSISTANT_SYNC_TTL_MS) return;
  const stored = await chrome.storage.local.get(["assistantEnabled"]);
  assistantEnabled = stored.assistantEnabled === true;
  assistantStateLoaded = true;
  assistantStateLastSyncMs = now;
}

async function requestSuggestions(el) {
  if (isAutoFilling) return;
  await refreshAssistantEnabledIfNeeded();
  if (!assistantEnabled) return;

  const panel = getOrCreatePanel();
  activeElement = el;
  positionPanel(panel, el);
  panel.style.display = "block";

  const requestId = ++requestCounter;
  activePanelRequestId = requestId;
  renderPanelLoading(panel);

  const context = buildContext(el);
  const timeoutId = setTimeout(() => {
    if (requestId !== activePanelRequestId) return;
    renderPanelError(panel, `Request timed out after ${Math.round(REQUEST_TIMEOUT_MS / 1000)}s.`);
  }, REQUEST_TIMEOUT_MS);

  chrome.runtime.sendMessage({ type: "GENERATE_SUGGESTIONS", context, requestId }, (response) => {
    clearTimeout(timeoutId);
    if (requestId !== activePanelRequestId) return;
    if (chrome.runtime.lastError) {
      renderPanelError(panel, `Extension messaging error: ${chrome.runtime.lastError.message}`);
      return;
    }
    if (!response || !response.ok) {
      renderPanelError(panel, response?.error || "Error generating suggestions.");
      return;
    }
    renderPanelWithVariants(panel, response.variants || {}, response.warning);
  });
}

function showAutoFillOverlay(message, progress, total) {
  let overlay = document.getElementById(AUTOFILL_OVERLAY_ID);
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = AUTOFILL_OVERLAY_ID;
    overlay.style.cssText = `
      position:fixed; bottom:80px; right:20px; z-index:2147483646;
      background:linear-gradient(135deg,#0f2027,#1a4a3c);
      color:#ffffff; border-radius:14px; padding:14px 18px;
      font-family:sans-serif; font-size:13px; box-shadow:0 8px 30px rgba(0,0,0,0.4);
      min-width:220px; border:1px solid rgba(255,255,255,0.1);
    `;
    document.documentElement.appendChild(overlay);
  }
  const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
  overlay.innerHTML = `
    <div style="font-weight:700; color:#7fffd4; margin-bottom:6px;">✨ Auto-filling</div>
    <div style="font-size:12px; margin-bottom:8px;">${message}</div>
    <div style="background:rgba(255,255,255,0.1); height:6px; border-radius:9px; overflow:hidden;">
      <div style="background:#3dffa0; height:100%; width:${pct}%;"></div>
    </div>
  `;
  overlay.style.display = "block";
}

function hideAutoFillOverlay() {
  const overlay = document.getElementById(AUTOFILL_OVERLAY_ID);
  if (overlay) overlay.remove();
}

function silentFillField(el, tone = "balanced") {
  return new Promise((resolve) => {
    const context = buildContext(el);
    const silentRequestId = Date.now() + Math.floor(Math.random()*1000);
    
    chrome.runtime.sendMessage({ type: "GENERATE_SUGGESTIONS", context, requestId: silentRequestId }, (response) => {
      if (chrome.runtime.lastError) { resolve(null); return; }
      if (!response?.ok) { resolve(null); return; }
      
      const variants = response.variants || {};
      const suggestions = variants[tone] || variants.balanced || [];
      const best = suggestions[0] || null;
      
      // Narrative shield for factual fields
      const isFact = context.isFirstName || context.isLastName || context.isPhone || context.isEmail || context.isLinkedIn;
      if (isFact && best && best.length > 70 && best.includes(" ")) {
        console.warn("[JobFormAI] Blocking narrative text in fact field");
        resolve(null);
        return;
      }

      if (best) {
        setFieldValue(el, best, { avoidFocus: true, context });
      }
      resolve(best || null);
    });
  });
}

async function autoFillPage() {
  await refreshAssistantEnabledIfNeeded();
  if (!assistantEnabled) { alert("Enable Assistant first."); return; }

  const allFields = Array.from(document.querySelectorAll('input, textarea, select, [contenteditable="true"]'))
    .filter(el => {
      if (!isSupportedField(el)) return false;
      if (!el.offsetParent && el.tagName !== "SELECT") return false;
      if (el.tagName === "SELECT") return el.selectedIndex <= 0;
      return getFieldValue(el).trim().length === 0;
    });

  if (allFields.length === 0) { alert("No empty fields."); return; }

  const btn = document.getElementById(AUTOFILL_BTN_ID);
  if (btn) { btn.disabled = true; btn.innerText = "⏳ Filling..."; }

  isAutoFilling = true;
  requestCounter++;

  try {
    let filled = 0;
    for (let i = 0; i < allFields.length; i++) {
        const el = allFields[i];
        const label = findLabelText(el) || el.placeholder || "Field " + (i+1);
        showAutoFillOverlay(`Filling: ${label.slice(0,30)}`, i, allFields.length);
        const res = await silentFillField(el);
        if (res) filled++;
        await new Promise(r => setTimeout(r, 200));
    }
    showAutoFillOverlay(`Done! ${filled} fields filled.`, allFields.length, allFields.length);
    if (btn) btn.innerHTML = `✅ Filled ${filled}`;
    setTimeout(() => {
      hideAutoFillOverlay();
      if (btn) { btn.disabled = false; btn.innerText = "✨ Auto-fill"; }
    }, 2500);
  } finally {
    isAutoFilling = false;
  }
}

function injectAutoFillButton() {
  if (document.getElementById(AUTOFILL_BTN_ID)) return;
  const btn = document.createElement("button");
  btn.id = AUTOFILL_BTN_ID;
  btn.innerText = "✨ Auto-fill";
  btn.style.cssText = `
    position:fixed; bottom:20px; right:20px; z-index:2147483647;
    background:linear-gradient(135deg,#0d7a5f,#0f5e48);
    color:white; border:none; border-radius:999px; padding:10px 18px;
    font-size:13px; font-weight:700; cursor:pointer;
    box-shadow:0 4px 20px rgba(0,0,0,0.3);
  `;
  btn.addEventListener("click", () => autoFillPage());
  document.body?.appendChild(btn);
  updateAutoFillButtonVisibility();
}

function updateAutoFillButtonVisibility() {
  const btn = document.getElementById(AUTOFILL_BTN_ID);
  if (btn) btn.style.display = assistantEnabled ? "block" : "none";
}

function init() {
  if (!/^(https?|file):$/.test(location.protocol)) return;
  document.addEventListener("focusin", (e) => {
    const t = e.target;
    if (isSupportedField(t)) requestSuggestions(t);
  }, true);
  document.addEventListener("mousedown", (e) => {
    const p = document.getElementById(PANEL_ID);
    if (p && !p.contains(e.target) && e.target !== activeElement) hidePanel();
  }, true);

  injectAutoFillButton();
  setTimeout(injectAutoFillButton, 2000);

  if (globalThis.chrome?.storage) {
    refreshAssistantEnabledIfNeeded(true).then(() => updateAutoFillButtonVisibility());
    chrome.storage.onChanged.addListener((changes) => {
      if (changes.assistantEnabled) {
        assistantEnabled = changes.assistantEnabled.newValue === true;
        if (!assistantEnabled) {
          hidePanel();
          hideAutoFillOverlay();
          activePanelRequestId = 0;
        }
        updateAutoFillButtonVisibility();
      }
    });
  }
}

if (globalThis.chrome?.runtime?.onMessage) {
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "JOB_FORM_AI_PING") {
      sendResponse({ ok: true });
      return true;
    }

    if (message?.type !== "SUGGESTION_STREAM_PROGRESS") return;
    if (!assistantEnabled || isAutoFilling) return;
    if (Number(message.requestId || 0) !== activePanelRequestId) return;

    const stage = String(message.stage || "");
    const detail = String(message.detail || "");
    if (stage === "error") {
      const panel = getOrCreatePanel();
      renderPanelError(panel, detail || "Streaming error");
      return;
    }
    if (detail) updateLoadingText(detail);
  });
}

init();
