import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { createMemRepo } from "../src/db/mem-repo";
import type { Repository } from "../src/db/repo";
import { seed } from "../src/db/seed";
import { adminToken, bearer, devToken, syncVerifiedUser } from "./helpers";

/**
 * Bulk verify goes through the same function as the single-result routes.
 *
 * It used to be a fourth copy that skipped two of their guards. A bulk `plus2`
 * set the flag while `overridesForAction` returned nothing, so the times were
 * never actually penalised — the result read as +2 and still ranked as clean.
 * And a bulk disqualification never re-derived the shortlist of an
 * already-advanced round, leaving the disqualified competitor still admitted to
 * the next one.
 *
 * Both were latent: the workspace UI only ever sends `verified`, from a single
 * call site. This is the guard that they stay closed.
 */

let app: FastifyInstance;
let repo: Repository;
let admin: string;

async function roundWithResults(count = 3) {
  const compId = randomUUID();
  const eventId = randomUUID();
  const roundId = randomUUID();
  const now = new Date().toISOString();

  await repo.competitions.create({
    id: compId,
    title: `Bulk ${randomUUID().slice(0, 8)}`,
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

  const resultIds: string[] = [];
  for (let i = 0; i < count; i++) {
    const token = await devToken(app, `bulk${i}-${compId.slice(0, 6)}@test.com`, `Cuber ${i}`);
    const { id } = await syncVerifiedUser(app, repo, token);

    const t = 9000 + i * 1000;
    const resultId = randomUUID();
    await repo.results.create({
      id: resultId,
      roundId,
      userId: id,
      solves: [t, t, t, t, t].map((ms) => ({
        time_ms: ms, penalty: "none" as const, inspectionPenalty: "none" as const,
      })),
      bestSingleMs: t, ao5Ms: t, meanMs: t, medianMs: t, stdMs: 0,
      rank: i + 1, videoUrl: null,
      flagStatus: "flagged",
      flagReasons: [],
      submittedAt: now,
    });
    resultIds.push(resultId);
  }

  return { roundId, resultIds };
}

const bulk = (resultIds: string[], action: string, reason?: string) =>
  app.inject({
    method: "POST",
    url: "/api/v1/admin/verification/bulk-verify",
    payload: { resultIds, action, reason },
    headers: bearer(admin),
  });

beforeEach(async () => {
  repo = createMemRepo();
  await seed(repo);
  app = await buildApp(repo);
  admin = await adminToken(app);
  await app.inject({ method: "POST", url: "/api/v1/auth/sync", headers: bearer(admin) });
});

describe("bulk verify", () => {
  it("clears a batch of flagged results, which is what the UI does", async () => {
    const { resultIds } = await roundWithResults();

    const res = await bulk(resultIds, "verified");
    expect(res.statusCode).toBe(200);
    expect(res.json().updated).toBe(3);

    for (const id of resultIds) {
      expect((await repo.results.findById(id))!.flagStatus).toBe("verified");
    }
  });

  it("refuses a +2 that does not say which attempt", async () => {
    const { resultIds } = await roundWithResults(1);

    const res = await bulk(resultIds, "plus2", "inspection");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("attempt_penalties_required");

    // And nothing was written — a half-applied bulk is worse than none.
    expect((await repo.results.findById(resultIds[0]!))!.flagStatus).toBe("flagged");
  });

  it("still requires a reason for a destructive verdict", async () => {
    const { resultIds } = await roundWithResults(1);

    const res = await bulk(resultIds, "disqualified");
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("reason_required");
  });

  it("keeps previous state for undo", async () => {
    const { resultIds } = await roundWithResults(2);

    const res = await bulk(resultIds, "verified");
    const previous = res.json().previousStates as { id: string; flagStatus: string }[];
    expect(previous).toHaveLength(2);
    expect(previous.every((p) => p.flagStatus === "flagged")).toBe(true);

    const undo = await app.inject({
      method: "POST",
      url: "/api/v1/admin/verification/bulk-undo",
      payload: { restorations: previous },
      headers: bearer(admin),
    });
    expect(undo.statusCode).toBe(200);
    expect((await repo.results.findById(resultIds[0]!))!.flagStatus).toBe("flagged");
  });

  it("records each result under the bulk prefix", async () => {
    const { resultIds } = await roundWithResults(2);
    await bulk(resultIds, "verified");

    const log = await repo.auditLog.findAll();
    for (const id of resultIds) {
      expect(log.some((e) => e.action === "bulk_result_verified" && e.target === id)).toBe(true);
    }
  });
});
