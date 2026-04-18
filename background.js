const SYSTEM_PROMPT = [
  "You are an assistant that writes concise, truthful job application responses.",
  "Use only information present in the user's resume and current field context.",
  "Do not fabricate years, achievements, or tools not present in resume.",
  "Return valid JSON object only with keys concise, balanced, detailed.",
  "Each key should contain an array of exactly 3 plain text suggestions.",
  "Keep concise answers under 35 words, balanced under 80 words, detailed under 140 words."
].join(" ");

const tabStateById = new Map();
let envKeysCache = null;

function getTabState(tabId) {
  if (!tabStateById.has(tabId)) {
    tabStateById.set(tabId, { history: [] });
  }
  return tabStateById.get(tabId);
}

chrome.tabs?.onRemoved.addListener((tabId) => {
  tabStateById.delete(tabId);
});

function pushTabHistory(tabId, context, payload) {
  const state = getTabState(tabId);
  const question = context.fieldLabel || context.placeholder || context.name || context.nearbyQuestionText || "unknown question";
  state.history.push({
    question: String(question).slice(0, 220),
    topSuggestion: String(payload?.balanced?.[0] || payload?.concise?.[0] || "").slice(0, 220),
    ts: Date.now()
  });
  if (state.history.length > 10) state.history.splice(0, state.history.length - 10);
}

function toStringArray(input) {
  if (!Array.isArray(input)) return [];
  return input.map((item) => String(item).trim()).filter(Boolean).slice(0, 3);
}

function fallbackSuggestions(context) {
  const field = context.fieldLabel || context.placeholder || context.name || "this question";
  return {
    concise: [
      `My background aligns well with ${field}, with practical experience and quick adaptability.`,
      `I can contribute immediately using hands-on experience and strong ownership.`,
      `I bring clear communication, execution focus, and measurable impact in similar work.`
    ],
    balanced: [
      `Based on my resume, I offer practical experience relevant to ${field}, with strong problem-solving, collaboration, and ownership in delivery.`,
      `I bring hands-on project experience, consistent execution, and communication that helps teams move quickly while maintaining quality.`,
      `My background reflects adaptable learning, reliable delivery, and a results-oriented mindset aligned with this role.`
    ],
    detailed: [
      `From my resume, my experience aligns with ${field} through hands-on implementation work, collaboration across teams, and a strong ownership mindset. I focus on delivering reliable outcomes, learning quickly in new environments, and communicating clearly throughout execution.`,
      `I can contribute meaningfully in this area by combining practical project experience with structured problem solving. My approach is to understand requirements deeply, execute with quality, and iterate based on feedback so outcomes are measurable and aligned to business goals.`,
      `My profile shows consistent execution and adaptability across different responsibilities. I emphasize accountability, clear updates, and shipping impactful work, which allows me to support team goals while continuously improving efficiency and quality.`
    ]
  };
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

async function extractResumeTextWithMistral(mistralApiKey, pdfDataUrl) {
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

  if (!text) {
    text = data.output_text || data.text || "";
  }

  const normalized = normalizeExtractedText(text);
  if (!normalized || normalized.length < 50) {
    throw new Error("Mistral OCR extracted too little text from PDF.");
  }

  return normalized;
}

async function extractResumeTextWithOpenAI(apiKey, model, fileName, pdfDataUrl) {
  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: [
        {
          role: "user",
          content: [
            {
              type: "input_file",
              filename: fileName || "resume.pdf",
              file_data: pdfDataUrl
            },
            {
              type: "input_text",
              text:
                "Extract the complete readable resume text from this PDF. Return plain text only. Preserve headings, bullets, company names, dates, and skills. Do not summarize."
            }
          ]
        }
      ],
      max_output_tokens: 4000
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI extraction error: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const text = normalizeExtractedText(data.output_text || "");
  if (!text || text.length < 50) {
    throw new Error("AI extracted too little text from PDF.");
  }

  return text;
}

async function generateWithOpenAI(apiKey, model, resumeText, context, tabHistory) {
  const userPrompt = {
    resume: resumeText,
    fieldContext: context,
    recentQuestionsInThisBrowserTab: tabHistory,
    instructions: [
      "Generate suggestions for this single field only.",
      "Avoid repeating nearly identical text across the 3 variants.",
      "No markdown, no numbering, no extra keys.",
      "Return JSON object exactly: { concise: string[], balanced: string[], detailed: string[] }."
    ]
  };

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      input: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: JSON.stringify(userPrompt) }
      ],
      max_output_tokens: 900,
      temperature: 0.45
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`OpenAI error: ${response.status} ${errText}`);
  }

  const data = await response.json();
  const text = data.output_text?.trim();
  if (!text) {
    throw new Error("No output text returned from model.");
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Model returned non-JSON output.");
  }

  const payload = {
    concise: toStringArray(parsed.concise),
    balanced: toStringArray(parsed.balanced),
    detailed: toStringArray(parsed.detailed)
  };

  if (!payload.concise.length || !payload.balanced.length || !payload.detailed.length) {
    throw new Error("Model output missing one or more variant arrays.");
  }

  return payload;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === "EXTRACT_RESUME_FROM_PDF") {
    (async () => {
      try {
        const mistralApiKey = String(message.mistralApiKey || "").trim();
        const pdfDataUrl = String(message.pdfDataUrl || "");

        if (!pdfDataUrl || !pdfDataUrl.startsWith("data:application/pdf;base64,")) {
          sendResponse({ ok: false, error: "No PDF data received." });
          return;
        }

        if (!mistralApiKey) {
          sendResponse({ ok: false, error: "Missing Mistral API key for OCR extraction." });
          return;
        }

        const resumeText = await extractResumeTextWithMistral(mistralApiKey, pdfDataUrl);
        sendResponse({ ok: true, resumeText, provider: "mistral" });
      } catch (error) {
        console.error(error);
        sendResponse({
          ok: false,
          error: "Could not read this PDF with OCR. Try another PDF or paste text manually.",
          debug: String(error?.message || "").slice(0, 220)
        });
      }
    })();
    return true;
  }

  if (message?.type !== "GENERATE_SUGGESTIONS") {
    return false;
  }

  (async () => {
    const { resumeText, openaiApiKey, openaiModel } = await chrome.storage.local.get([
      "resumeText",
      "openaiApiKey",
      "openaiModel"
    ]);
    const envKeys = await loadEnvKeys();
    const effectiveOpenAIKey = String(openaiApiKey || envKeys.OPENAI_API_KEY || "").trim();

    if (!resumeText || resumeText.trim().length < 50) {
      sendResponse({
        ok: false,
        error: "Please open extension popup and upload your resume PDF (or paste resume text) first."
      });
      return;
    }

    const context = message.context || {};
    const tabId = typeof sender?.tab?.id === "number" ? sender.tab.id : -1;
    const tabHistory = getTabState(tabId).history;

    if (!effectiveOpenAIKey) {
      const payload = fallbackSuggestions(context);
      pushTabHistory(tabId, context, payload);
      sendResponse({
        ok: true,
        variants: payload,
        warning: "OpenAI API key missing. Showing basic local suggestions."
      });
      return;
    }

    try {
      const payload = await generateWithOpenAI(
        effectiveOpenAIKey,
        openaiModel || "gpt-4o-mini",
        resumeText,
        context,
        tabHistory
      );
      pushTabHistory(tabId, context, payload);
      sendResponse({ ok: true, variants: payload });
    } catch (error) {
      console.error(error);
      const payload = fallbackSuggestions(context);
      pushTabHistory(tabId, context, payload);
      sendResponse({
        ok: true,
        variants: payload,
        warning: "AI request failed. Showing fallback suggestions."
      });
    }
  })();

  return true;
});
