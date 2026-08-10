import type { FastifyInstance } from "fastify";
import { randomUUID } from "node:crypto";
import type { Repository } from "../../db/repo";
import { requireAuth } from "../../auth/plugin";
import { generateScramble } from "@cubers/scramble-core";

export async function registerPracticeRoutes(app: FastifyInstance, repo: Repository) {
  const prefix = "/api/v1";

  // ── Practice Sessions ─────────────────────────────────────────────────

  app.get(`${prefix}/practice/sessions`, { preHandler: requireAuth }, async (req) => {
    const userId = req.authClaims!.sub;
    const sessions = await repo.practice.findSessionsByUser(userId);
    const allSolves = await repo.practice.findSolvesBySessionIds(sessions.map((s) => s.id));
    const countBySession = new Map<string, number>();
    for (const s of allSolves) {
      countBySession.set(s.sessionId, (countBySession.get(s.sessionId) ?? 0) + 1);
    }
    const enriched = sessions.map((s) => ({ ...s, solveCount: countBySession.get(s.id) ?? 0 }));
    return { sessions: enriched };
  });

  app.post(`${prefix}/practice/sessions`, { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.authClaims!.sub;
    const { eventType, name } = req.body as { eventType: string; name?: string };
    if (!eventType) return reply.code(400).send({ error: "eventType required" });
    const session = {
      id: randomUUID(),
      userId,
      eventType,
      name: name || `Session ${new Date().toLocaleDateString()}`,
      createdAt: new Date().toISOString(),
    };
    await repo.practice.createSession(session);
    return { session };
  });

  app.get(`${prefix}/practice/sessions/:id`, { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.authClaims!.sub;
    const { id } = req.params as { id: string };
    const session = await repo.practice.findSession(id);
    if (!session || session.userId !== userId) return reply.code(404).send({ error: "not_found" });
    const solves = await repo.practice.findSolvesBySession(id);
    return { session, solves };
  });

  app.patch(`${prefix}/practice/sessions/:id`, { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.authClaims!.sub;
    const { id } = req.params as { id: string };
    const session = await repo.practice.findSession(id);
    if (!session || session.userId !== userId) return reply.code(404).send({ error: "not_found" });
    const { name } = req.body as { name?: string };
    const updated = await repo.practice.updateSession(id, { name });
    return { session: updated };
  });

  app.delete(`${prefix}/practice/sessions/:id`, { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.authClaims!.sub;
    const { id } = req.params as { id: string };
    const session = await repo.practice.findSession(id);
    if (!session || session.userId !== userId) return reply.code(404).send({ error: "not_found" });
    await repo.practice.deleteSession(id);
    return { ok: true };
  });

  app.post(`${prefix}/practice/sessions/:id/end`, { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.authClaims!.sub;
    const { id } = req.params as { id: string };
    const session = await repo.practice.findSession(id);
    if (!session || session.userId !== userId) return reply.code(404).send({ error: "not_found" });
    await repo.practice.endSession(id);
    return { ok: true };
  });

  // ── Solves ─────────────────────────────────────────────────────────────

  app.post(`${prefix}/practice/sessions/:id/solves`, { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.authClaims!.sub;
    const { id } = req.params as { id: string };
    const session = await repo.practice.findSession(id);
    if (!session || session.userId !== userId) return reply.code(404).send({ error: "not_found" });
    const { timeMs, scramble, penalty, note } = req.body as {
      timeMs: number; scramble: string; penalty?: string; note?: string;
    };
    if (timeMs == null || !scramble) return reply.code(400).send({ error: "timeMs and scramble required" });
    const validPenalty: "none" | "plus2" | "dnf" = penalty === "plus2" || penalty === "dnf" ? penalty : "none";
    const solve = {
      id: randomUUID(),
      sessionId: id,
      timeMs,
      scramble,
      penalty: validPenalty,
      note,
      createdAt: new Date().toISOString(),
    };
    await repo.practice.addSolve(solve);
    return { solve };
  });

  app.delete(`${prefix}/practice/solves/:id`, { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.authClaims!.sub;
    const { id } = req.params as { id: string };
    const solve = await repo.practice.findSolve(id);
    if (!solve) return reply.code(404).send({ error: "not_found" });
    const session = await repo.practice.findSession(solve.sessionId);
    if (!session || session.userId !== userId) return reply.code(403).send({ error: "forbidden" });
    await repo.practice.deleteSolve(id);
    return { ok: true };
  });

  // ── Practice Stats ─────────────────────────────────────────────────────

  app.get(`${prefix}/practice/stats`, { preHandler: requireAuth }, async (req) => {
    const userId = req.authClaims!.sub;
    const sessions = await repo.practice.findSessionsByUser(userId);
    const allSolves = await repo.practice.findSolvesBySessionIds(sessions.map((s) => s.id));

    // Build a sessionId → eventType lookup
    const sessionEvent = new Map(sessions.map((s) => [s.id, s.eventType]));

    let totalSolves = 0;
    let totalTimeMs = 0;
    const eventBests: Record<string, number> = {};
    for (const solve of allSolves) {
      if (solve.penalty === "dnf") continue;
      totalSolves++;
      const effective = solve.penalty === "plus2" ? solve.timeMs + 2000 : solve.timeMs;
      totalTimeMs += effective;
      const eventType = sessionEvent.get(solve.sessionId) ?? "333";
      if (!eventBests[eventType] || effective < eventBests[eventType]!) {
        eventBests[eventType] = effective;
      }
    }
    return {
      stats: {
        totalSessions: sessions.length,
        totalSolves,
        totalTimeMs,
        eventBests,
      },
    };
  });

  // ── Daily Challenge ────────────────────────────────────────────────────

  app.get(`${prefix}/daily-challenge`, async (req) => {
    const today = new Date().toISOString().slice(0, 10);
    let challenge = await repo.dailyChallenge.findByDate(today);
    if (!challenge) {
      const scramble = await generateScramble("333");
      challenge = {
        id: randomUUID(),
        date: today,
        eventType: "333",
        scramble,
        createdAt: new Date().toISOString(),
      };
      await repo.dailyChallenge.create(challenge);
      // Re-read to get the canonical row in case of a concurrent insert
      challenge = (await repo.dailyChallenge.findByDate(today)) ?? challenge;
    }
    const userId = req.authClaims?.sub;
    let userResult = null;
    let streak = 0;
    if (userId) {
      userResult = await repo.dailyChallenge.findResultByUserAndChallenge(userId, challenge.id);
      streak = await repo.dailyChallenge.findUserStreak(userId);
    }
    const results = await repo.dailyChallenge.findResultsByChallenge(challenge.id);
    return {
      challenge: userResult ? challenge : { ...challenge, scramble: challenge.scramble },
      userResult,
      streak,
      leaderboard: results.slice(0, 50),
    };
  });

  app.post(`${prefix}/daily-challenge/submit`, { preHandler: requireAuth }, async (req, reply) => {
    const userId = req.authClaims!.sub;
    const { timeMs, penalty } = req.body as { timeMs: number; penalty?: string };
    if (!timeMs || timeMs <= 0) return reply.code(400).send({ error: "valid timeMs required" });
    const validPenalty = penalty === "plus2" || penalty === "dnf" ? penalty : "none";

    const today = new Date().toISOString().slice(0, 10);
    const challenge = await repo.dailyChallenge.findByDate(today);
    if (!challenge) return reply.code(404).send({ error: "no challenge today" });

    const existing = await repo.dailyChallenge.findResultByUserAndChallenge(userId, challenge.id);
    if (existing) return reply.code(409).send({ error: "already_submitted" });

    const result = {
      id: randomUUID(),
      challengeId: challenge.id,
      userId,
      timeMs,
      penalty: validPenalty as "none" | "plus2" | "dnf",
      submittedAt: new Date().toISOString(),
    };
    await repo.dailyChallenge.submitResult(result);
    const streak = await repo.dailyChallenge.findUserStreak(userId);
    return { result, streak };
  });
}
