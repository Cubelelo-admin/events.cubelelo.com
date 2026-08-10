import { randomUUID, randomInt, createHash, timingSafeEqual } from "node:crypto";
import { SignJWT } from "jose";
import bcrypt from "bcryptjs";
import type { FastifyInstance } from "fastify";
import type { Repository } from "../../db/repo";
import { type User, sanitizeUser } from "../../db/types";
import { env } from "../../config/env";
import { requireAuth } from "../../auth/plugin";
import type { Verifier } from "../../auth/verifier";
import { emailService, verificationEmail, passwordResetEmail, otpEmail } from "../../lib/email";
import { smsService } from "../../lib/sms";
import { authLimiter, loginLimiter, passwordResetLimiter } from "../../lib/rateLimiter";
import { blockToken } from "../../lib/tokenBlocklist";
import { transferUserData } from "../../lib/accountTransfer";
import type { Realtime } from "../../sockets/realtime";

function generateOtp(): string {
  return String(randomInt(100000, 999999));
}

function isEmail(input: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeMobile(input: string): string {
  let cleaned = input.replace(/[\s\-()]/g, "");
  if (!cleaned.startsWith("+")) {
    cleaned = "+91" + cleaned;
  }
  return cleaned;
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  repo: Repository,
  verifier: Verifier,
  realtime: Realtime,
): Promise<void> {
  // First-login sync: create the user row + assign a CL ID if needed.
  app.post(
    "/api/v1/auth/sync",
    { preHandler: requireAuth },
    async (req, reply): Promise<User> => {
      const claims = req.authClaims!;

      // Auth hook already resolves supabaseId → internal id for linked users.
      let user = await repo.users.findById(claims.sub);

      // First Google sign-in for an existing email+password account — link it.
      if (!user && claims.email) {
        user = await repo.users.findByEmail(claims.email);
        if (user) {
          await repo.users.migrateId(user.id, claims.sub);
          user = { ...user, supabaseId: claims.sub };
        }
      }

      if (!user) {
        const email = claims.email?.trim().toLowerCase() || "";
        const mobileNo = claims.phone;

        if (!email && !mobileNo) {
          return reply.code(400).send({ error: "email_or_mobile_required" }) as unknown as User;
        }

        if (email) {
          const existing = await repo.users.findByEmail(email);
          if (existing) {
            return reply.code(409).send({ error: "email_already_registered" }) as unknown as User;
          }
        }
        if (mobileNo) {
          const existing = await repo.users.findByMobileNo(mobileNo);
          if (existing) {
            return reply.code(409).send({ error: "mobile_already_registered" }) as unknown as User;
          }
        }

        user = {
          id: claims.sub,
          clId: await repo.users.nextClId(),
          email: email || "",
          name: claims.name ?? email?.split("@")[0] ?? "Cuber",
          mobileNo,
          role: "user",
          wcaVerified: false,
          emailVerified: !!email,
          mobileVerified: !!mobileNo,
          profilePrivacy: "public",
          accountStage: "active",
          createdAt: new Date().toISOString(),
        } satisfies User;
        await repo.users.create(user);
      }
      return sanitizeUser(user!);
    },
  );

  app.get("/api/v1/users/me", { preHandler: requireAuth }, async (req, reply) => {
    const user = await repo.users.findById(req.authClaims!.sub);
    if (!user) return reply.code(404).send({ error: "not_synced" });
    return sanitizeUser(user);
  });

  app.post("/api/v1/auth/sign-out", { preHandler: requireAuth }, async (req) => {
    const claims = req.authClaims!;
    if (claims.jti && claims.exp) {
      await blockToken(claims.jti, claims.exp);
    } else if (claims.jti) {
      await blockToken(claims.jti, Math.ceil(Date.now() / 1000) + 7 * 24 * 3600);
    }
    realtime.disconnectUser(claims.sub);
    return { ok: true };
  });

  // Email/mobile + password registration
  app.post<{ Body: { identifier?: string; password?: string; name?: string } }>(
    "/api/v1/auth/register",
    { preHandler: authLimiter },
    async (req, reply) => {
      const identifier = req.body?.identifier?.trim().toLowerCase();
      const password = req.body?.password;
      const name = req.body?.name?.trim();
      if (!identifier || !password) {
        return reply.code(400).send({ error: "identifier_and_password_required" });
      }
      if (password.length < 6) {
        return reply.code(400).send({ error: "password_too_short" });
      }

      const usingEmail = isEmail(identifier);
      let email: string | undefined;
      let mobileNo: string | undefined;

      if (usingEmail) {
        email = identifier;
        const existing = await repo.users.findByEmail(email);
        if (existing) {
          return reply.code(409).send({ error: "email_already_registered" });
        }
      } else {
        mobileNo = normalizeMobile(identifier);
        const existing = await repo.users.findByMobileNo(mobileNo);
        if (existing) {
          return reply.code(409).send({ error: "mobile_already_registered" });
        }
      }

      const id = randomUUID();
      const passwordHash = await bcrypt.hash(password, 10);
      const user: User = {
        id,
        clId: await repo.users.nextClId(),
        email: email ?? "",
        name: name || (usingEmail ? email!.split("@")[0] : mobileNo!) || "Cuber",
        mobileNo,
        passwordHash,
        role: "user",
        wcaVerified: false,
        emailVerified: false,
        mobileVerified: false,
        profilePrivacy: "public",
        accountStage: "active",
        createdAt: new Date().toISOString(),
      };
      await repo.users.create(user);

      // Send OTP to the identifier used for signup (best-effort — user can resend)
      const otp = generateOtp();
      const otpType = usingEmail ? "otp_email" : "otp_mobile";
      const otpIdentifier = usingEmail ? email! : mobileNo!;
      await repo.verificationTokens.create({
        id: randomUUID(), userId: id, type: otpType,
        token: otp, identifier: otpIdentifier,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
      try {
        if (usingEmail) {
          const oe = otpEmail(user.name, otp);
          await emailService.send({ to: email!, subject: oe.subject, html: oe.html });
        } else {
          await smsService.sendOtp(mobileNo!, otp);
        }
      } catch (err) {
        req.log.error({ err, identifier }, "OTP delivery failed during registration");
        // Don't block registration — user can resend via /send-otp
      }

      const secret = new TextEncoder().encode(env.DEV_AUTH_SECRET);
      const token = await new SignJWT({ email, name: user.name })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(id)
        .setJti(randomUUID())
        .setIssuedAt()
        .setExpirationTime("7d")
        .sign(secret);
      return { token, otpSentTo: usingEmail ? "email" : "mobile" };
    },
  );

  // Email/mobile + password login
  app.post<{ Body: { identifier?: string; password?: string } }>(
    "/api/v1/auth/login",
    { preHandler: loginLimiter },
    async (req, reply) => {
      const identifier = req.body?.identifier?.trim().toLowerCase();
      const password = req.body?.password;
      if (!identifier || !password) {
        return reply.code(400).send({ error: "identifier_and_password_required" });
      }

      const usingEmail = isEmail(identifier);
      let user: User | null;
      if (usingEmail) {
        user = await repo.users.findByEmail(identifier);
      } else {
        user = await repo.users.findByMobileNo(normalizeMobile(identifier));
      }

      if (!user || !user.passwordHash) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }
      const valid = await bcrypt.compare(password, user.passwordHash);
      if (!valid) {
        return reply.code(401).send({ error: "invalid_credentials" });
      }

      const secret = new TextEncoder().encode(env.DEV_AUTH_SECRET);
      const token = await new SignJWT({ email: user.email, name: user.name })
        .setProtectedHeader({ alg: "HS256" })
        .setSubject(user.id)
        .setJti(randomUUID())
        .setIssuedAt()
        .setExpirationTime("7d")
        .sign(secret);
      return { token };
    },
  );

  // ── OTP: Send ──
  app.post<{ Body: { type?: "email" | "mobile"; value?: string } }>(
    "/api/v1/auth/send-otp",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { type, value } = req.body ?? {};
      if (!type || !value?.trim()) {
        return reply.code(400).send({ error: "type_and_value_required" });
      }
      const user = await repo.users.findById(req.authClaims!.sub);
      if (!user) return reply.code(404).send({ error: "not_synced" });

      const otp = generateOtp();

      if (type === "email") {
        const email = value.trim().toLowerCase();
        // If user is adding/changing email, update it
        if (!user.email || user.email !== email) {
          const existing = await repo.users.findByEmail(email);
          if (existing && existing.id !== user.id) {
            return reply.code(409).send({ error: "email_already_registered" });
          }
          await repo.users.update(user.id, { email, emailVerified: false });
        }
        if (user.emailVerified && user.email === email) {
          return reply.code(409).send({ error: "already_verified" });
        }
        await repo.verificationTokens.create({
          id: randomUUID(), userId: user.id, type: "otp_email",
          token: otp, identifier: email,
          expiresAt: Date.now() + 10 * 60 * 1000,
        });
        try {
          const oe = otpEmail(user.name, otp);
          await emailService.send({ to: email, subject: oe.subject, html: oe.html });
        } catch (err) {
          req.log.error({ err, email }, "OTP email delivery failed");
          return reply.code(502).send({ error: "otp_delivery_failed" });
        }
      } else {
        const mobile = normalizeMobile(value.trim());
        if (!user.mobileNo || user.mobileNo !== mobile) {
          const existing = await repo.users.findByMobileNo(mobile);
          if (existing && existing.id !== user.id) {
            return reply.code(409).send({ error: "mobile_already_registered" });
          }
          await repo.users.update(user.id, { mobileNo: mobile, mobileVerified: false });
        }
        if (user.mobileVerified && user.mobileNo === mobile) {
          return reply.code(409).send({ error: "already_verified" });
        }
        await repo.verificationTokens.create({
          id: randomUUID(), userId: user.id, type: "otp_mobile",
          token: otp, identifier: mobile,
          expiresAt: Date.now() + 10 * 60 * 1000,
        });
        try {
          await smsService.sendOtp(mobile, otp);
        } catch (err) {
          req.log.error({ err, mobile }, "OTP SMS delivery failed");
          return reply.code(502).send({ error: "otp_delivery_failed" });
        }
      }

      return { ok: true };
    },
  );

  // ── OTP: Verify ──
  app.post<{ Body: { type?: "email" | "mobile"; value?: string; code?: string } }>(
    "/api/v1/auth/verify-otp",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { type, value, code } = req.body ?? {};
      if (!type || !value?.trim() || !code?.trim()) {
        return reply.code(400).send({ error: "type_value_code_required" });
      }
      const user = await repo.users.findById(req.authClaims!.sub);
      if (!user) return reply.code(404).send({ error: "not_synced" });

      const normalized = type === "email" ? value.trim().toLowerCase() : normalizeMobile(value.trim());
      const otpType = type === "email" ? "otp_email" : "otp_mobile";
      const entry = await repo.verificationTokens.findByIdentifier(normalized, otpType);

      if (!entry || entry.userId !== user.id) {
        return reply.code(400).send({ error: "invalid_otp" });
      }
      if (Date.now() > entry.expiresAt) {
        await repo.verificationTokens.delete(entry.id);
        return reply.code(410).send({ error: "otp_expired" });
      }
      const a = Buffer.from(entry.token);
      const b = Buffer.from(code.trim());
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        return reply.code(400).send({ error: "invalid_otp" });
      }

      await repo.verificationTokens.delete(entry.id);

      if (type === "email") {
        await repo.users.update(user.id, { email: normalized, emailVerified: true });
      } else {
        await repo.users.update(user.id, { mobileNo: normalized, mobileVerified: true });
      }

      return { ok: true, [`${type}Verified`]: true };
    },
  );

  // Keep legacy verify-email for old link-based tokens that may still be in inboxes
  app.post<{ Body: { token?: string } }>(
    "/api/v1/auth/verify-email",
    async (req, reply) => {
      const { token } = req.body ?? {};
      if (!token) return reply.code(400).send({ error: "missing_token" });

      const entry = await repo.verificationTokens.findByToken(token, "verify");
      if (!entry) return reply.code(400).send({ error: "invalid_token" });
      if (Date.now() > entry.expiresAt) {
        await repo.verificationTokens.delete(entry.id);
        return reply.code(410).send({ error: "token_expired" });
      }

      await repo.users.update(entry.userId, { emailVerified: true });
      await repo.verificationTokens.delete(entry.id);
      return { ok: true };
    },
  );

  // Resend verification — now sends OTP instead of link
  app.post(
    "/api/v1/auth/resend-verification",
    { preHandler: requireAuth },
    async (req, reply) => {
      const user = await repo.users.findById(req.authClaims!.sub);
      if (!user) return reply.code(404).send({ error: "not_synced" });
      if (user.emailVerified) return reply.code(409).send({ error: "already_verified" });
      if (!user.email) return reply.code(400).send({ error: "no_email_set" });

      const otp = generateOtp();
      await repo.verificationTokens.create({
        id: randomUUID(), userId: user.id, type: "otp_email",
        token: otp, identifier: user.email,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });
      try {
        const oe = otpEmail(user.name, otp);
        await emailService.send({ to: user.email, subject: oe.subject, html: oe.html });
      } catch (err) {
        req.log.error({ err, email: user.email }, "Resend verification email failed");
        return reply.code(502).send({ error: "otp_delivery_failed" });
      }
      return { ok: true };
    },
  );

  // Forgot password
  app.post<{ Body: { email?: string } }>(
    "/api/v1/auth/forgot-password",
    { preHandler: passwordResetLimiter },
    async (req, reply) => {
      const email = req.body?.email?.trim().toLowerCase();
      if (!email) return reply.code(400).send({ error: "missing_email" });

      const user = await repo.users.findByEmail(email);
      if (!user || !user.passwordHash) {
        return { ok: true };
      }

      const resetToken = randomUUID();
      await repo.verificationTokens.create({
        id: randomUUID(), userId: user.id, type: "reset",
        token: hashToken(resetToken), identifier: user.email,
        expiresAt: Date.now() + 60 * 60 * 1000,
      });
      try {
        const re = passwordResetEmail(user.name, resetToken);
        await emailService.send({ to: user.email, subject: re.subject, html: re.html });
      } catch (err) {
        req.log.error({ err, email: user.email }, "Password reset email failed");
        // Don't reveal failure — same response regardless (prevents email enumeration)
      }
      return { ok: true };
    },
  );

  // Reset password
  app.post<{ Body: { token?: string; newPassword?: string } }>(
    "/api/v1/auth/reset-password",
    { preHandler: passwordResetLimiter },
    async (req, reply) => {
      const { token, newPassword } = req.body ?? {};
      if (!token || !newPassword) return reply.code(400).send({ error: "missing_fields" });
      if (newPassword.length < 6) return reply.code(400).send({ error: "password_too_short" });

      const entry = await repo.verificationTokens.findByToken(hashToken(token), "reset");
      if (!entry) return reply.code(400).send({ error: "invalid_token" });
      if (Date.now() > entry.expiresAt) {
        await repo.verificationTokens.delete(entry.id);
        return reply.code(410).send({ error: "token_expired" });
      }

      const hash = await bcrypt.hash(newPassword, 10);
      await repo.users.update(entry.userId, { passwordHash: hash });
      await repo.verificationTokens.delete(entry.id);
      return { ok: true };
    },
  );

  // Change password
  app.post<{ Body: { currentPassword?: string; newPassword?: string } }>(
    "/api/v1/auth/change-password",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { currentPassword, newPassword } = req.body ?? {};
      if (!newPassword || newPassword.length < 6) {
        return reply.code(400).send({ error: "new_password_too_short" });
      }
      const user = await repo.users.findById(req.authClaims!.sub);
      if (!user) return reply.code(404).send({ error: "not_synced" });

      if (user.passwordHash) {
        if (!currentPassword) {
          return reply.code(400).send({ error: "current_password_required" });
        }
        const valid = await bcrypt.compare(currentPassword, user.passwordHash);
        if (!valid) {
          return reply.code(401).send({ error: "invalid_current_password" });
        }
      }

      const hash = await bcrypt.hash(newPassword, 10);
      await repo.users.update(user.id, { passwordHash: hash });
      return { ok: true };
    },
  );

  // Verify email via Google OAuth
  app.post<{ Body: { googleToken?: string } }>(
    "/api/v1/auth/verify-google",
    async (req, reply) => {
      const googleToken = req.body?.googleToken;
      if (!googleToken) return reply.code(400).send({ error: "missing_google_token" });

      let googleEmail: string | undefined;
      try {
        const claims = await verifier.verify(googleToken);
        googleEmail = claims.email?.toLowerCase();
      } catch {
        return reply.code(401).send({ error: "invalid_google_token" });
      }

      if (!googleEmail) {
        return reply.code(400).send({ error: "no_email_in_token" });
      }

      const user = await repo.users.findByEmail(googleEmail);
      if (!user) return reply.code(404).send({ error: "user_not_found" });
      if (user.emailVerified) return reply.code(409).send({ error: "already_verified" });

      await repo.users.update(user.id, { emailVerified: true });
      return { ok: true, emailVerified: true };
    },
  );

  // Legacy account claim
  app.post<{ Body: { legacyClId?: string; legacyEmail?: string } }>(
    "/api/v1/auth/migrate-claim",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { legacyClId, legacyEmail } = req.body ?? {};
      if (!legacyClId && !legacyEmail) {
        return reply.code(400).send({ error: "provide_legacy_cl_id_or_email" });
      }

      const current = await repo.users.findById(req.authClaims!.sub);
      if (!current) return reply.code(404).send({ error: "not_synced" });

      const stub = legacyClId
        ? await repo.users.findByClId(legacyClId)
        : await repo.users.findByEmail(legacyEmail!);

      if (!stub) return reply.code(404).send({ error: "legacy_account_not_found" });
      if (stub.accountStage !== "migrated_stub") {
        return reply.code(409).send({ error: "account_already_claimed" });
      }
      if (stub.id === current.id) {
        return reply.code(409).send({ error: "already_same_account" });
      }

      const claimed = await repo.users.update(current.id, {
        name: stub.name || current.name,
        gender: stub.gender ?? current.gender,
        dob: stub.dob ?? current.dob,
        city: stub.city ?? current.city,
        state: stub.state ?? current.state,
        country: stub.country ?? current.country,
        wcaId: stub.wcaId ?? current.wcaId,
        wcaVerified: stub.wcaVerified || current.wcaVerified,
      });

      // Transfer the stub's competition history (results, registrations,
      // payments) and rebuild PBs, so the claimer keeps their legacy record.
      const transferred = await transferUserData(repo, stub.id, current.id);

      await repo.users.update(stub.id, { accountStage: "banned" });

      await repo.auditLog.create({
        id: randomUUID(),
        adminId: current.id,
        action: "migrate_claim",
        target: `${stub.clId} → ${current.clId}`,
        reason: `Moved ${transferred.movedResults} results, ${transferred.movedRegistrations} registrations, ${transferred.movedPayments} payments`,
        createdAt: new Date().toISOString(),
      });

      return sanitizeUser(claimed!);
    },
  );
}
