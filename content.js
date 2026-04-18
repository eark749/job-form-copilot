const PANEL_ID = "job-form-ai-assistant-panel";

let activeElement = null;
let requestCounter = 0;
let activeTone = "balanced";
const boundRoots = new WeakSet();

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
  const section = el.closest("fieldset, form, [role='group'], [class*='question'], [class*='field'], [class*='form']") || el.parentElement;

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

function setFieldValue(el, text) {
  if (!el) return;

  if (el.isContentEditable) {
    el.focus();
    el.innerText = text;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return;
  }

  if (el.tagName === "SELECT") {
    const option = Array.from(el.options || []).find((opt) => (opt.text || "").toLowerCase() === text.toLowerCase());
    if (option) {
      el.value = option.value;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return;
  }

  el.focus();
  el.value = text;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

function getOrCreatePanel() {
  let panel = document.getElementById(PANEL_ID);
  if (panel) return panel;

  panel = document.createElement("div");
  panel.id = PANEL_ID;
  panel.style.position = "fixed";
  panel.style.zIndex = "2147483647";
  panel.style.width = "min(500px, calc(100vw - 20px))";
  panel.style.maxHeight = "52vh";
  panel.style.overflow = "auto";
  panel.style.background = "linear-gradient(155deg, #ffffff 0%, #f3fbf9 100%)";
  panel.style.border = "1px solid #cde0da";
  panel.style.borderRadius = "14px";
  panel.style.boxShadow = "0 20px 50px rgba(8, 70, 58, 0.2)";
  panel.style.padding = "12px";
  panel.style.fontFamily = "'Avenir Next', 'Trebuchet MS', 'Segoe UI', sans-serif";
  panel.style.color = "#153038";
  panel.style.display = "none";

  document.documentElement.appendChild(panel);
  return panel;
}

function positionPanel(panel, target) {
  const rect = target.getBoundingClientRect();
  const margin = 8;
  const width = Math.min(500, window.innerWidth - 20);

  let top = rect.bottom + margin;
  let left = Math.min(rect.left, window.innerWidth - width - 10);

  if (top + 300 > window.innerHeight) {
    top = Math.max(10, rect.top - 310);
  }

  left = Math.max(10, left);

  panel.style.top = `${top}px`;
  panel.style.left = `${left}px`;
}

function hidePanel() {
  const panel = document.getElementById(PANEL_ID);
  if (panel) panel.style.display = "none";
}

function buildContext(el) {
  return {
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
    fieldLabel: findLabelText(el),
    nearbyQuestionText: findQuestionLikeText(el),
    currentValue: getFieldValue(el).slice(0, 1200)
  };
}

function createChip(text, isActive, onClick) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.innerText = text;
  btn.style.border = isActive ? "1px solid #0f7666" : "1px solid #cde0da";
  btn.style.background = isActive ? "#dff3ee" : "#ffffff";
  btn.style.color = "#11413a";
  btn.style.borderRadius = "999px";
  btn.style.padding = "6px 10px";
  btn.style.fontSize = "11px";
  btn.style.fontWeight = "700";
  btn.style.cursor = "pointer";
  btn.addEventListener("click", onClick);
  return btn;
}

function createSuggestionButton(text) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.innerText = text;
  btn.style.width = "100%";
  btn.style.textAlign = "left";
  btn.style.padding = "10px";
  btn.style.margin = "0 0 8px";
  btn.style.border = "1px solid #cfe2dd";
  btn.style.borderRadius = "10px";
  btn.style.background = "#ffffff";
  btn.style.cursor = "pointer";
  btn.style.fontSize = "12px";
  btn.style.lineHeight = "1.45";
  btn.style.color = "#14333a";

  btn.addEventListener("mouseenter", () => {
    btn.style.background = "#edf8f5";
  });

  btn.addEventListener("mouseleave", () => {
    btn.style.background = "#ffffff";
  });

  btn.addEventListener("click", () => {
    if (activeElement) setFieldValue(activeElement, text);
    hidePanel();
  });

  return btn;
}

function renderPanelLoading(panel) {
  panel.innerHTML = "";
  const box = document.createElement("div");
  box.style.fontSize = "12px";
  box.style.color = "#2e6168";
  box.innerText = "Crafting suggestions for this question...";
  panel.appendChild(box);
}

function renderPanelError(panel, message) {
  panel.innerHTML = "";
  const err = document.createElement("div");
  err.style.fontSize = "12px";
  err.style.color = "#a51f1f";
  err.innerText = message;
  panel.appendChild(err);
}

function renderPanelWithVariants(panel, variants, warning) {
  panel.innerHTML = "";

  const title = document.createElement("div");
  title.innerText = "Resume-Based Suggestions";
  title.style.fontSize = "12px";
  title.style.fontWeight = "800";
  title.style.letterSpacing = "0.02em";
  title.style.marginBottom = "8px";
  title.style.color = "#10403a";
  panel.appendChild(title);

  const toneRow = document.createElement("div");
  toneRow.style.display = "flex";
  toneRow.style.gap = "6px";
  toneRow.style.marginBottom = "10px";
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
      empty.style.fontSize = "12px";
      empty.style.color = "#7c5f00";
      empty.innerText = "No suggestions available for this style.";
      listWrap.appendChild(empty);
    }

    if (warning) {
      const warn = document.createElement("div");
      warn.style.fontSize = "11px";
      warn.style.color = "#7c5f00";
      warn.style.marginTop = "2px";
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

function requestSuggestions(el) {
  const panel = getOrCreatePanel();
  activeElement = el;
  positionPanel(panel, el);
  panel.style.display = "block";

  const requestId = ++requestCounter;
  renderPanelLoading(panel);

  const context = buildContext(el);

  if (!globalThis.chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== "function") {
    renderPanelError(panel, "Extension runtime unavailable on this page. Try a job application tab.");
    return;
  }

  chrome.runtime.sendMessage({ type: "GENERATE_SUGGESTIONS", context }, (response) => {
    if (requestId !== requestCounter) return;

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

function onFocusLike(event) {
  const rawTarget = event.composedPath?.()[0] || event.target;
  const target = rawTarget instanceof Element ? rawTarget : null;
  if (!target || !isSupportedField(target)) return;
  if (target === activeElement) return;
  requestSuggestions(target);
}

function onPointerDown(event) {
  const panel = document.getElementById(PANEL_ID);
  if (!panel || panel.style.display === "none") return;

  const target = event.composedPath?.()[0] || event.target;
  const clickedPanel = target instanceof Node && panel.contains(target);
  const clickedField = target === activeElement;

  if (!clickedPanel && !clickedField) hidePanel();
}

function bindRootListeners(root) {
  if (!root || boundRoots.has(root)) return;
  boundRoots.add(root);

  root.addEventListener("focusin", onFocusLike, true);
  root.addEventListener("click", onFocusLike, true);
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

function init() {
  if (!/^https?:$/.test(location.protocol)) {
    return;
  }

  bindRootListeners(document);
  bindOpenShadowRoots(document.documentElement);

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const added of mutation.addedNodes) {
        if (added instanceof Element) {
          bindOpenShadowRoots(added);
        }
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
