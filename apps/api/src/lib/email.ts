import { createTransport } from "nodemailer";
import { env } from "../config/env";

interface EmailMessage {
  to: string;
  subject: string;
  html: string;
}

interface EmailService {
  send(msg: EmailMessage): Promise<boolean>;
}

function parseFrom(from: string): { name: string; email: string } {
  const match = from.match(/^(.+)<(.+)>$/);
  if (match) return { name: match[1]!.trim(), email: match[2]!.trim() };
  return { name: "", email: from.trim() };
}

function createBrevoService(apiKey: string): EmailService {
  return {
    async send(msg) {
      const sender = parseFrom(env.EMAIL_FROM);
      try {
        const res = await fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          headers: {
            "api-key": apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            sender: { name: sender.name || "Cubelelo Events", email: sender.email },
            to: [{ email: msg.to }],
            subject: msg.subject,
            htmlContent: msg.html,
          }),
        });
        if (!res.ok) {
          const body = await res.text();
          console.error(`[EMAIL] Brevo send failed (${res.status}): ${body}`);
          return false;
        }
        return true;
      } catch (err) {
        console.error("[EMAIL] Brevo send failed:", err);
        return false;
      }
    },
  };
}

function createSmtpService(): EmailService {
  const transporter = createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_PORT === 465,
    auth: { user: env.SMTP_USER, pass: env.SMTP_PASS },
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
  });
  return {
    async send(msg) {
      try {
        await transporter.sendMail({
          from: env.EMAIL_FROM,
          to: msg.to,
          subject: msg.subject,
          html: msg.html,
        });
        return true;
      } catch (err) {
        console.error("[EMAIL] SMTP send failed:", err);
        return false;
      }
    },
  };
}

function createConsoleService(): EmailService {
  return {
    async send(msg) {
      console.log(`[EMAIL] To: ${msg.to} | Subject: ${msg.subject}`);
      return true;
    },
  };
}

function pickService(): EmailService {
  if (env.BREVO_API_KEY) {
    console.log("[EMAIL] Service: Brevo (HTTP API)");
    return createBrevoService(env.BREVO_API_KEY);
  }
  if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) {
    console.log(`[EMAIL] Service: SMTP (${env.SMTP_HOST}:${env.SMTP_PORT})`);
    return createSmtpService();
  }
  console.log("[EMAIL] Service: Console (no email configured)");
  return createConsoleService();
}

export const emailService: EmailService = pickService();

export function emailServiceName(): string {
  if (env.BREVO_API_KEY) return "brevo";
  if (env.SMTP_HOST && env.SMTP_USER && env.SMTP_PASS) return "smtp";
  return "console";
}

const BATCH_SIZE = 10;

export async function sendBulk(
  messages: EmailMessage[],
): Promise<number> {
  let sentCount = 0;
  for (let i = 0; i < messages.length; i += BATCH_SIZE) {
    const batch = messages.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map((m) => emailService.send(m)));
    sentCount += results.filter((r) => r.status === "fulfilled" && r.value).length;
  }
  return sentCount;
}

export function verificationEmail(name: string, token: string): { subject: string; html: string } {
  const link = `${env.APP_URL}/verify-email?token=${token}`;
  return {
    subject: "Verify your Cubelelo Events email",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2>Welcome, ${name}!</h2>
        <p>Please verify your email address to complete your registration.</p>
        <a href="${link}" style="display:inline-block;background:#059669;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Verify Email</a>
        <p style="margin-top:24px;font-size:12px;color:#71717a">If you didn't create an account, you can ignore this email.</p>
        <p style="font-size:12px;color:#71717a">Or copy this link: ${link}</p>
      </div>
    `,
  };
}

export function otpEmail(name: string, otp: string): { subject: string; html: string } {
  return {
    subject: `${otp} — Cubelelo Events verification code`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2>Hi ${name},</h2>
        <p>Your verification code is:</p>
        <div style="font-size:32px;font-weight:700;letter-spacing:6px;text-align:center;margin:24px 0;color:#059669">${otp}</div>
        <p style="font-size:14px;color:#71717a">This code expires in 10 minutes.</p>
        <p style="margin-top:24px;font-size:12px;color:#71717a">If you didn't request this, you can ignore this email.</p>
      </div>
    `,
  };
}

export function passwordResetEmail(name: string, token: string): { subject: string; html: string } {
  const link = `${env.APP_URL}/reset-password?token=${token}`;
  return {
    subject: "Reset your Cubelelo Events password",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2>Hi ${name},</h2>
        <p>You requested a password reset. Click below to set a new password. This link expires in 1 hour.</p>
        <a href="${link}" style="display:inline-block;background:#059669;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Reset Password</a>
        <p style="margin-top:24px;font-size:12px;color:#71717a">If you didn't request this, you can ignore this email.</p>
        <p style="font-size:12px;color:#71717a">Or copy this link: ${link}</p>
      </div>
    `,
  };
}

/**
 * Reminder that a round's results will publish themselves shortly.
 *
 * Rounds open on the clock whether or not anyone published, and a round with no
 * shortlist admits nobody — so results publish automatically before the next
 * round starts. This gives the organiser and the round's judges a stated
 * deadline to finish verification, rather than discovering it after the fact.
 */
export function publishReminderEmail(
  name: string,
  competitionTitle: string,
  roundNumber: number,
  autoPublishAt: Date,
): { subject: string; html: string } {
  const time = autoPublishAt.toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  const day = autoPublishAt.toLocaleDateString("en-US", {
    weekday: "short",
    day: "numeric",
    month: "short",
  });

  return {
    subject: `Verify Round ${roundNumber} before ${time} — ${competitionTitle}`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2>Hi ${name},</h2>
        <p>
          Round ${roundNumber} of <strong>${competitionTitle}</strong> has not been
          published yet.
        </p>
        <p>
          Results will publish automatically at <strong>${time}</strong> on ${day},
          before the next round opens. Whatever is verified by then is what gets
          published, and the shortlist for the next round is computed from it —
          results still flagged at that point will not advance.
        </p>
        <p>Publish it yourself from the Verification Hub any time before then.</p>
      </div>
    `,
  };
}

export function roundNotificationEmail(
  name: string,
  competitionTitle: string,
  roundNumber: number,
  action: "opened" | "closing_soon" | "results_published",
): { subject: string; html: string } {
  type Action = typeof action;
  const subjects: Record<Action, string> = {
    opened: `Round ${roundNumber} is now open — ${competitionTitle}`,
    closing_soon: `Round ${roundNumber} closes in 30 min — ${competitionTitle}`,
    results_published: `Results are in — ${competitionTitle} Round ${roundNumber}`,
  };
  const bodies: Record<Action, string> = {
    opened: `<p>Round ${roundNumber} of <strong>${competitionTitle}</strong> is now open! Head over to submit your solves.</p>`,
    closing_soon: `<p>Round ${roundNumber} of <strong>${competitionTitle}</strong> closes in 30 minutes. Don't miss your chance to submit!</p>`,
    results_published: `<p>Results for Round ${roundNumber} of <strong>${competitionTitle}</strong> have been published. Check your ranking!</p>`,
  };
  return {
    subject: subjects[action],
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2>Hi ${name},</h2>
        ${bodies[action]}
        <a href="${env.APP_URL}/competitions" style="display:inline-block;background:#059669;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Go to Competition</a>
        <p style="margin-top:24px;font-size:12px;color:#71717a">You received this because you are registered for ${competitionTitle}.</p>
      </div>
    `,
  };
}

export function migrationEmail(name: string, clId: string): { subject: string; html: string } {
  const link = `${env.APP_URL}/register?migrate=true`;
  return {
    subject: "Your Cubelelo Events account is ready to claim",
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2>Hi ${name},</h2>
        <p>Your competition history from the old Cubelelo Events platform has been migrated. Your CL ID is <strong>${clId}</strong>.</p>
        <p>Claim your account to keep your history, personal bests, and rankings.</p>
        <a href="${link}" style="display:inline-block;background:#059669;color:#fff;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:600">Claim My Account</a>
        <p style="margin-top:24px;font-size:12px;color:#71717a">If you don't recognize this, you can ignore this email.</p>
      </div>
    `,
  };
}

export function staffWelcomeEmail(name: string, role: string): { subject: string; html: string } {
  return {
    subject: `You've been added as ${role} on Cubelelo Events`,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2>Welcome, ${name}!</h2>
        <p>You have been added as a <strong>${role}</strong> on Cubelelo Events.</p>
        <p>Please visit <a href="${env.APP_URL}/login">${env.APP_URL}/login</a> to set up your account and get started.</p>
        <p style="margin-top:24px;font-size:12px;color:#71717a">— Cubelelo Events</p>
      </div>
    `,
  };
}

export function bulkEmail(
  name: string,
  subject: string,
  bodyHtml: string,
): { subject: string; html: string } {
  return {
    subject,
    html: `
      <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:24px">
        <h2>Hi ${name},</h2>
        ${bodyHtml}
        <p style="margin-top:24px;font-size:12px;color:#71717a">You received this from Cubelelo Events.</p>
      </div>
    `,
  };
}
