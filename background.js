const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models";

const normalizeAnswer = (text) => {
  return text
    .replace(/[—–]/g, ",")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+\./g, ".")
    .replace(/\s+\!/g, "!")
    .replace(/\s+\?/g, "?")
    .trim();
};

const buildJobPrompt = ({
  resumeText,
  jobDescription,
  pageContext,
  question,
  fieldValue,
}) => {
  const system = [
    "You are a writing assistant for job applications.",
    "Write concise, professional, human-sounding answers with specific details.",
    "Use plain punctuation only. Never use em dashes.",
    "Avoid generic AI phrasing, disclaimers, or filler.",
    "Keep the response focused and personalized to the job description and resume.",
    "Prefer concrete achievements, tools, and outcomes.",
  ].join(" ");

  const user = [
    "Resume:\n" + (resumeText || "(none provided)"),
    "\nJob description context:\n" + jobDescription,
    "\nPage context:\n" + (pageContext || "(none provided)"),
    "\nQuestion or prompt:\n" + question,
    "\nCurrent field value (if any):\n" + (fieldValue || "(empty)"),
    "\nWrite the best possible answer.",
  ].join("\n\n");

  return { system, user };
};

const buildGeneralPrompt = ({
  systemPrompt,
  generalContext,
  pageContext,
  question,
  fieldValue,
}) => {
  const system = systemPrompt?.trim()
    ? systemPrompt.trim()
    : [
        "You are a writing assistant.",
        "Write concise, human-sounding answers with specific details.",
        "Use plain punctuation only. Never use em dashes.",
        "Avoid generic AI phrasing, disclaimers, or filler.",
      ].join(" ");

  const user = [
    "General context:\n" + (generalContext || "(none provided)"),
    "\nPage context:\n" + (pageContext || "(none provided)"),
    "\nQuestion or prompt:\n" + question,
    "\nCurrent field value (if any):\n" + (fieldValue || "(empty)"),
    "\nWrite the best possible answer.",
  ].join("\n\n");

  return { system, user };
};

const requestOpenAI = async ({ apiKey, model, system, user }) => {
  const response = await fetch(OPENAI_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.5,
      max_tokens: 320,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed: ${errorText}`);
  }

  const data = await response.json();
  return data?.choices?.[0]?.message?.content?.trim();
};

const requestAnthropic = async ({ apiKey, model, system, user }) => {
  const response = await fetch(ANTHROPIC_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      temperature: 0.5,
      max_tokens: 320,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Anthropic request failed: ${errorText}`);
  }

  const data = await response.json();
  const content = data?.content?.[0]?.text;
  return content?.trim();
};

const requestGemini = async ({ apiKey, model, system, user }) => {
  const response = await fetch(
    `${GEMINI_ENDPOINT}/${model}:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: `${system}\n\n${user}` }],
          },
        ],
        generationConfig: {
          temperature: 0.5,
          maxOutputTokens: 320,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini request failed: ${errorText}`);
  }

  const data = await response.json();
  const content = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  return content?.trim();
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "generateAnswer") {
    return false;
  }

  (async () => {
    try {
      const {
        provider,
        model,
        mode,
        systemPrompt,
        generalContextText,
        resumeText,
        openaiKey,
        anthropicKey,
        geminiKey,
      } = await chrome.storage.local.get([
        "provider",
        "model",
        "mode",
        "systemPrompt",
        "generalContextText",
        "resumeText",
        "openaiKey",
        "anthropicKey",
        "geminiKey",
      ]);

      const activeProvider = provider || "openai";
      const activeModel =
        model ||
        (activeProvider === "anthropic"
          ? "claude-3-5-sonnet-20241022"
          : activeProvider === "gemini"
            ? "gemini-1.5-pro"
            : "gpt-5-nano");
      const activeMode = mode || "job";

      const apiKey =
        activeProvider === "anthropic"
          ? anthropicKey
          : activeProvider === "gemini"
            ? geminiKey
            : openaiKey;

      if (!apiKey) {
        sendResponse({
          ok: false,
          error: "Missing API key. Add it in the extension options.",
        });
        return;
      }

      if (activeMode === "job" && !message.jobDescription) {
        sendResponse({
          ok: false,
          error:
            "No job description context detected. Try scrolling to the job details section.",
        });
        return;
      }

      const promptPayload =
        activeMode === "general"
          ? buildGeneralPrompt({
              systemPrompt,
              generalContext: generalContextText,
              pageContext: message.pageContext,
              question: message.question,
              fieldValue: message.fieldValue,
            })
          : buildJobPrompt({
              resumeText,
              jobDescription: message.jobDescription,
              pageContext: message.pageContext,
              question: message.question,
              fieldValue: message.fieldValue,
            });

      let answer = "";
      if (activeProvider === "anthropic") {
        answer = await requestAnthropic({
          apiKey,
          model: activeModel,
          ...promptPayload,
        });
      } else if (activeProvider === "gemini") {
        answer = await requestGemini({
          apiKey,
          model: activeModel,
          ...promptPayload,
        });
      } else {
        answer = await requestOpenAI({
          apiKey,
          model: activeModel,
          ...promptPayload,
        });
      }

      if (!answer) {
        sendResponse({ ok: false, error: "No answer returned." });
        return;
      }

      sendResponse({ ok: true, answer: normalizeAnswer(answer) });
    } catch (error) {
      sendResponse({ ok: false, error: error.message });
    }
  })();

  return true;
});
