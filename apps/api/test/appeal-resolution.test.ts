import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { createMemRepo } from "../src/db/mem-repo";
import type { Repository } from "../src/db/repo";
import { seed, SEED_DEMO_COMP_ID } from "../src/db/seed";
import { adminToken, bearer, devToken, syncVerifiedUser } from "./helpers";

/**
 * Accepting an appeal has to change the result.
 *
 * It used to update only the appeal row, so the competitor was told "accepted"
 * while their result stayed disqualified — the decision did nothing unless an
 * admin separately remembered to fix the result in the verification workspace.
 */

let app: FastifyInstance;
let repo: Repository;
let admin: string;
let eventId: string;
let roundId: string;

async function competitor(email: string) {
  const token = await devToken(app, email, email.split("@")[0]);
  const { id } = await syncVerifiedUser(app, repo, token);
  await app.inject({
    method: "POST",
    url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}/register`,
    payload: { eventIds: [eventId] },
    headers: bearer(token),
  });
  return { token, id };
}

/** A result already judged down to `disqualified`, as an appeal would follow. */
async function disqualifiedResult(userId: string) {
  const id = randomUUID();
  await repo.results.create({
    id,
    roundId,
    userId,
    solves: [10000, 11000, 12000, 13000, 14000].map((t) => ({
      time_ms: t,
      penalty: "none" as const,
      inspectionPenalty: "none" as const,
    })),
    bestSingleMs: 10000,
    ao5Ms: 12000,
    meanMs: 12000,
    medianMs: 12000,
    stdMs: 0,
    rank: null,
    videoUrl: null,
    flagStatus: "disqualified",
    flagReasons: [],
    submittedAt: new Date().toISOString(),
  });
  return id;
}

beforeAll(async () => {
  repo = createMemRepo();
  await seed(repo);
  app = await buildApp(repo);
  admin = await adminToken(app);
  await app.inject({ method: "POST", url: "/api/v1/auth/sync", headers: bearer(admin) });

  const detail = await app.inject({
    method: "GET",
    url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}`,
  });
  eventId = detail.json().events[0].id;
  const rounds = await repo.rounds.findByCompetition(SEED_DEMO_COMP_ID);
  roundId = rounds.find((r) => r.competitionEventId === eventId)!.id;
});

describe("resolving an appeal", () => {
  it("accepting restores the result", async () => {
    const { token, id } = await competitor("appellant@test.com");
    const resultId = await disqualifiedResult(id);

    const appeal = await app.inject({
      method: "POST",
      url: "/api/v1/appeals",
      payload: { resultId, reason: "the video shows a clean solve" },
      headers: bearer(token),
    });
    expect(appeal.statusCode).toBe(201);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/appeals/${appeal.json().id}/resolve`,
      payload: { action: "accepted", adminResponse: "reviewed, upheld" },
      headers: bearer(admin),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("accepted");

    // The point of the fix: the result itself moved.
    const after = await repo.results.findById(resultId);
    expect(after!.flagStatus).toBe("verified");

    // And it counts again — a disqualified result is excluded from ranking.
    expect(after!.rank).not.toBeNull();
  });

  it("rejecting leaves the result exactly as it was", async () => {
    const { token, id } = await competitor("rejected@test.com");
    const resultId = await disqualifiedResult(id);

    const appeal = await app.inject({
      method: "POST",
      url: "/api/v1/appeals",
      payload: { resultId, reason: "please reconsider" },
      headers: bearer(token),
    });

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/appeals/${appeal.json().id}/resolve`,
      payload: { action: "rejected", adminResponse: "video is inconclusive" },
      headers: bearer(admin),
    });
    expect(res.statusCode).toBe(200);

    const after = await repo.results.findById(resultId);
    expect(after!.flagStatus).toBe("disqualified");
  });
});
