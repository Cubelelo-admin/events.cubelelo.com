import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { createMemRepo } from "../src/db/mem-repo";
import type { Repository } from "../src/db/repo";
import { seed } from "../src/db/seed";
import { adminToken, bearer, devToken, syncVerifiedUser } from "./helpers";

/**
 * Publishing a round is what finalises it.
 *
 * The standings freeze, the shortlist is computed from them, and only then do
 * competitors move on. This used to happen on its own — the instant the last
 * flagged result was verified, three separate places raced to advance people,
 * before any human confirmed the results.
 *
 * These run on the in-memory backend, which was impossible until advancement
 * writes moved off raw SQL and onto the repository: `shortlistRound` needed a
 * live Postgres pool, so the entire persistence path had no coverage.
 */

let app: FastifyInstance;
let repo: Repository;
let admin: string;

interface Fixture {
  compId: string;
  eventId: string;
  round1: string;
  round2: string;
  /** Fastest first. */
  users: { id: string; token: string }[];
}

/** A competition with one event, two rounds, and four competitors in round 1. */
async function competitionWithTwoRounds(flagFirstResult = false): Promise<Fixture> {
  const compId = randomUUID();
  const eventId = randomUUID();
  const round1 = randomUUID();
  const round2 = randomUUID();
  const now = new Date().toISOString();

  await repo.competitions.create({
    id: compId,
    title: `Publish Test ${randomUUID().slice(0, 8)}`,
    type: "free",
    status: "registration_open",
    baseFee: 0,
    perEventFee: 0,
    featured: false,
    videoDeadlineMinutes: 1440,
    createdAt: now,
  });
  await repo.competitionEvents.create({
    id: eventId,
    competitionId: compId,
    eventType: "333",
    roundCount: 2,
  });
  // No opensAt: `effectiveRoundStatus` then returns the stored status verbatim,
  // which keeps these fixtures independent of the clock.
  await repo.rounds.create({
    id: round1,
    competitionEventId: eventId,
    roundNumber: 1,
    status: "closed",
    advancementCriteria: { method: "rank", rankLimit: 2 },
  });
  await repo.rounds.create({
    id: round2,
    competitionEventId: eventId,
    roundNumber: 2,
    status: "pending",
  });

  const users: { id: string; token: string }[] = [];
  const times = [8000, 9000, 10000, 11000]; // fastest first
  for (let i = 0; i < times.length; i++) {
    const token = await devToken(app, `pub${i}-${compId.slice(0, 6)}@test.com`, `Cuber ${i}`);
    const { id } = await syncVerifiedUser(app, repo, token);
    users.push({ id, token });

    const regId = randomUUID();
    await repo.registrations.create({
      id: regId,
      userId: id,
      competitionId: compId,
      paymentStatus: "paid",
      status: "active",
      createdAt: now,
    });
    await repo.registrations.addEvent(regId, eventId);

    const t = times[i]!;
    await repo.results.create({
      id: randomUUID(),
      roundId: round1,
      userId: id,
      solves: [t, t, t, t, t].map((ms) => ({
        time_ms: ms,
        penalty: "none" as const,
        inspectionPenalty: "none" as const,
      })),
      bestSingleMs: t,
      ao5Ms: t,
      meanMs: t,
      medianMs: t,
      stdMs: 0,
      rank: i + 1,
      videoUrl: null,
      flagStatus: flagFirstResult && i === 0 ? "flagged" : "clean",
      flagReasons: [],
      submittedAt: now,
    });
  }

  return { compId, eventId, round1, round2, users };
}

const publish = (roundId: string) =>
  app.inject({
    method: "POST",
    url: `/api/v1/admin/rounds/${roundId}/publish`,
    headers: bearer(admin),
  });

beforeEach(async () => {
  repo = createMemRepo();
  await seed(repo);
  app = await buildApp(repo);
  admin = await adminToken(app);
  await app.inject({ method: "POST", url: "/api/v1/auth/sync", headers: bearer(admin) });
});

describe("publishing a round", () => {
  it("freezes the results, shortlists, and admits exactly those competitors", async () => {
    const f = await competitionWithTwoRounds();

    // Nobody has advanced before publishing.
    expect(await repo.advancements.findByRound(f.round1)).toEqual([]);

    const res = await publish(f.round1);
    expect(res.statusCode).toBe(200);

    const body = res.json();
    expect(body.advancedCount).toBe(2);
    expect(body.advanced.map((a: { rank: number }) => a.rank)).toEqual([1, 2]);

    // The results are final.
    expect((await repo.rounds.findById(f.round1))!.resultsPublishedAt).toBeTruthy();
    // The round is claimed, so a second publish cannot re-advance anyone.
    expect((await repo.rounds.findById(f.round1))!.status).toBe("advanced");

    // The shortlist is actually saved — the assertion that had no coverage.
    const saved = await repo.advancements.findByRound(f.round1);
    expect(saved.map((a) => a.userId)).toEqual([f.users[0]!.id, f.users[1]!.id]);

    // Round 2 admits the two who advanced and refuses the two who did not.
    expect(await repo.advancements.isAdvanced(f.round2, f.users[0]!.id)).toBe(true);
    expect(await repo.advancements.isAdvanced(f.round2, f.users[1]!.id)).toBe(true);
    expect(await repo.advancements.isAdvanced(f.round2, f.users[2]!.id)).toBe(false);
    expect(await repo.advancements.isAdvanced(f.round2, f.users[3]!.id)).toBe(false);
  });

  it("refuses a round that is still open", async () => {
    const f = await competitionWithTwoRounds();
    await repo.rounds.update(f.round1, { status: "open" });

    const res = await publish(f.round1);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("round_not_closed");
    expect(await repo.advancements.findByRound(f.round1)).toEqual([]);
  });

  it("refuses while a result is still flagged", async () => {
    const f = await competitionWithTwoRounds(true);

    const res = await publish(f.round1);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("results_not_verified");
    expect(await repo.advancements.findByRound(f.round1)).toEqual([]);
  });

  it("refuses to publish twice", async () => {
    const f = await competitionWithTwoRounds();
    expect((await publish(f.round1)).statusCode).toBe(200);

    const second = await publish(f.round1);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("already_published");
  });

  it("records who published and how many advanced", async () => {
    const f = await competitionWithTwoRounds();
    await publish(f.round1);

    const log = await repo.auditLog.findAll();
    const entry = log.find((e) => e.action === "round_results_published" && e.target === f.round1);
    expect(entry).toBeDefined();
    expect(entry!.reason).toContain("2");
  });
});

describe("a failed save does not strand the round", () => {
  it("hands the round back to closed rather than leaving it advanced with no list", async () => {
    const f = await competitionWithTwoRounds();

    // The claim succeeds, the save does not. Without the compensating revert the
    // round would read `advanced` while admitting nobody to round 2.
    const realSave = repo.advancements.save;
    repo.advancements.save = async () => {
      throw new Error("save failed");
    };

    const res = await publish(f.round1);
    expect(res.statusCode).toBe(500);

    repo.advancements.save = realSave;

    expect((await repo.rounds.findById(f.round1))!.status).toBe("closed");
    expect(await repo.advancements.findByRound(f.round1)).toEqual([]);
    expect(await repo.advancements.isAdvanced(f.round2, f.users[0]!.id)).toBe(false);

    // And the round is not marked published, or every retry would be refused as
    // `already_published` and it could never be published at all.
    expect((await repo.rounds.findById(f.round1))!.resultsPublishedAt).toBeFalsy();
  });

  it("can still be published after a failed attempt", async () => {
    const f = await competitionWithTwoRounds();

    const realSave = repo.advancements.save;
    repo.advancements.save = async () => {
      throw new Error("save failed");
    };
    expect((await publish(f.round1)).statusCode).toBe(500);
    repo.advancements.save = realSave;

    // The retry has to work — this is the whole point of the revert.
    const retry = await publish(f.round1);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().advancedCount).toBe(2);
    expect((await repo.rounds.findById(f.round1))!.resultsPublishedAt).toBeTruthy();
  });
});

describe("verification no longer advances anyone", () => {
  it("clearing the last flagged result leaves the shortlist empty", async () => {
    const f = await competitionWithTwoRounds(true);

    const flagged = (await repo.results.findByRound(f.round1)).find(
      (r) => r.flagStatus === "flagged",
    )!;

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/results/${flagged.id}/verify`,
      payload: { action: "verified" },
      headers: bearer(admin),
    });
    expect(res.statusCode).toBe(200);

    // Nothing verified into an advancement — this is the behaviour change.
    expect(await repo.advancements.findByRound(f.round1)).toEqual([]);
    expect((await repo.rounds.findById(f.round1))!.status).toBe("closed");
    expect(await repo.advancements.isAdvanced(f.round2, f.users[0]!.id)).toBe(false);

    // Publishing afterwards still works, and is now the only way through.
    expect((await publish(f.round1)).statusCode).toBe(200);
    expect((await repo.advancements.findByRound(f.round1)).length).toBe(2);
  });
});

describe("auto-completion judges the round by effective status", () => {
  it("completes a single-round competition even when the stored status still says open", async () => {
    // Reproduces the pre-ticker window: the round's close time has passed (so
    // publishing is allowed and effectiveRoundStatus === 'closed'), but the
    // stored `status` column is still 'open' because the 60s ticker has not yet
    // persisted the close. Reading the stored column here used to skip
    // completion and never retry it.
    const compId = randomUUID();
    const eventId = randomUUID();
    const roundId = randomUUID();
    const now = new Date().toISOString();
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const morePast = new Date(Date.now() - 7_200_000).toISOString();

    await repo.competitions.create({
      id: compId,
      title: `Complete Test ${randomUUID().slice(0, 8)}`,
      type: "free",
      status: "live",
      baseFee: 0,
      perEventFee: 0,
      featured: false,
      videoDeadlineMinutes: 1440,
      createdAt: now,
    });
    await repo.competitionEvents.create({
      id: eventId,
      competitionId: compId,
      eventType: "333",
      roundCount: 1,
    });
    // Stored status stays "open"; the past closesAt makes it effectively closed.
    await repo.rounds.create({
      id: roundId,
      competitionEventId: eventId,
      roundNumber: 1,
      status: "open",
      opensAt: morePast,
      closesAt: past,
    });

    const token = await devToken(app, `complete-${compId.slice(0, 6)}@test.com`, "Finisher");
    const { id: userId } = await syncVerifiedUser(app, repo, token);
    const regId = randomUUID();
    await repo.registrations.create({
      id: regId, userId, competitionId: compId, paymentStatus: "paid", status: "active", createdAt: now,
    });
    await repo.registrations.addEvent(regId, eventId);
    await repo.results.create({
      id: randomUUID(),
      roundId,
      userId,
      solves: [8000, 8000, 8000, 8000, 8000].map((ms) => ({
        time_ms: ms, penalty: "none" as const, inspectionPenalty: "none" as const,
      })),
      bestSingleMs: 8000, ao5Ms: 8000, meanMs: 8000, medianMs: 8000, stdMs: 0,
      rank: 1, videoUrl: null, flagStatus: "clean", flagReasons: [], submittedAt: now,
    });

    // Sanity: stored status is still "open" going into publish.
    expect((await repo.rounds.findById(roundId))!.status).toBe("open");

    const res = await publish(roundId);
    expect(res.statusCode).toBe(200);
    expect(res.json().competitionCompleted).toBe(true);
    expect((await repo.competitions.findById(compId))!.status).toBe("completed");
  });
});

describe("multi-event completion waits for every event to be published", () => {
  it("does not complete the competition after publishing only one of several events", async () => {
    // Two events. Both rounds already ran (closed, clean results), so the ONLY
    // thing separating "done" from "not done" is publication. Publishing event A
    // must not complete the competition while event B is unpublished.
    const compId = randomUUID();
    const eventA = randomUUID();
    const eventB = randomUUID();
    const roundA = randomUUID();
    const roundB = randomUUID();
    const now = new Date().toISOString();
    const past = new Date(Date.now() - 3_600_000).toISOString();
    const morePast = new Date(Date.now() - 7_200_000).toISOString();

    await repo.competitions.create({
      id: compId, title: `Multi ${randomUUID().slice(0, 8)}`, type: "free",
      status: "live", baseFee: 0, perEventFee: 0, featured: false,
      videoDeadlineMinutes: 1440, createdAt: now,
    });

    for (const [eventId, roundId, ev] of [[eventA, roundA, "333"], [eventB, roundB, "222"]] as const) {
      await repo.competitionEvents.create({
        id: eventId, competitionId: compId, eventType: ev, roundCount: 1,
      });
      // Effectively closed (past closesAt) with a clean result — but NOT published.
      await repo.rounds.create({
        id: roundId, competitionEventId: eventId, roundNumber: 1,
        status: "open", opensAt: morePast, closesAt: past,
      });
      const token = await devToken(app, `${ev}-${compId.slice(0, 6)}@test.com`, `Cuber ${ev}`);
      const { id: userId } = await syncVerifiedUser(app, repo, token);
      const regId = randomUUID();
      await repo.registrations.create({
        id: regId, userId, competitionId: compId, paymentStatus: "paid", status: "active", createdAt: now,
      });
      await repo.registrations.addEvent(regId, eventId);
      await repo.results.create({
        id: randomUUID(), roundId, userId,
        solves: [8000, 8000, 8000, 8000, 8000].map((ms) => ({
          time_ms: ms, penalty: "none" as const, inspectionPenalty: "none" as const,
        })),
        bestSingleMs: 8000, ao5Ms: 8000, meanMs: 8000, medianMs: 8000, stdMs: 0,
        rank: 1, videoUrl: null, flagStatus: "clean", flagReasons: [], submittedAt: now,
      });
    }

    // Publish only event A.
    const res = await publish(roundA);
    expect(res.statusCode).toBe(200);
    expect(res.json().competitionCompleted).toBe(false);
    expect((await repo.competitions.findById(compId))!.status).not.toBe("completed");

    // Now publish event B — the competition completes.
    const res2 = await publish(roundB);
    expect(res2.statusCode).toBe(200);
    expect(res2.json().competitionCompleted).toBe(true);
    expect((await repo.competitions.findById(compId))!.status).toBe("completed");
  });
});

describe("publishing requires shortlisting criteria when a next round exists", () => {
  it("refuses to publish a non-final round that has no advancement criteria", async () => {
    const compId = randomUUID();
    const eventId = randomUUID();
    const round1 = randomUUID();
    const round2 = randomUUID();
    const now = new Date().toISOString();

    await repo.competitions.create({
      id: compId, title: `NoCrit ${randomUUID().slice(0, 8)}`, type: "free",
      status: "live", baseFee: 0, perEventFee: 0, featured: false,
      videoDeadlineMinutes: 1440, createdAt: now,
    });
    await repo.competitionEvents.create({
      id: eventId, competitionId: compId, eventType: "333", roundCount: 2,
    });
    // Round 1 is closed with a clean result but has NO advancementCriteria.
    await repo.rounds.create({
      id: round1, competitionEventId: eventId, roundNumber: 1, status: "closed",
    });
    await repo.rounds.create({
      id: round2, competitionEventId: eventId, roundNumber: 2, status: "pending",
    });
    const token = await devToken(app, `nocrit-${compId.slice(0, 6)}@test.com`, "Cuber");
    const { id: userId } = await syncVerifiedUser(app, repo, token);
    const regId = randomUUID();
    await repo.registrations.create({
      id: regId, userId, competitionId: compId, paymentStatus: "paid", status: "active", createdAt: now,
    });
    await repo.registrations.addEvent(regId, eventId);
    await repo.results.create({
      id: randomUUID(), roundId: round1, userId,
      solves: [8000, 8000, 8000, 8000, 8000].map((ms) => ({
        time_ms: ms, penalty: "none" as const, inspectionPenalty: "none" as const,
      })),
      bestSingleMs: 8000, ao5Ms: 8000, meanMs: 8000, medianMs: 8000, stdMs: 0,
      rank: 1, videoUrl: null, flagStatus: "clean", flagReasons: [], submittedAt: now,
    });

    const res = await publish(round1);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("advancement_criteria_required");
    // Nothing was published or advanced.
    expect((await repo.rounds.findById(round1))!.resultsPublishedAt).toBeFalsy();
    expect(await repo.advancements.findByRound(round1)).toEqual([]);
  });

  it("allows publishing a FINAL round with no criteria", async () => {
    // The existing single-round completion test already covers this, but assert
    // it directly: a round with no next round needs no criteria.
    const compId = randomUUID();
    const eventId = randomUUID();
    const roundId = randomUUID();
    const now = new Date().toISOString();
    await repo.competitions.create({
      id: compId, title: `Final ${randomUUID().slice(0, 8)}`, type: "free",
      status: "live", baseFee: 0, perEventFee: 0, featured: false,
      videoDeadlineMinutes: 1440, createdAt: now,
    });
    await repo.competitionEvents.create({
      id: eventId, competitionId: compId, eventType: "333", roundCount: 1,
    });
    await repo.rounds.create({
      id: roundId, competitionEventId: eventId, roundNumber: 1, status: "closed",
    });
    const token = await devToken(app, `final-${compId.slice(0, 6)}@test.com`, "Cuber");
    const { id: userId } = await syncVerifiedUser(app, repo, token);
    const regId = randomUUID();
    await repo.registrations.create({
      id: regId, userId, competitionId: compId, paymentStatus: "paid", status: "active", createdAt: now,
    });
    await repo.registrations.addEvent(regId, eventId);
    await repo.results.create({
      id: randomUUID(), roundId, userId,
      solves: [8000, 8000, 8000, 8000, 8000].map((ms) => ({
        time_ms: ms, penalty: "none" as const, inspectionPenalty: "none" as const,
      })),
      bestSingleMs: 8000, ao5Ms: 8000, meanMs: 8000, medianMs: 8000, stdMs: 0,
      rank: 1, videoUrl: null, flagStatus: "clean", flagReasons: [], submittedAt: now,
    });

    const res = await publish(roundId);
    expect(res.statusCode).toBe(200);
  });
});
