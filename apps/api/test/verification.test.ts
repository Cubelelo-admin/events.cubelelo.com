import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { createMemRepo } from "../src/db/mem-repo";
import type { Repository } from "../src/db/repo";
import { seed, SEED_DEMO_COMP_ID } from "../src/db/seed";
import { adminToken, bearer, devToken, syncVerifiedUser } from "./helpers";

let app: FastifyInstance;
let repo: Repository;
let admin: string;
let eventId: string;

beforeAll(async () => {
  repo = createMemRepo();
  await seed(repo);
  app = await buildApp(repo);
  admin = await adminToken(app);
  // Sync admin so auth plugin resolves the token
  await app.inject({ method: "POST", url: "/api/v1/auth/sync", headers: bearer(admin) });

  // Resolve event ID
  const detail = await app.inject({ method: "GET", url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}` });
  eventId = detail.json().events[0].id;
});

/** Sync a user, verify them, and register for the seeded event. */
async function registerUser(email: string, name: string): Promise<{ token: string; id: string }> {
  const token = await devToken(app, email, name);
  const { id } = await syncVerifiedUser(app, repo, token);
  await app.inject({
    method: "POST",
    url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}/register`,
    payload: { eventIds: [eventId] },
    headers: bearer(token),
  });
  return { token, id };
}

describe("admin verification queue", () => {
  let resultId: string;

  it("shows empty queue when no flagged results", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/admin/competitions/${SEED_DEMO_COMP_ID}/queue`,
      headers: bearer(admin),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });

  it("flags a suspiciously fast result and shows it in queue", async () => {
    const { token: userTok } = await registerUser("fast@test.com", "Fast Cuber");

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}`,
    });
    const roundId = detail.json().events[0].rounds[0].id;

    // Submit very fast solves (ao5 ~1000ms, well below 3000ms threshold for 333)
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rounds/${roundId}/results`,
      payload: {
        solves: [
          { time_ms: 900, inspectionPenalty: "none", penalty: "none" },
          { time_ms: 1000, inspectionPenalty: "none", penalty: "none" },
          { time_ms: 1100, inspectionPenalty: "none", penalty: "none" },
          { time_ms: 950, inspectionPenalty: "none", penalty: "none" },
          { time_ms: 1050, inspectionPenalty: "none", penalty: "none" },
        ],
      },
      headers: bearer(userTok),
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().flagStatus).toBe("flagged");
    resultId = res.json().id;

    const queue = await app.inject({
      method: "GET",
      url: `/api/v1/admin/competitions/${SEED_DEMO_COMP_ID}/queue`,
      headers: bearer(admin),
    });
    expect(queue.json()).toHaveLength(1);
    expect(queue.json()[0].id).toBe(resultId);
  });

  it("verifies a flagged result and clears the queue", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/results/${resultId}/verify`,
      payload: { action: "verified", reason: "Video confirms legitimacy" },
      headers: bearer(admin),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().flagStatus).toBe("verified");

    // Queue should be empty again
    const queue = await app.inject({
      method: "GET",
      url: `/api/v1/admin/competitions/${SEED_DEMO_COMP_ID}/queue`,
      headers: bearer(admin),
    });
    expect(queue.json()).toEqual([]);
  });
});

describe("judge override recalculates stats and personal bests (HIGH-009)", () => {
  let resultId: string;
  let userId: string;
  let roundId: string;

  async function override(action: string, solvePenalties?: (string | null)[]) {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/results/${resultId}/verify`,
      payload: { action, reason: "test override", solvePenalties },
      headers: bearer(admin),
    });
    expect(res.statusCode).toBe(200);
  }

  async function currentResult() {
    return (await repo.results.findById(resultId))!;
  }

  async function currentPb() {
    return (await repo.personalBests.findByUser(userId)).find((pb) => pb.eventType === "333");
  }

  it("sets stats and PB on submission", async () => {
    const { token: tok, id } = await registerUser("override@test.com", "Override Target");
    userId = id;

    const detail = await app.inject({
      method: "GET",
      url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}`,
    });
    roundId = detail.json().events[0].rounds[0].id;

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/rounds/${roundId}/results`,
      payload: {
        solves: [8000, 9000, 7000, 10000, 8500].map((t) => ({
          time_ms: t, inspectionPenalty: "none", penalty: "none",
        })),
      },
      headers: bearer(tok),
    });
    expect(res.statusCode).toBe(201);
    resultId = res.json().id;
    expect(res.json().ao5Ms).toBe(8500);
    expect(res.json().bestSingleMs).toBe(7000);

    const pb = await currentPb();
    expect(pb?.bestAo5Ms).toBe(8500);
    expect(pb?.bestSingleMs).toBe(7000);
  });

  it("rejects a +2 that does not say which attempt it applies to", async () => {
    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/results/${resultId}/verify`,
      payload: { action: "plus2", reason: "no attempt named" },
      headers: bearer(admin),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("attempt_penalties_required");
  });

  it("plus2 on the fastest attempt moves the single and the average correctly", async () => {
    // Solves 8.00 9.00 7.00 10.00 8.50 → +2 on the 7.00 makes it 9.00.
    // Single: 7.00 → 8.00. Ao5: trim 8.00 and 10.00, mean(8.50, 9.00, 9.00) = 8.83.
    // The old flat +2000-on-every-stat gave 10.50 / 9.00 — wrong on both.
    await override("plus2", [null, null, "plus2", null, null]);
    const result = await currentResult();
    expect(result.bestSingleMs).toBe(8000);
    expect(result.ao5Ms).toBe(8830);

    const pb = await currentPb();
    expect(pb?.bestAo5Ms).toBe(8830);
    expect(pb?.bestSingleMs).toBe(8000);
  });

  it("plus2 on a non-fastest attempt leaves the single untouched", async () => {
    // +2 on the 8.00 → 10.00. Single stays 7.00; Ao5 trims 7.00 and one 10.00,
    // mean(8.50, 9.00, 10.00) = 9.17 — a 0.67 s shift, not 2 s.
    await override("plus2", ["plus2", null, null, null, null]);
    const result = await currentResult();
    expect(result.bestSingleMs).toBe(7000);
    expect(result.ao5Ms).toBe(9170);
  });

  it("dnf on one attempt does not void the other four", async () => {
    // A single DNF is trimmed as the worst (WCA 9f). Single becomes the best of
    // the remaining attempts; the average is still computable. Nulling every
    // stat, as before, threw away four valid attempts.
    await override("dnf", [null, null, "dnf", null, null]);
    const result = await currentResult();
    expect(result.bestSingleMs).toBe(8000);
    expect(result.ao5Ms).toBe(9170);
  });

  it("two DNFs make the average a DNF but keep the single", async () => {
    await override("dnf", [null, null, "dnf", "dnf", null]);
    const result = await currentResult();
    expect(result.bestSingleMs).toBe(8000);
    expect(result.ao5Ms).toBeNull();
  });

  it("verified restores the original stats and PB", async () => {
    await override("verified");
    const result = await currentResult();
    expect(result.ao5Ms).toBe(8500);
    expect(result.bestSingleMs).toBe(7000);

    const pb = await currentPb();
    expect(pb?.bestAo5Ms).toBe(8500);
    expect(pb?.bestSingleMs).toBe(7000);
  });

  it("disqualified excludes the result from ranks and PBs", async () => {
    await override("disqualified");
    const result = await currentResult();
    // Unranked, not rank 0 — every leaderboard sorts ascending by rank, so a 0
    // put disqualified results at the top of the board.
    expect(result.rank).toBeNull();

    const pb = await currentPb();
    expect(pb?.bestAo5Ms).toBeNull();
    expect(pb?.bestSingleMs).toBeNull();
  });

  it("exposes applied per-attempt penalties in the results feed", async () => {
    // The raw solves are never rewritten, so judgeOverrides is the only record of
    // an applied +2/DNF. The verification workspace reloads from this feed after a
    // verdict — if the feed omits the overrides, the applied penalty is invisible
    // and the verdict looks like it "did nothing".
    await override("plus2", ["plus2", null, null, null, null]);

    const feed = await app.inject({
      method: "GET",
      url: `/api/v1/admin/verification/rounds/${roundId}/results`,
      headers: bearer(admin),
    });
    expect(feed.statusCode).toBe(200);
    const dto = (feed.json() as { id: string; judgeOverrides: (string | null)[] | null }[])
      .find((r) => r.id === resultId);
    expect(dto).toBeDefined();
    expect(dto!.judgeOverrides).toEqual(["plus2", null, null, null, null]);
  });
});
