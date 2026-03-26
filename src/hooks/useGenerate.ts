import { useState, useRef } from "react";

interface GenerateParams {
  instruction: string;
  pageContext?: string;
  capturedContext?: string;
  platform?: string;
}

type GenerateAction = "generate" | "rewrite" | "shorten" | "expand";

// Calls the background service worker which routes to Convex
export function useGenerate() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const threadIdRef = useRef<string | undefined>(undefined);

  async function call(action: GenerateAction, params: GenerateParams & { existingText?: string }) {
    setLoading(true);
    setError(null);
    try {
      const response = await chrome.runtime.sendMessage({
        type: "GENERATE",
        action,
        payload: { ...params, threadId: threadIdRef.current },
      });
      if (response?.error) throw new Error(response.error);
      if (response?.threadId) threadIdRef.current = response.threadId;
      return response?.text as string;
    } catch (err: any) {
      setError(err.message ?? "Generation failed");
      return null;
    } finally {
      setLoading(false);
    }
  }

  return {
    loading,
    error,
    generate: (p: GenerateParams) => call("generate", p),
    rewrite: (existingText: string, p: Omit<GenerateParams, "instruction"> & { instruction?: string }) =>
      call("rewrite", { instruction: "", ...p, existingText }),
    shorten: (existingText: string, p?: Partial<GenerateParams>) =>
      call("shorten", { instruction: "", ...p, existingText }),
    expand: (existingText: string, p?: Partial<GenerateParams>) =>
      call("expand", { instruction: "", ...p, existingText }),
  };
}
