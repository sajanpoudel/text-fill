const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models";

const normalizeAnswer = (text) => {
  return text
    .replace(/[—–]/g, ",")           // Replace em/en dashes with commas
    .replace(/\*\s*\*\s*\*/g, '\n\n') // Replace *** with paragraph break
    .replace(/\s*,\s*/g, ", ")        // Normalize comma spacing
    .replace(/\s+\./g, ".")           // Remove space before period
    .replace(/\s+\!/g, "!")           // Remove space before exclamation
    .replace(/\s+\?/g, "?")           // Remove space before question mark
    .replace(/\n{3,}/g, '\n\n')       // Max 2 newlines (one blank line)
    .replace(/[ \t]+/g, " ")          // Collapse multiple spaces (not newlines)
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
    "Write professional, human-sounding answers with specific details from the resume.",
    "Provide 1-2 paragraphs with concrete examples, achievements, and outcomes.",
    "Use plain punctuation only. Never use em dashes or asterisks.",
    "Avoid generic AI phrasing, disclaimers, or filler words.",
    "Personalize the response to the job description and company.",
  ].join(" ");

  const user = [
    "Resume:\n" + (resumeText || "(none provided)"),
    "\nJob description context:\n" + jobDescription,
    "\nPage context:\n" + (pageContext || "(none provided)"),
    "\nQuestion or prompt:\n" + question,
    "\nCurrent field value (if any):\n" + (fieldValue || "(empty)"),
    "\nWrite the best possible answer. (1-2 paragraphs).",
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
      instructions: system,
      input: user,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`OpenAI request failed: ${errorText}`);
  }

  const data = await response.json();
  
  let answer = null;
  
  // Primary: output_text convenience property (aggregates all text output)
  if (typeof data?.output_text === 'string' && data.output_text) {
    answer = data.output_text;
  }
  // Secondary: Parse output array manually
  // Format: output[].type === "message" -> content[].type === "output_text" -> text
  else if (Array.isArray(data?.output)) {
    const textParts = [];
    for (const item of data.output) {
      if (item?.type === 'message' && Array.isArray(item?.content)) {
        for (const content of item.content) {
          if (content?.type === 'output_text' && typeof content?.text === 'string') {
            textParts.push(content.text);
          }
        }
      }
    }
    if (textParts.length > 0) {
      answer = textParts.join('\n');
    }
  }
  
  if (!answer) {
    console.error('OpenAI API response:', JSON.stringify(data, null, 2));
    throw new Error(`Could not parse API response. Check browser console for details.`);
  }
  
  return answer.trim();
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
  // Combine system and user prompts for Gemini 3
  const fullPrompt = `${system}\n\n${user}\n\nWrite a detailed response with 2-4 paragraphs.`;
  
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
            parts: [{ text: fullPrompt }],
          },
        ],
        generationConfig: {
          maxOutputTokens: 1024,
          temperature: 0.7,
        },
      }),
    }
  );

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Gemini request failed: ${errorText}`);
  }

  const data = await response.json();
  
  // Extract text from response
  let answer = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  
  if (!answer) {
    console.error('Gemini response:', JSON.stringify(data, null, 2));
    throw new Error('Could not parse Gemini response');
  }
  
  // Clean up formatting - ensure proper paragraph separation
  answer = answer
    .replace(/\*\s*\*\s*\*/g, '\n\n')  // Replace *** with paragraph break
    .replace(/\n{3,}/g, '\n\n')         // Max 2 newlines
    .trim();
  
  return answer;
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
          ? "claude-sonnet-4-5"
          : activeProvider === "gemini"
            ? "gemini-3-pro-preview"
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
