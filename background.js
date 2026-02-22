const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";
const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
const GEMINI_ENDPOINT =
  "https://generativelanguage.googleapis.com/v1beta/models";

// Which context types to pull in for each platform.
// Users store Career, Social, and Always-active info separately —
// only the relevant ones are sent to the AI based on the current site.
const PLATFORM_CONTEXTS = {
  gmail:           ["work", "always"],
  linkedin:        ["work", "social", "always"],
  twitter:         ["social", "always"],
  facebook:        ["social", "always"],
  messenger:       ["social", "always"],
  reddit:          ["social", "always"],
  youtube:         ["social", "always"],
  instagram:       ["social", "always"],
  threads:         ["social", "always"],
  slack:           ["work", "always"],
  discord:         ["social", "always"],
  notion:          ["work", "always"],
  google_docs:     ["work", "always"],
  job_application: ["work", "always"],
  general:         ["work", "social", "always"],
};

const buildContextBlock = (platformKey, { workContext, socialContext, alwaysContext }) => {
  const keys = PLATFORM_CONTEXTS[platformKey] || PLATFORM_CONTEXTS.general;
  const parts = [];
  if (keys.includes("work") && workContext?.trim()) {
    parts.push(`=== Career & Work ===\n${workContext.trim()}`);
  }
  if (keys.includes("social") && socialContext?.trim()) {
    parts.push(`=== Social & Personal ===\n${socialContext.trim()}`);
  }
  if (keys.includes("always") && alwaysContext?.trim()) {
    parts.push(`=== General (always active) ===\n${alwaysContext.trim()}`);
  }
  return parts.join("\n\n") || null;
};

// Domain-aware writing profiles — automatically applied based on the site
const PLATFORM_PROFILES = {
  gmail: {
    name: "Gmail",
    instructions:
      "You are writing an email in Gmail. Be professional yet personable. Match the conversation thread tone. Keep emails clear and concise. Use appropriate greeting and sign-off when the context calls for it.",
  },
  linkedin: {
    name: "LinkedIn",
    instructions:
      "You are writing on LinkedIn. Be professional yet authentic and genuinely human. For messages: warm, direct, and get to the point. For posts: insightful, genuine, thought-provoking. For comments: thoughtful and additive. Never sound like a corporate account or a recruiter template.",
  },
  twitter: {
    name: "Twitter/X",
    instructions:
      "You are writing a tweet. Be punchy, genuine, and worth reading. 280 character limit — keep it tight. Say something worth saying. Authentic voice. No forced hashtags. No corporate fluff.",
    maxLength: 280,
  },
  facebook: {
    name: "Facebook",
    instructions:
      "You are writing on Facebook. Match the social, casual tone. Be genuine, warm, and personal.",
  },
  messenger: {
    name: "Messenger",
    instructions:
      "You are writing a chat message. Be casual and conversational. Match the thread tone naturally — like texting a friend. Keep it short unless the context calls for more.",
  },
  reddit: {
    name: "Reddit",
    instructions:
      "You are writing a Reddit post or comment. Match the subreddit community tone. Be genuine, informative, and add real value. Be direct — Reddit readers spot BS quickly.",
  },
  youtube: {
    name: "YouTube",
    instructions:
      "You are writing a YouTube comment. Be genuine and relevant to the video content. Add something worthwhile to the discussion.",
  },
  instagram: {
    name: "Instagram",
    instructions:
      "You are writing an Instagram comment or caption. Be engaging, authentic, and visually vivid. Keep it punchy.",
  },
  threads: {
    name: "Threads",
    instructions:
      "You are writing a Threads post or reply. Be casual, authentic, and conversational.",
  },
  slack: {
    name: "Slack",
    instructions:
      "You are writing a Slack message. Professional yet casual work communication. Be clear, concise, and actionable.",
  },
  discord: {
    name: "Discord",
    instructions:
      "You are writing a Discord message. Match the server and channel tone. Be genuine and community-appropriate.",
  },
  notion: {
    name: "Notion",
    instructions:
      "You are writing in Notion. Be clear, well-structured, and useful. Match the document context.",
  },
  google_docs: {
    name: "Google Docs",
    instructions:
      "You are writing in Google Docs. Be clear, professional, and appropriate for the document context.",
  },
  job_application: {
    name: "Job Application",
    instructions:
      "You are writing a job application response. Be professional and specific. Draw clear connections between experience and job requirements. Use concrete examples with measurable outcomes when possible. Sound genuinely human — avoid 'I am excited to', 'leveraged', 'spearheaded', 'passionate about'. Be confident without being arrogant. Start directly without any preamble.",
  },
  general: {
    name: "General",
    instructions:
      "You are a writing assistant. Adapt your tone to what the context calls for — professional for formal contexts, conversational for casual ones, concise for quick replies, detailed for complex questions.",
  },
};

// What each action mode means
const ACTION_INSTRUCTIONS = {
  generate:
    "Write the best possible response for this context. Match the length and tone to what the situation calls for.",
  rewrite:
    "Rewrite and improve the existing content. Keep the same core meaning and intent, but make it more polished, natural, and effective.",
  shorten:
    "Rewrite the existing content to be significantly more concise. Cut everything unnecessary while preserving all key points.",
  expand:
    "Expand the existing content with more detail, context, examples, and depth. Keep it coherent and on-point.",
};

const normalizeAnswer = (text) => {
  return text
    .replace(/[—–]/g, ",")
    .replace(/\*\s*\*\s*\*/g, "\n\n")
    .replace(/\s*,\s*/g, ", ")
    .replace(/\s+\./g, ".")
    .replace(/\s+\!/g, "!")
    .replace(/\s+\?/g, "?")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+/g, " ")
    .trim();
};

// Single unified prompt builder — adapts to any platform/action
const buildPrompt = ({
  systemPrompt,
  generalContext,
  pageContext,
  question,
  fieldValue,
  platformKey,
  action,
  instruction,
  capturedContexts,
}) => {
  const profile =
    PLATFORM_PROFILES[platformKey] || PLATFORM_PROFILES.general;
  const taskInstruction =
    ACTION_INSTRUCTIONS[action] || ACTION_INSTRUCTIONS.generate;

  const system = systemPrompt?.trim()
    ? systemPrompt.trim()
    : [
        "You are a precise, helpful writing assistant.",
        profile.instructions,
        "Write clear, natural responses that sound authentically human — never AI-generated.",
        "Be specific and use details from the provided context.",
        "Match the expected length to the context: short for chats/comments, longer for emails/posts/applications.",
        "Use plain punctuation only — no em dashes, asterisks, or bullet points unless the field clearly expects them.",
        "Avoid: generic AI openers ('Certainly!', 'Sure!', 'I'd be happy to', 'I hope this finds you well'), disclaimers, filler, excessive politeness.",
        "Start directly. No preamble.",
        "Use active voice. Be confident, specific, and genuine.",
        "When personal context is provided, use it naturally without explicitly referencing it ('based on my background' → just use the background).",
      ].join(" ");

  const userParts = [];

  if (generalContext?.trim()) {
    userParts.push(`=== Your Background ===\n${generalContext.trim()}`);
  }

  if (Array.isArray(capturedContexts) && capturedContexts.length > 0) {
    capturedContexts.forEach((ctx) => {
      if (ctx?.text) {
        const label = ctx.title || ctx.hostname || ctx.url || "another page";
        userParts.push(`=== Context from: ${label} ===\n${ctx.text.trim()}`);
      }
    });
  }

  if (pageContext?.trim()) {
    userParts.push(`=== Current Page Context ===\n${pageContext.trim()}`);
  }

  if (question?.trim()) {
    userParts.push(`=== Field / Question ===\n${question.trim()}`);
  }

  if (fieldValue?.trim()) {
    userParts.push(`=== Existing Content ===\n${fieldValue.trim()}`);
  }

  if (instruction?.trim()) {
    userParts.push(`=== Additional Instruction ===\n${instruction.trim()}`);
  }

  userParts.push(`=== Task ===\n${taskInstruction}`);

  return {
    system,
    user: userParts.join("\n\n"),
  };
};

const sanitizeError = (errorText) => {
  const firstLine = errorText.split("\n")[0];
  return firstLine
    .replace(/sk-[a-zA-Z0-9]+/g, "sk-***")
    .substring(0, 200);
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
      throw new Error(
        `OpenAI request failed: ${sanitizeError(errorText)}`
      );
    }

    const data = await response.json();

    let answer = null;

    if (typeof data?.output_text === "string" && data.output_text) {
      answer = data.output_text;
    } else if (Array.isArray(data?.output)) {
      const textParts = [];
      for (const item of data.output) {
        if (item?.type === "message" && Array.isArray(item?.content)) {
          for (const content of item.content) {
            if (
              content?.type === "output_text" &&
              typeof content?.text === "string"
            ) {
              textParts.push(content.text);
            }
          }
        }
      }
      if (textParts.length > 0) {
        answer = textParts.join("\n");
      }
    }

    if (!answer) {
      console.error(
        "OpenAI API response:",
        JSON.stringify(data, null, 2)
      );
      throw new Error(
        "Could not parse API response. Check browser console for details."
      );
    }

    return answer.trim();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      throw new Error("Request timed out after 30 seconds");
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
      throw new Error(
        `Anthropic request failed: ${sanitizeError(errorText)}`
      );
    }

    const data = await response.json();
    const content = data?.content?.[0]?.text;
    return content?.trim();
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      throw new Error("Request timed out after 30 seconds");
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
      throw new Error(
        `Gemini request failed: ${sanitizeError(errorText)}`
      );
    }

    const data = await response.json();

    const finishReason = data?.candidates?.[0]?.finishReason;
    if (finishReason && finishReason !== "STOP") {
      console.warn(
        "[TextFill] Gemini response may be incomplete. Finish reason:",
        finishReason
      );
    }

    let answer = null;
    const parts = data?.candidates?.[0]?.content?.parts;
    if (parts && Array.isArray(parts)) {
      answer = parts.map((p) => p.text || "").join("");
    }

    if (!answer) {
      answer = data?.text;
    }

    if (!answer) {
      console.error(
        "[TextFill] Gemini response parsing failed:",
        JSON.stringify(data, null, 2)
      );
      throw new Error("Could not parse Gemini response");
    }

    answer = answer
      .replace(/\*\s*\*\s*\*/g, "\n\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();

    return answer;
  } catch (err) {
    clearTimeout(timeout);
    if (err.name === "AbortError") {
      throw new Error("Request timed out after 30 seconds");
    }
    throw err;
  }
};

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "openSettings") {
    chrome.runtime.openOptionsPage();
    return false;
  }

  if (message?.type !== "generateAnswer") {
    return false;
  }

  (async () => {
    try {
      const {
        provider,
        model,
        systemPrompt,
        // New structured context keys
        workContextText,
        socialContextText,
        alwaysContextText,
        // Legacy key — kept for backward compatibility
        generalContextText,
        openaiKey,
        anthropicKey,
        geminiKey,
      } = await chrome.storage.local.get([
        "provider",
        "model",
        "systemPrompt",
        "workContextText",
        "socialContextText",
        "alwaysContextText",
        "generalContextText",
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

      const platformKey = message.platformKey || "general";

      // Build a context block containing only the sections relevant to this platform.
      // Falls back to legacy generalContextText as the work context for existing users.
      const structuredContext = buildContextBlock(platformKey, {
        workContext: workContextText || generalContextText || "",
        socialContext: socialContextText || "",
        alwaysContext: alwaysContextText || "",
      });

      const promptPayload = buildPrompt({
        systemPrompt,
        generalContext: structuredContext,
        pageContext: message.pageContext,
        question: message.question,
        fieldValue: message.fieldValue,
        platformKey,
        action: message.action || "generate",
        instruction: message.instruction || "",
        capturedContexts: message.capturedContexts || null,
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
