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
    "You are a professional writing assistant for job applications.",
    "Write compelling, authentic responses that showcase the candidate's qualifications using specific details from their resume.",
    "Draw connections between the resume and job requirements—show how past experience directly relates to what they're looking for.",
    "Use concrete examples with measurable outcomes when possible (percentages, numbers, scale, impact).",
    "Write 1-2 paragraphs unless the field clearly needs more or less. Match the expected length to the question.",
    "Sound genuinely human—avoid generic AI phrases ('I am excited to', 'I would love to', 'I believe I would be', 'leveraged', 'spearheaded').",
    "Use plain punctuation only. No em dashes, asterisks, or bullet points unless the field format clearly expects them.",
    "Be confident but not arrogant. Be specific, not vague. Be genuine, not obsequious.",
    "Tailor the tone to the company culture evident in the job description: startup-casual, corporate-professional, or creative-dynamic.",
    "If the resume lacks direct experience, emphasize transferable skills and relevant accomplishments instead.",
    "Start directly answering the question—skip unnecessary preambles like 'In my previous role' unless it adds value.",
    "For 'why this company' questions: reference specific aspects of the job description, company mission, or role responsibilities.",
    "For 'why you' questions: focus on relevant achievements and skills that match their needs.",
    "Never make up experiences not in the resume. Work with what's provided.",
  ].join(" ");

  const user = [
    "Resume:\n" + (resumeText || "(none provided)"),
    "\nJob description context:\n" + jobDescription,
    "\nPage context:\n" + (pageContext || "(none provided)"),
    "\nQuestion or prompt:\n" + question,
    "\nCurrent field value (if any):\n" + (fieldValue || "(empty)"),
    "\nWrite the best possible answer that connects the resume to this job opportunity.",
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
        "You are a professional writing assistant helping with emails, messages, comments, and form responses.",
        "Adapt your tone based on context: professional for emails and LinkedIn, conversational for messages and social media, formal for official forms.",
        "Write clear, natural responses that sound authentically human—not AI-generated.",
        "Be specific and relevant. Use details from the context provided.",
        "Keep responses concise (1-3 paragraphs max unless the field clearly requires more).",
        "Use plain punctuation only—no em dashes, asterisks, or special formatting.",
        "Avoid: generic AI phrases ('I'd be happy to', 'I hope this email finds you well', 'Please feel free'), disclaimers, filler words, excessive politeness.",
        "Match the communication style to the platform: direct and professional for Gmail/LinkedIn, warm and conversational for Facebook/casual messages.",
        "If given personal context, incorporate it naturally without explicitly referencing it ('based on my background' → just use the background).",
        "Start responses directly—skip greetings unless the field explicitly requests them.",
        "For questions: answer directly and completely. For prompts: fulfill the request precisely.",
        "Use active voice. Be confident but not arrogant. Be helpful but not obsequious.",
      ].join(" ");

  const user = [
    "General context:\n" + (generalContext || "(none provided)"),
    "\nPage context:\n" + (pageContext || "(none provided)"),
    "\nQuestion or prompt:\n" + question,
    "\nCurrent field value (if any):\n" + (fieldValue || "(empty)"),
    "\nWrite the best possible response. Match the tone and length to the context.",
  ].join("\n\n");

  return { system, user };
};

const sanitizeError = (errorText) => {
  const firstLine = errorText.split('\n')[0];
  return firstLine.replace(/sk-[a-zA-Z0-9]+/g, 'sk-***').substring(0, 200);
};

const requestOpenAI = async ({ apiKey, model, system, user }) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(OPENAI_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
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

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`OpenAI request failed: ${sanitizeError(errorText)}`);
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
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error('Request timed out after 30 seconds');
    }
    throw err;
  }
};

const requestAnthropic = async ({ apiKey, model, system, user }) => {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(ANTHROPIC_ENDPOINT, {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model,
        temperature: 0.5,
        max_tokens: 1024,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Anthropic request failed: ${sanitizeError(errorText)}`);
    }

    const data = await response.json();
    const content = data?.content?.[0]?.text;
    return content?.trim();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error('Request timed out after 30 seconds');
    }
    throw err;
  }
};

const requestGemini = async ({ apiKey, model, system, user }) => {
  const fullPrompt = `${system}\n\n${user}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(
      `${GEMINI_ENDPOINT}/${model}:generateContent?key=${apiKey}`,
      {
        method: "POST",
        signal: controller.signal,
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
            maxOutputTokens: 2048,
            temperature: 0.7,
          },
        }),
      }
    );

    clearTimeout(timeout);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gemini request failed: ${sanitizeError(errorText)}`);
    }

    const data = await response.json();

    const finishReason = data?.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== 'STOP') {
      console.warn('[TextFill] Gemini response may be incomplete. Finish reason:', finishReason);
    }

    let answer = null;

    const parts = data?.candidates?.[0]?.content?.parts;
    if (parts && Array.isArray(parts)) {
      answer = parts.map(p => p.text || '').join('');
    }

    if (!answer) {
      answer = data?.text;
    }

    if (!answer) {
      console.error('[TextFill] Gemini response parsing failed:', JSON.stringify(data, null, 2));
      throw new Error('Could not parse Gemini response');
    }

    answer = answer
      .replace(/\*\s*\*\s*\*/g, '\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();

    return answer;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error('Request timed out after 30 seconds');
    }
    throw err;
  }
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
      const activeMode = mode || "general";

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
