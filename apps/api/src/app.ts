import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import compress from "@fastify/compress";
import multipart from "@fastify/multipart";
import staticPlugin from "@fastify/static";
import type { Repository } from "./db/repo";
import { type Realtime, noopRealtime } from "./sockets/realtime";
import { createVerifier, type Verifier } from "./auth/verifier";
import { registerAuth } from "./auth/plugin";
import { registerAuthRoutes } from "./modules/auth/routes";
import { registerCompetitionRoutes } from "./modules/competitions/routes";
import { registerRoundRoutes } from "./modules/rounds/routes";
import { registerResultRoutes } from "./modules/results/routes";
import { registerAdminRoutes } from "./modules/admin/routes";
import { registerRegistrationRoutes } from "./modules/registration/routes";
import { registerPaymentRoutes } from "./modules/payments/routes";
import { registerUserRoutes } from "./modules/users/routes";
import { registerPracticeRoutes } from "./modules/practice/routes";
import { registerJudgeRoutes } from "./modules/judge/routes";
import { emailServiceName } from "./lib/email";
import { getRedis } from "./lib/redis";

/** Build the Fastify app around a repository, realtime emitter, and auth verifier. */
export async function buildApp(
  repo: Repository,
  realtime: Realtime = noopRealtime,
  verifier: Verifier = createVerifier(),
): Promise<FastifyInstance> {
  if (process.env.NODE_ENV === "production" && !process.env.CORS_ORIGINS) {
    throw new Error("CORS_ORIGINS must be set in production");
  }

  const app = Fastify({
    logger: process.env.NODE_ENV === "production"
      ? { level: "info" }
      : false,
    trustProxy: !!process.env.TRUST_PROXY,
    bodyLimit: 256 * 1024,
  });

  await app.register(compress);
  await app.register(cors, {
    origin: process.env.CORS_ORIGINS
      ? process.env.CORS_ORIGINS.split(",")
      : true,
  });
  await app.register(multipart, { limits: { fileSize: 5 * 1024 * 1024 } });
  await app.register(staticPlugin, {
    root: join(process.cwd(), "uploads"),
    prefix: "/uploads/",
    decorateReply: false,
  });
  registerAuth(app, repo, verifier);

  app.setErrorHandler((error: { statusCode?: number; code?: string; message?: string; validation?: unknown }, _req, reply) => {
    const status = error.statusCode ?? 500;
    // Fastify validation errors (malformed JSON, schema violations)
    if (error.validation) {
      return reply.code(400).send({ error: "invalid_request" });
    }
    if (status >= 500) {
      app.log.error(error);
      return reply.code(status).send({ error: "internal_error" });
    }
    // For 4xx thrown via Object.assign(new Error("code"), { statusCode: N }),
    // the message *is* the error code. Anything else that reaches here — a
    // library throwing a 4xx with a prose message — would otherwise publish that
    // prose in the `error` field where clients expect a machine code, so only
    // snake_case codes are passed through.
    const message = error.message ?? "";
    if (/^[a-z][a-z0-9_]*$/.test(message)) {
      return reply.code(status).send({ error: message });
    }
    app.log.warn({ err: error }, "4xx with a non-code message");
    return reply.code(status).send({ error: "invalid_request" });
  });

  app.get("/health", async (_req, reply) => {
    return reply.redirect("/api/v1/health");
  });

  app.get("/api/v1/health", async (_req, reply) => {
    try {
      const db = await repo.ping();
      let redis: { status: string; latencyMs?: number } = { status: "not_configured" };
      const redisClient = await getRedis();
      if (redisClient) {
        const start = Date.now();
        await redisClient.ping();
        redis = { status: "ok", latencyMs: Date.now() - start };
      }
      return {
        status: "ok",
        db: db ?? { backend: "memory", latencyMs: 0 },
        redis,
        websocket: realtime.stats(),
        email: emailServiceName(),
        sms: process.env.TWILIO_ACCOUNT_SID ? "twilio" : "none",
      };
    } catch (err) {
      // Stringifying the exception into the response leaked connection strings
      // and internal hostnames on an unauthenticated endpoint. Log it instead.
      app.log.error(err, "Health check failed");
      reply.code(503);
      return { status: "error", db: null, redis: null };
    }
  });

  await registerAuthRoutes(app, repo, verifier, realtime);
  await registerCompetitionRoutes(app, repo);
  await registerRoundRoutes(app, repo, realtime);
  await registerResultRoutes(app, repo, realtime);
  await registerAdminRoutes(app, repo, realtime);
  await registerRegistrationRoutes(app, repo);
  await registerPaymentRoutes(app, repo);
  await registerUserRoutes(app, repo);
  await registerPracticeRoutes(app, repo);
  await registerJudgeRoutes(app, repo, realtime);

  return app;
}
