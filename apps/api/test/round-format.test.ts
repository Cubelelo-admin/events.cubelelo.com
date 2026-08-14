import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { createMemRepo } from "../src/db/mem-repo";
import type { Repository } from "../src/db/repo";
import { seed, SEED_DEMO_COMP_ID } from "../src/db/seed";
import { adminToken, bearer, devToken, syncVerifiedUser } from "./helpers";

/**
 * Regression cover for the round-format standard.
 *
 * Before migration 041 the attempt count was guessed from the event type by a
 * hardcoded set in the results route, while the web terminal always sent five
 * attempts. Every 6x6/7x7/BLD submission therefore failed with `invalid_solves`
 * and the competitor's result was lost. These tests pin the format-driven
 * behaviour on both sides of that bug.
 */

let app: FastifyInstance;
let repo: Repository;
let admin: string;

/** A round of the given event/format, plus its competition event id. */
async function makeRound(
  eventType: string,
  format: "1" | "2" | "3" | "a" | "m",
  limits: { cutoffMs?: number; timeLimitMs?: number } = {},
): Promise<{ roundId: string; eventId: string }> {
  const eventId = randomUUID();
  await repo.competitionEvents.create({
    id: eventId,
    competitionId: SEED_DEMO_COMP_ID,
    eventType,
    roundCount: 1,
  });
  const roundId = randomUUID();
  await repo.rounds.create({
    id: roundId,
    competitionEventId: eventId,
    roundNumber: 1,
    status: "open",
    format,
    cutoffMs: limits.cutoffMs,
    timeLimitMs: limits.timeLimitMs,
    opensAt: new Date(Date.now() - 60_000).toISOString(),
  });
  return { roundId, eventId };
}

/** Sync a verified user and register them for the given competition event. */
async function registerFor(email: string, eventId: string): Promise<string> {
  const token = await devToken(app, email, email.split("@")[0]);
  await syncVerifiedUser(app, repo, token);
  await app.inject({
    method: "POST",
    url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}/register`,
    payload: { eventIds: [eventId] },
    headers: bearer(token),
  });
  return token;
}

const solve = (ms: number) => ({ time_ms: ms, inspectionPenalty: "none", penalty: "none" });

async function submit(roundId: string, token: string, times: number[]) {
  return app.inject({
    method: "POST",
    url: `/api/v1/rounds/${roundId}/results`,
    payload: { solves: times.map(solve) },
    headers: bearer(token),
  });
}

beforeAll(async () => {
  repo = createMemRepo();
  await seed(repo);
  app = await buildApp(repo);
  admin = await adminToken(app);
  await app.inject({ method: "POST", url: "/api/v1/auth/sync", headers: bearer(admin) });
});

describe("round format drives attempt count", () => {
  it("accepts 3 attempts for a Mean-of-3 event (6x6)", async () => {
    const { roundId, eventId } = await makeRound("666", "m");
    const token = await registerFor("mo3@test.com", eventId);

    const res = await submit(roundId, token, [90_000, 95_000, 92_000]);
    expect(res.statusCode).toBe(201);
    expect(res.json().solves).toHaveLength(3);
  });

  it("rejects 5 attempts for a Mean-of-3 event — more than the format allows", async () => {
    const { roundId, eventId } = await makeRound("777", "m");
    const token = await registerFor("mo3-over@test.com", eventId);

    const res = await submit(roundId, token, [90_000, 95_000, 92_000, 93_000, 94_000]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_solves");
  });

  it("accepts 3 attempts for a Best-of-3 blindfolded event", async () => {
    const { roundId, eventId } = await makeRound("333bf", "3");
    const token = await registerFor("bo3@test.com", eventId);

    const res = await submit(roundId, token, [60_000, 65_000, 62_000]);
    expect(res.statusCode).toBe(201);
    expect(res.json().solves).toHaveLength(3);
  });

  it("still accepts the full 5 attempts for an Average-of-5 event", async () => {
    const { roundId, eventId } = await makeRound("333", "a");
    const token = await registerFor("ao5@test.com", eventId);

    const res = await submit(roundId, token, [12_000, 13_000, 11_000, 14_000, 12_500]);
    expect(res.statusCode).toBe(201);
    expect(res.json().solves).toHaveLength(5);
  });
});

describe("short attempt sets are preserved, not discarded", () => {
  it("accepts a 2-attempt submission in an Ao5 round (cutoff failed)", async () => {
    const { roundId, eventId } = await makeRound("333", "a");
    const token = await registerFor("cutoff@test.com", eventId);

    // A competitor who fails the cutoff stops after 2 attempts. This previously
    // returned 400 and destroyed the result entirely.
    const res = await submit(roundId, token, [30_000, 31_000]);
    expect(res.statusCode).toBe(201);
    expect(res.json().solves).toHaveLength(2);
  });

  it("rejects an empty attempt set", async () => {
    const { roundId, eventId } = await makeRound("333", "a");
    const token = await registerFor("empty@test.com", eventId);

    const res = await submit(roundId, token, []);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_solves");
  });
});

describe("format falls back to the WCA event default", () => {
  it("treats a formatless 6x6 round as Mean-of-3", async () => {
    // Rounds created before migration 041 have no stored format.
    const eventId = randomUUID();
    await repo.competitionEvents.create({
      id: eventId,
      competitionId: SEED_DEMO_COMP_ID,
      eventType: "666",
      roundCount: 1,
    });
    const roundId = randomUUID();
    await repo.rounds.create({
      id: roundId,
      competitionEventId: eventId,
      roundNumber: 1,
      status: "open",
      opensAt: new Date(Date.now() - 60_000).toISOString(),
    });
    const token = await registerFor("legacy@test.com", eventId);

    expect((await submit(roundId, token, [90_000, 95_000, 92_000])).statusCode).toBe(201);
  });
});

describe("cutoff is enforced server-side (WCA 9g)", () => {
  it("rejects continuing past a cutoff the competitor never beat", async () => {
    // Ao5 with a 20 s cutoff: the first 2 attempts decide it. Both are over, so
    // attempts 3-5 should never have happened. Enforced only in the browser
    // before, so a direct POST bypassed it entirely.
    const { roundId, eventId } = await makeRound("333", "a", { cutoffMs: 20_000 });
    const token = await registerFor("cutoff-bypass@test.com", eventId);

    const res = await submit(roundId, token, [25_000, 26_000, 12_000, 13_000, 12_500]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("cutoff_not_met");
  });

  it("treats a result exactly equal to the cutoff as not beating it", async () => {
    // 9g1 requires strictly better than the cutoff. The client used `>`, which
    // let an exactly-equal attempt through.
    const { roundId, eventId } = await makeRound("333", "a", { cutoffMs: 20_000 });
    const token = await registerFor("cutoff-equal@test.com", eventId);

    const res = await submit(roundId, token, [20_000, 21_000, 12_000, 13_000, 12_500]);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("cutoff_not_met");
  });

  it("allows continuing when an attempt beats the cutoff", async () => {
    const { roundId, eventId } = await makeRound("333", "a", { cutoffMs: 20_000 });
    const token = await registerFor("cutoff-pass@test.com", eventId);

    const res = await submit(roundId, token, [19_999, 21_000, 12_000, 13_000, 12_500]);
    expect(res.statusCode).toBe(201);
  });

  it("accepts the short set from a competitor who failed the cutoff", async () => {
    const { roundId, eventId } = await makeRound("333", "a", { cutoffMs: 20_000 });
    const token = await registerFor("cutoff-stop@test.com", eventId);

    const res = await submit(roundId, token, [25_000, 26_000]);
    expect(res.statusCode).toBe(201);
    expect(res.json().solves).toHaveLength(2);
  });
});

describe("time limit is enforced server-side (WCA A1a4)", () => {
  it("coerces an attempt at or over the limit to a DNF", async () => {
    const { roundId, eventId } = await makeRound("333", "a", { timeLimitMs: 60_000 });
    const token = await registerFor("timelimit@test.com", eventId);

    const res = await submit(roundId, token, [12_000, 60_000, 11_000, 13_000, 12_500]);
    expect(res.statusCode).toBe(201);
    const solves = res.json().solves as { time_ms: number; penalty: string }[];
    expect(solves[1]!.penalty).toBe("dnf");
    // The other four attempts are untouched.
    expect(solves[0]!.penalty).toBe("none");
  });

  it("leaves attempts under the limit alone", async () => {
    const { roundId, eventId } = await makeRound("333", "a", { timeLimitMs: 60_000 });
    const token = await registerFor("under-limit@test.com", eventId);

    const res = await submit(roundId, token, [12_000, 59_999, 11_000, 13_000, 12_500]);
    expect(res.statusCode).toBe(201);
    const solves = res.json().solves as { penalty: string }[];
    expect(solves.every((s) => s.penalty === "none")).toBe(true);
  });
});
