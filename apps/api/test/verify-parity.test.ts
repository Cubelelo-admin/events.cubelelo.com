import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { createMemRepo } from "../src/db/mem-repo";
import type { Repository } from "../src/db/repo";
import { seed } from "../src/db/seed";
import { adminToken, bearer, devToken, syncVerifiedUser } from "./helpers";

/**
 * The admin and judge verify routes must behave identically.
 *
 * They were ~70 duplicated lines differing only in who is let in and the audit
 * prefix, so every fix had to land twice — the `plus2`/`dnf` enum crash lived in
 * both copies, and so did the missing appeal handling. They now share
 * `verifyResult`; this is the guard that they still agree.
 */

let app: FastifyInstance;
let repo: Repository;
let admin: string;
let judge: string;

/** A fresh round with one result, and a judge assigned to it. */
async function scenario() {
  const compId = randomUUID();
  const eventId = randomUUID();
  const roundId = randomUUID();
  const now = new Date().toISOString();

  await repo.competitions.create({
    id: compId,
    title: `Parity ${randomUUID().slice(0, 8)}`,
    type: "free",
    status: "live",
    baseFee: 0,
    perEventFee: 0,
    featured: false,
    videoDeadlineMinutes: 1440,
    createdAt: now,
  });
  await repo.competitionEvents.create({
    id: eventId, competitionId: compId, eventType: "333", roundCount: 1,
  });
  await repo.rounds.create({
    id: roundId, competitionEventId: eventId, roundNumber: 1, status: "open",
  });

  const token = await devToken(app, `par-${compId.slice(0, 6)}@test.com`, "Competitor");
  const { id: userId } = await syncVerifiedUser(app, repo, token);

  const resultId = randomUUID();
  await repo.results.create({
    id: resultId,
    roundId,
    userId,
    solves: [9000, 9500, 10000, 10500, 11000].map((ms) => ({
      time_ms: ms, penalty: "none" as const, inspectionPenalty: "none" as const,
    })),
    bestSingleMs: 9000,
    ao5Ms: 10000,
    meanMs: 10000,
    medianMs: 10000,
    stdMs: 0,
    rank: 1,
    videoUrl: null,
    flagStatus: "flagged",
    flagReasons: [],
    submittedAt: now,
  });

  // Assign the judge so their door opens for this round.
  const judgeUser = await repo.users.findByEmail("parity-judge@test.com");
  await repo.judgeAssignments.create({
    id: randomUUID(),
    roundId,
    judgeId: judgeUser!.id,
    assignedBy: "test",
    assignedAt: now,
  });

  return { resultId, roundId, userId };
}

const asAdmin = (resultId: string, payload: object) =>
  app.inject({
    method: "POST",
    url: `/api/v1/admin/results/${resultId}/verify`,
    payload,
    headers: bearer(admin),
  });

const asJudge = (resultId: string, payload: object) =>
  app.inject({
    method: "POST",
    url: `/api/v1/judge/results/${resultId}/verify`,
    payload,
    headers: bearer(judge),
  });

beforeEach(async () => {
  repo = createMemRepo();
  await seed(repo);
  app = await buildApp(repo);
  admin = await adminToken(app);
  await app.inject({ method: "POST", url: "/api/v1/auth/sync", headers: bearer(admin) });

  judge = await devToken(app, "parity-judge@test.com", "Parity Judge");
  const j = await syncVerifiedUser(app, repo, judge);
  await repo.users.update(j.id, { role: "judge" });
});

/** Cases both routes must answer the same way. */
const CASES: { name: string; payload: object; status: number; error?: string }[] = [
  { name: "no action", payload: {}, status: 400, error: "invalid_action" },
  { name: "unknown action", payload: { action: "nonsense" }, status: 400, error: "invalid_action" },
  {
    name: "destructive verdict with no reason",
    payload: { action: "disqualified" },
    status: 400,
    error: "reason_required",
  },
  {
    name: "+2 with no attempt named",
    payload: { action: "plus2", reason: "inspection" },
    status: 400,
    error: "attempt_penalties_required",
  },
  {
    name: "malformed attempt penalties",
    payload: { action: "plus2", reason: "inspection", solvePenalties: ["nope"] },
    status: 400,
    error: "invalid_solve_penalties",
  },
  { name: "plain verification", payload: { action: "verified" }, status: 200 },
  {
    name: "+2 on a named attempt",
    payload: {
      action: "plus2",
      reason: "inspection",
      solvePenalties: ["plus2", null, null, null, null],
    },
    status: 200,
  },
  {
    name: "disqualification",
    payload: { action: "disqualified", reason: "cheating" },
    status: 200,
  },
];

describe("admin and judge verify agree", () => {
  for (const c of CASES) {
    it(`${c.name}`, async () => {
      const a = await scenario();
      const adminRes = await asAdmin(a.resultId, c.payload);

      const j = await scenario();
      const judgeRes = await asJudge(j.resultId, c.payload);

      expect(judgeRes.statusCode, `status for "${c.name}"`).toBe(adminRes.statusCode);
      expect(adminRes.statusCode).toBe(c.status);
      if (c.error) {
        expect(adminRes.json().error).toBe(c.error);
        expect(judgeRes.json().error).toBe(c.error);
      }

      if (c.status !== 200) return;

      // The stored result must land identically.
      const adminResult = await repo.results.findById(a.resultId);
      const judgeResult = await repo.results.findById(j.resultId);
      expect(judgeResult!.flagStatus).toBe(adminResult!.flagStatus);
      expect(judgeResult!.ao5Ms).toBe(adminResult!.ao5Ms);
      expect(judgeResult!.bestSingleMs).toBe(adminResult!.bestSingleMs);
      expect(judgeResult!.judgeOverrides ?? null).toEqual(adminResult!.judgeOverrides ?? null);

      // The audit entries must match apart from the prefix, which is the one
      // thing the two routes are meant to record differently.
      const log = await repo.auditLog.findAll();
      const adminEntry = log.find((e) => e.target === a.resultId)!;
      const judgeEntry = log.find((e) => e.target === j.resultId)!;
      expect(adminEntry).toBeDefined();
      expect(judgeEntry).toBeDefined();
      expect(judgeEntry.action).toBe(`judge_${adminEntry.action}`);
      expect(judgeEntry.newValue).toBe(adminEntry.newValue);
      expect(judgeEntry.reason).toBe(adminEntry.reason);
    });
  }
});

describe("each route keeps its own door", () => {
  it("refuses a judge who is not assigned to the round", async () => {
    const s = await scenario();
    const stranger = await devToken(app, "stranger-judge@test.com", "Stranger");
    const sj = await syncVerifiedUser(app, repo, stranger);
    await repo.users.update(sj.id, { role: "judge" });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/judge/results/${s.resultId}/verify`,
      payload: { action: "verified" },
      headers: bearer(stranger),
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe("not_assigned_to_round");
  });

  it("refuses a moderator who does not own the competition", async () => {
    const s = await scenario();
    const modToken = await devToken(app, "outsider-mod3@test.com", "Outsider Mod");
    const mod = await syncVerifiedUser(app, repo, modToken);
    await repo.users.update(mod.id, { role: "moderator" });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/results/${s.resultId}/verify`,
      payload: { action: "verified" },
      headers: bearer(modToken),
    });
    expect(res.statusCode).toBe(403);
  });
});
