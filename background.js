const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";

const normalizeAnswer = (text) => {
  return text
    .replace(/[—–]/g, ",")
    .replace(/\s+,/g, ",")
    .replace(/\s{2,}/g, " ")
    .trim();
};

const buildPrompt = ({ resumeText, jobDescription, question, fieldValue }) => {
  const system = [
    "You are a writing assistant for job applications.",
    "Write concise, professional, human-sounding answers with specific details.",
    "Use plain punctuation only. Never use em dashes.",
    "Avoid generic AI phrasing and filler.",
    "Keep the response focused and personalized to the job description and resume.",
  ].join(" ");

  const user = [
    "Resume:\n" + (resumeText || "(none provided)"),
    "\nJob description context:\n" + jobDescription,
    "\nQuestion or prompt:\n" + question,
    "\nCurrent field value (if any):\n" + (fieldValue || "(empty)"),
    "\nWrite the best possible answer.",
  ].join("\n\n");

  return { system, user };
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== "generateAnswer") {
    return false;
  }

  (async () => {
    try {
      const { apiKey, resumeText } = await chrome.storage.local.get([
        "apiKey",
        "resumeText",
      ]);

      if (!apiKey) {
        sendResponse({
          ok: false,
          error: "Missing API key. Add it in the extension options.",
        });
        return;
      }

      const { system, user } = buildPrompt({
        resumeText,
        jobDescription: message.jobDescription,
        question: message.question,
        fieldValue: message.fieldValue,
      });

      const response = await fetch(OPENAI_ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-5-nano",
          temperature: 0.6,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        sendResponse({
          ok: false,
          error: `OpenAI request failed: ${errorText}`,
        });
        return;
      }

      const data = await response.json();
      const answer = data?.choices?.[0]?.message?.content?.trim();

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
