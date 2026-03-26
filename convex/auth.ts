import { convexAuth } from "@convex-dev/auth/server";
import { Password } from "@convex-dev/auth/providers/Password";
import { Email } from "@convex-dev/auth/providers/Email";
import { Resend } from "resend";
import { internal } from "./_generated/api";

// OTP via Resend email — sends a 6-digit code the user pastes back in the popup
const ResendOTP = Email({
  id: "resend-otp",
  apiKey: process.env.AUTH_RESEND_KEY,
  async sendVerificationRequest({ identifier: email, token }) {
    const resend = new Resend(process.env.AUTH_RESEND_KEY);
    const { error } = await resend.emails.send({
      from: "CheatResume <noreply@resend.dev>",
      to: [email],
      subject: "Your CheatResume sign-in code",
      html: `
        <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 24px;">
          <h2 style="color: #1a1a1a;">Sign in to CheatResume</h2>
          <p style="color: #555;">Your one-time sign-in code:</p>
          <div style="font-size: 36px; font-weight: bold; letter-spacing: 8px; color: #4f46e5; padding: 16px 0;">
            ${token}
          </div>
          <p style="color: #999; font-size: 13px;">Expires in 1 hour. If you didn't request this, ignore this email.</p>
        </div>
      `,
    });
    if (error) throw new Error(`Failed to send OTP: ${error.message}`);
  },
});

export const { auth, signIn, signOut, store, isAuthenticated } = convexAuth({
  providers: [
    Password,   // Email + password with built-in reset flow
    ResendOTP,  // 6-digit OTP via email — best UX in a Chrome extension popup
  ],
  callbacks: {
    async afterUserCreatedOrUpdated(ctx, { userId }) {
      // Auto-provision a profile row on first sign-up
      await ctx.runMutation(internal.users.ensureProfile, { userId });
    },
  },
});
