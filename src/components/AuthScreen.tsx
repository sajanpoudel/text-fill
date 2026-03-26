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
    <div className="flex flex-col h-full min-h-[480px] bg-white p-6">
      {/* Logo / header */}
      <div className="mb-6 text-center">
        <div className="text-2xl font-bold text-gray-900">CheatResume</div>
        <div className="text-sm text-gray-500 mt-1">AI Writing Assistant</div>
      </div>

      {/* Tab switcher */}
      <div className="flex border border-gray-200 rounded-lg mb-6 overflow-hidden">
        {(["signIn", "signUp", "otp"] as const).map((f) => (
          <button
            key={f}
            onClick={() => { setFlow(f); setStep("email"); setError(null); }}
            className={cn(
              "flex-1 py-2 text-sm font-medium transition-colors",
              flow === f
                ? "bg-gray-900 text-white"
                : "text-gray-600 hover:bg-gray-50"
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
          className="flex flex-col gap-3"
        >
          {step === "email" ? (
            <>
              <p className="text-sm text-gray-600">
                We'll email you a 6-digit code to sign in.
              </p>
              <input
                type="email"
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="input"
              />
              <button type="submit" disabled={loading} className="btn-primary">
                {loading ? "Sending…" : "Send Code"}
              </button>
            </>
          ) : (
            <>
              <p className="text-sm text-gray-600">
                Enter the 6-digit code sent to <strong>{email}</strong>
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
                className="input text-center tracking-widest text-lg"
                autoFocus
              />
              <button type="submit" disabled={loading} className="btn-primary">
                {loading ? "Verifying…" : "Verify Code"}
              </button>
              <button
                type="button"
                onClick={() => setStep("email")}
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                ← Back
              </button>
            </>
          )}
        </form>
      )}

      {/* Password flow (signIn / signUp) */}
      {flow !== "otp" && (
        <form onSubmit={handlePasswordSubmit} className="flex flex-col gap-3">
          <input
            type="email"
            placeholder="Email"
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
          <button type="submit" disabled={loading} className="btn-primary">
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
        <p className="mt-3 text-sm text-red-600 text-center">{error}</p>
      )}
    </div>
  );
}
