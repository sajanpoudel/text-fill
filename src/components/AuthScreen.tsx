import { useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { cn } from "../lib/utils";

type Flow = "signIn" | "signUp" | "forgotPassword" | "otp";
type Step = "email" | "code";

export function AuthScreen() {
  const { signIn } = useAuthActions();
  const [flow, setFlow] = useState<Flow>("signIn");
  const [step, setStep] = useState<Step>("email");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handlePasswordSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await signIn("password", { email, password, flow });
    } catch (err: any) {
      setError(err.message ?? "Authentication failed");
    } finally {
      setLoading(false);
    }
  }

  async function handleOtpEmailSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await signIn("resend-otp", { email });
      setStep("code");
    } catch (err: any) {
      setError(err.message ?? "Failed to send code");
    } finally {
      setLoading(false);
    }
  }

  async function handleOtpCodeSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await signIn("resend-otp", { email, code });
    } catch (err: any) {
      setError(err.message ?? "Invalid code");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col h-full min-h-[520px] bg-white p-8 font-sans tracking-tight">
      {/* Logo / header */}
      <div className="mb-10 text-center">
        <h1 className="text-3xl font-bold text-black tracking-tighter">CheatResume</h1>
        <p className="text-sm text-text-muted mt-2 font-medium tracking-wide">AI WRITING ASSISTANT</p>
      </div>

      {/* Tab switcher */}
      <div className="flex border border-neutral-300 rounded-md mb-8 overflow-hidden bg-white shadow-sm p-1 gap-1">
        {(["signIn", "signUp", "otp"] as const).map((f) => (
          <button
            key={f}
            onClick={() => { setFlow(f); setStep("email"); setError(null); }}
            className={cn(
              "flex-1 py-2 text-sm font-semibold transition-all rounded-sm",
              flow === f
                ? "bg-black text-white shadow"
                : "text-text-muted hover:text-black hover:bg-neutral-100"
            )}
          >
            {f === "signIn" ? "Sign In" : f === "signUp" ? "Sign Up" : "Magic Code"}
          </button>
        ))}
      </div>

      {/* OTP flow */}
      {flow === "otp" && (
        <form
          onSubmit={step === "email" ? handleOtpEmailSubmit : handleOtpCodeSubmit}
          className="flex flex-col gap-4"
        >
          {step === "email" ? (
            <>
              <p className="text-sm text-neutral-600 font-medium">
                We'll email you a 6-digit code to sign in.
              </p>
              <input
                type="email"
                placeholder="Email address"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="input"
              />
              <button type="submit" disabled={loading} className="btn-primary mt-2">
                {loading ? "Sending…" : "Send Code"}
              </button>
            </>
          ) : (
            <>
              <p className="text-sm text-neutral-600 font-medium">
                Enter the 6-digit code sent to <strong className="text-black">{email}</strong>
              </p>
              <input
                type="text"
                inputMode="numeric"
                pattern="\d{6}"
                maxLength={6}
                placeholder="000000"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                required
                className="input text-center tracking-[0.5em] text-xl font-bold"
                autoFocus
              />
              <button type="submit" disabled={loading} className="btn-primary mt-2">
                {loading ? "Verifying…" : "Verify Code"}
              </button>
              <button
                type="button"
                onClick={() => setStep("email")}
                className="text-sm text-text-muted hover:text-black font-medium mt-2"
              >
                ← Back to email
              </button>
            </>
          )}
        </form>
      )}

      {/* Password flow (signIn / signUp) */}
      {flow !== "otp" && (
        <form onSubmit={handlePasswordSubmit} className="flex flex-col gap-4">
          <input
            type="email"
            placeholder="Email address"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className="input"
          />
          <input
            type="password"
            placeholder="Password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            minLength={8}
            className="input"
          />
          <button type="submit" disabled={loading} className="btn-primary mt-2">
            {loading
              ? flow === "signIn"
                ? "Signing in…"
                : "Creating account…"
              : flow === "signIn"
              ? "Sign In"
              : "Create Account"}
          </button>
        </form>
      )}

      {error && (
        <div className="mt-4 p-3 bg-neutral-50 border border-neutral-200 rounded-md">
          <p className="text-sm text-black font-medium text-center">{error}</p>
        </div>
      )}
    </div>
  );
}
