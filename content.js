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

function setFieldValue(el, text, options = {}) {
  if (!el) return;
  const avoidFocus = options.avoidFocus === true;

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
    const search = String(text).toLowerCase().trim();
    const options = Array.from(el.options || []);
    // Try exact match first, then partial match
    const option = options.find((opt) => (opt.text || "").toLowerCase().trim() === search) 
                 || options.find((opt) => (opt.text || "").toLowerCase().includes(search));
    
    if (option) {
      el.value = option.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
    } else {
      showFieldNotification(el, "No matching option found");
    }
    return;
  }

  if (!avoidFocus) el.focus();
  el.value = text;
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
    currentValue: getFieldValue(el).slice(0, 1200)
  };

  if (el.tagName === "SELECT") {
    ctx.options = Array.from(el.options || [])
      .map(opt => opt.text.trim())
      .filter(t => t && !t.toLowerCase().includes("select"));
  }

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
    border:1px solid #cde0da; border-radius:14px;
    box-shadow:0 20px 50px rgba(8,70,58,0.2); padding:12px;
    font-family:'Avenir Next','Trebuchet MS','Segoe UI',sans-serif;
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
  box.innerText = "Crafting suggestions for this question...";
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

function createChip(text, isActive, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.innerText = text;
  btn.style.cssText = `
    border:${isActive ? "1px solid #0f7666" : "1px solid #cde0da"};
    background:${isActive ? "#dff3ee" : "#ffffff"};
    color:#11413a; border-radius:999px; padding:6px 10px;
    font-size:11px; font-weight:700; cursor:pointer;
  `;
  btn.addEventListener("click", onClick);
  return btn;
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
  title.style.cssText = "font-size:12px; font-weight:800; letter-spacing:0.02em; margin-bottom:8px; color:#10403a;";
  panel.appendChild(title);

  const toneRow = document.createElement("div");
  toneRow.style.cssText = "display:flex; gap:6px; margin-bottom:10px;";
  panel.appendChild(toneRow);

  const listWrap = document.createElement("div");
  panel.appendChild(listWrap);

  const tones = ["concise", "balanced", "detailed"];

  function paintList() {
    listWrap.innerHTML = "";
    const suggestions = variants[activeTone] || [];
    for (const suggestion of suggestions) {
      listWrap.appendChild(createSuggestionButton(suggestion));
    }
    if (!suggestions.length) {
      const empty = document.createElement("div");
      empty.style.cssText = "font-size:12px; color:#7c5f00;";
      empty.innerText = "No suggestions available for this style.";
      listWrap.appendChild(empty);
    }
    if (warning) {
      const warn = document.createElement("div");
      warn.style.cssText = "font-size:11px; color:#7c5f00; margin-top:2px;";
      warn.innerText = warning;
      listWrap.appendChild(warn);
    }
  }

  function paintChips() {
    toneRow.innerHTML = "";
    for (const tone of tones) {
      const label = tone === "concise" ? "Concise" : tone === "balanced" ? "Balanced" : "Detailed";
      toneRow.appendChild(
        createChip(label, activeTone === tone, () => {
          activeTone = tone;
          paintChips();
          paintList();
        })
      );
    }
  }

  if (!tones.includes(activeTone)) activeTone = "balanced";
  paintChips();
  paintList();
}

/* ─────────────────────────────────────────────────────────────────
   SUGGESTION REQUEST (for focus-based panel)
───────────────────────────────────────────────────────────────── */
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
  if (!assistantStateLoaded || !assistantEnabled) {
    hidePanel();
    return;
  }
  const panel = getOrCreatePanel();
  activeElement = el;
  positionPanel(panel, el);
  panel.style.display = "block";

  const requestId = ++requestCounter;
  renderPanelLoading(panel);

  const context = buildContext(el);
  console.log("[JobFormAI] sending field context", {
    requestId,
    field: context.fieldLabel || context.placeholder || context.name || "unknown",
    fieldType: context.fieldType,
    url: context.url
  });

  if (!globalThis.chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
    renderPanelError(panel, "Extension runtime unavailable on this page. Try a job application tab.");
    return;
  }

  const timeoutId = setTimeout(() => {
    if (requestId !== requestCounter) return;
    renderPanelError(panel, "Timed out waiting for assistant response. Try again.");
  }, REQUEST_TIMEOUT_MS);

  chrome.runtime.sendMessage({ type: "GENERATE_SUGGESTIONS", context, requestId }, (response) => {
    clearTimeout(timeoutId);
    if (requestId !== requestCounter || isAutoFilling) return;
    if (!assistantEnabled) { hidePanel(); return; }

    if (chrome.runtime.lastError) {
      renderPanelError(panel, `Extension messaging error: ${chrome.runtime.lastError.message}`);
      return;
    }
    if (!response || !response.ok) {
      renderPanelError(panel, response?.error || "Unable to generate suggestions.");
      return;
    }

    const variants = response.variants || {};
    renderPanelWithVariants(panel, variants, response.warning || "");
  });
}

/* ─────────────────────────────────────────────────────────────────
   AUTO-FILL OVERLAY
───────────────────────────────────────────────────────────────── */
function showAutoFillOverlay(message, progress, total) {
  let overlay = document.getElementById(AUTOFILL_OVERLAY_ID);
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.id = AUTOFILL_OVERLAY_ID;
    overlay.style.cssText = `
      position:fixed; bottom:80px; right:20px; z-index:2147483646;
      background:linear-gradient(135deg,#0f2027,#1a4a3c);
      color:#ffffff; border-radius:14px; padding:14px 18px;
      font-family:'Avenir Next','Segoe UI',sans-serif;
      font-size:13px; box-shadow:0 8px 30px rgba(0,0,0,0.4);
      min-width:220px; max-width:300px;
      border:1px solid rgba(255,255,255,0.1);
      transition: opacity 0.3s;
    `;
    document.documentElement.appendChild(overlay);
  }

  const pct = total > 0 ? Math.round((progress / total) * 100) : 0;
  overlay.innerHTML = `
    <div style="font-weight:700; margin-bottom:6px; color:#7fffd4;">✨ Auto-filling</div>
    <div style="font-size:12px; opacity:0.85; margin-bottom:8px;">${message}</div>
    <div style="background:rgba(255,255,255,0.15); border-radius:999px; height:6px; overflow:hidden;">
      <div style="background:#3dffa0; height:100%; width:${pct}%; border-radius:999px; transition:width 0.3s;"></div>
    </div>
    <div style="font-size:11px; margin-top:6px; opacity:0.6;">${progress} / ${total} fields</div>
  `;
  overlay.style.display = "block";
}

function hideAutoFillOverlay() {
  const overlay = document.getElementById(AUTOFILL_OVERLAY_ID);
  if (!overlay) return;
  overlay.style.opacity = "0";
  setTimeout(() => { if (overlay) overlay.remove(); }, 400);
}

/* ─────────────────────────────────────────────────────────────────
   SILENT FIELD FILL (no panel shown)
───────────────────────────────────────────────────────────────── */
function silentFillField(el, tone = "balanced") {
  return new Promise((resolve) => {
    if (!globalThis.chrome?.runtime?.sendMessage) { resolve(null); return; }

    const context = buildContext(el);
    const timeoutId = setTimeout(() => resolve(null), REQUEST_TIMEOUT_MS);
    const silentRequestId = Date.now() + Math.floor(Math.random() * 1000);

    chrome.runtime.sendMessage(
      { type: "GENERATE_SUGGESTIONS", context, requestId: silentRequestId, silent: true },
      (response) => {
        clearTimeout(timeoutId);
        if (chrome.runtime?.lastError || !response?.ok) { 
          console.warn("[JobFormAI] silentFillField failed for", context.fieldLabel, response?.error || "");
          resolve(null); 
          return; 
        }

        const variants = response.variants || {};
        const suggestions = variants[tone] || variants.balanced || variants.concise || [];
        const best = suggestions[0] || null;
        
        console.log(`[JobFormAI] AI Suggested for "${context.fieldLabel}":`, best);
        
        if (best) setFieldValue(el, best, { avoidFocus: true });
        resolve(best);
      }
    );
  });
}

/* ─────────────────────────────────────────────────────────────────
   AUTO-FILL PAGE
───────────────────────────────────────────────────────────────── */
async function autoFillPage() {
  await refreshAssistantEnabledIfNeeded();
  if (!assistantEnabled) {
    alert("Job Form AI: Please enable the assistant from the extension popup first.");
    return;
  }

  // Collect all fillable fields that are empty (or allow override)
  const allFields = Array.from(
    document.querySelectorAll('input, textarea, select, [contenteditable="true"]')
  ).filter((el) => {
    if (!isSupportedField(el)) return false;
    if (!el.offsetParent && el.tagName !== "SELECT") return false; // skip hidden
    const val = getFieldValue(el).trim();
    // Skip fields that already have a value (don't override user's work)
    // For select, skip if a non-default option is chosen
    if (el.tagName === "SELECT") return el.selectedIndex <= 0;
    return val.length === 0;
  });

  if (allFields.length === 0) {
    alert("No empty fillable fields found on this page.");
    return;
  }

  // Disable the auto-fill button during operation
  const btn = document.getElementById(AUTOFILL_BTN_ID);
  if (btn) {
    btn.disabled = true;
    btn.innerText = "⏳ Filling...";
  }

  hidePanel();
  isAutoFilling = true;
  requestCounter += 1;

  try {
    let filled = 0;
    for (let i = 0; i < allFields.length; i++) {
        const el = allFields[i];
        const label = findLabelText(el) || el.getAttribute("placeholder") || el.getAttribute("name") || `Field ${i + 1}`;
        showAutoFillOverlay(`Filling: ${label.slice(0, 45)}`, i, allFields.length);

        await silentFillField(el, activeTone);
        filled++;

        // Small delay so we don't hammer the API
        await new Promise((r) => setTimeout(r, 300));
    }

    showAutoFillOverlay(`Done! ${filled} fields filled.`, allFields.length, allFields.length);
    setTimeout(hideAutoFillOverlay, 2500);
  } finally {
    isAutoFilling = false;
    if (btn) {
        btn.disabled = false;
        btn.innerText = "✨ Auto-fill";
    }
  }
}


/* ─────────────────────────────────────────────────────────────────
   FLOATING AUTO-FILL BUTTON
───────────────────────────────────────────────────────────────── */
function injectAutoFillButton() {
  if (document.getElementById(AUTOFILL_BTN_ID)) return;

  const btn = document.createElement("button");
  btn.id = AUTOFILL_BTN_ID;
  btn.innerText = "✨ Auto-fill";
  btn.title = "Auto-fill all empty fields on this page using your resume";
  btn.style.cssText = `
    position:fixed; bottom:20px; right:20px; z-index:2147483647;
    background:linear-gradient(135deg,#0d7a5f,#0f5e48);
    color:#ffffff; border:none; border-radius:999px;
    padding:10px 18px; font-size:13px; font-weight:700;
    font-family:'Avenir Next','Segoe UI',sans-serif;
    cursor:pointer !important; box-shadow:0 4px 20px rgba(13,122,95,0.5);
    transition:transform 0.15s, box-shadow 0.15s;
    display:flex; align-items:center; gap:6px;
    pointer-events: auto !important;
  `;


  btn.addEventListener("mouseenter", () => {
    btn.style.transform = "scale(1.05)";
    btn.style.boxShadow = "0 6px 28px rgba(13,122,95,0.7)";
  });
  btn.addEventListener("mouseleave", () => {
    btn.style.transform = "scale(1)";
    btn.style.boxShadow = "0 4px 20px rgba(13,122,95,0.5)";
  });
  btn.addEventListener("click", () => {
    autoFillPage().catch((err) => console.error("[JobFormAI] autoFillPage error", err));
  });

  const parent = document.body || document.documentElement;
  if (parent) {
    parent.appendChild(btn);
    console.log("[JobFormAI] Autofill button injected into", parent.tagName);
    updateAutoFillButtonVisibility();
  } else {
    console.error("[JobFormAI] Could not find parent to inject button.");
  }
}


function updateAutoFillButtonVisibility() {
  const btn = document.getElementById(AUTOFILL_BTN_ID);
  if (!btn) return;
  btn.style.setProperty("display", assistantEnabled ? "flex" : "none", "important");
}


/* ─────────────────────────────────────────────────────────────────
   FOCUS / POINTER EVENTS
───────────────────────────────────────────────────────────────── */
function onFocusLike(event) {
  if (isAutoFilling) return;
  const rawTarget = event.composedPath?.()[0] || event.target;
  const target = rawTarget instanceof Element ? rawTarget : null;
  if (!target || !isSupportedField(target)) return;
  if (target === activeElement) return;
  requestSuggestions(target).catch((error) => {
    console.error("[JobFormAI] requestSuggestions failed", error);
  });
}

function onPointerDown(event) {
  const panel = document.getElementById(PANEL_ID);
  if (!panel || panel.style.display === "none") return;

  const target = event.composedPath?.()[0] || event.target;
  const clickedPanel = target instanceof Node && panel.contains(target);
  const clickedField = target === activeElement;
  const clickedBtn = target instanceof Node && document.getElementById(AUTOFILL_BTN_ID)?.contains(target);

  if (!clickedPanel && !clickedField && !clickedBtn) hidePanel();
}

/* ─────────────────────────────────────────────────────────────────
   SHADOW DOM + MUTATION OBSERVER
───────────────────────────────────────────────────────────────── */
function bindRootListeners(root) {
  if (!root || boundRoots.has(root)) return;
  boundRoots.add(root);
  root.addEventListener("focusin", onFocusLike, true);
  root.addEventListener("mousedown", onPointerDown, true);
}

function bindOpenShadowRoots(node) {
  if (!node || !(node instanceof Element)) return;
  if (node.shadowRoot && node.shadowRoot.mode === "open") {
    bindRootListeners(node.shadowRoot);
    node.shadowRoot.querySelectorAll("*").forEach((child) => bindOpenShadowRoots(child));
  }
  node.querySelectorAll?.("*").forEach((child) => {
    if (child.shadowRoot && child.shadowRoot.mode === "open") {
      bindRootListeners(child.shadowRoot);
    }
  });
}

/* ─────────────────────────────────────────────────────────────────
   INIT
───────────────────────────────────────────────────────────────── */
function init() {
  if (!/^(https?|file):$/.test(location.protocol)) return;

  bindRootListeners(document);
  bindOpenShadowRoots(document.documentElement);
  
  // Try injecting button immediately and also after a short delay
  injectAutoFillButton();
  setTimeout(injectAutoFillButton, 1000);
  setTimeout(injectAutoFillButton, 3000);


  if (globalThis.chrome?.storage?.local) {
    refreshAssistantEnabledIfNeeded(true).then(() => {
        updateAutoFillButtonVisibility();
    }).catch((error) => {
      console.error("[JobFormAI] assistant toggle load failed", error);
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !Object.prototype.hasOwnProperty.call(changes, "assistantEnabled")) return;
      assistantEnabled = changes.assistantEnabled.newValue === true;
      assistantStateLoaded = true;
      assistantStateLastSyncMs = Date.now();
      updateAutoFillButtonVisibility();
      if (!assistantEnabled) {
        requestCounter += 1;
        hidePanel();
      }
    });
  }

  if (globalThis.chrome?.runtime?.onMessage) {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.type !== "SUGGESTION_STREAM_PROGRESS") return false;
      const incomingRequestId = Number(message.requestId || 0);
      if (incomingRequestId !== requestCounter) return false;
      const detail = String(message.detail || "");
      if (!detail) return false;
      updateLoadingText(detail);
      return false;
    });
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const added of mutation.addedNodes) {
        if (added instanceof Element) bindOpenShadowRoots(added);
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });

  window.addEventListener("scroll", () => {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || panel.style.display === "none" || !activeElement) return;
    positionPanel(panel, activeElement);
  });

  window.addEventListener("resize", () => {
    const panel = document.getElementById(PANEL_ID);
    if (!panel || panel.style.display === "none" || !activeElement) return;
    positionPanel(panel, activeElement);
  });
}

init();
