import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { createMemRepo } from "../src/db/mem-repo";
import type { Repository } from "../src/db/repo";
import { seed } from "../src/db/seed";
import { adminToken, bearer, devToken, syncVerifiedUser } from "./helpers";
import { noopRealtime } from "../src/sockets/realtime";
import { publishRound, autoPublishAt, nextRoundOf } from "../src/lib/roundPublish";
import { startRoundTicker } from "../src/lib/roundTicker";

/**
 * Rounds open on the clock whether or not anyone published.
 *
 * Since shortlisting moved to publish, an unpublished round 1 means round 2
 * opens with an empty advancement list and every competitor is refused with
 * `not_shortlisted`. The deadline is the backstop: it publishes whatever is
 * verified shortly before the next round opens, so the shortlist always exists
 * by the time competitors arrive.
 */

let app: FastifyInstance;
let repo: Repository;
let admin: string;

interface Fixture {
  compId: string;
  eventId: string;
  round1: string;
  round2: string;
  users: { id: string }[];
}

/**
 * Two rounds, four competitors, round 1 closed. `round2OpensInMinutes` places
 * the next round relative to now, which is what the deadline is derived from.
 */
async function twoRounds(opts: {
  round2OpensInMinutes?: number;
  flagOne?: boolean;
  finalOnly?: boolean;
} = {}): Promise<Fixture> {
  const { round2OpensInMinutes = 120, flagOne = false, finalOnly = false } = opts;
  const compId = randomUUID();
  const eventId = randomUUID();
  const round1 = randomUUID();
  const round2 = randomUUID();
  const now = new Date().toISOString();

  await repo.competitions.create({
    id: compId,
    title: `Auto ${randomUUID().slice(0, 8)}`,
    type: "free",
    status: "live",
    baseFee: 0,
    perEventFee: 0,
    featured: false,
    videoDeadlineMinutes: 1440,
    createdBy: "00000000-0000-0000-0000-0000000000ad",
    createdAt: now,
  });
  await repo.competitionEvents.create({
    id: eventId, competitionId: compId, eventType: "333", roundCount: finalOnly ? 1 : 2,
  });
  await repo.rounds.create({
    id: round1,
    competitionEventId: eventId,
    roundNumber: 1,
    status: "closed",
    advancementCriteria: { method: "rank", rankLimit: 2 },
  });
  if (!finalOnly) {
    await repo.rounds.create({
      id: round2,
      competitionEventId: eventId,
      roundNumber: 2,
      status: "pending",
      opensAt: new Date(Date.now() + round2OpensInMinutes * 60_000).toISOString(),
    });
  }

  const users: { id: string }[] = [];
  const times = [8000, 9000, 10000, 11000];
  for (let i = 0; i < times.length; i++) {
    const token = await devToken(app, `auto${i}-${compId.slice(0, 6)}@test.com`, `Cuber ${i}`);
    const { id } = await syncVerifiedUser(app, repo, token);
    users.push({ id });

    const regId = randomUUID();
    await repo.registrations.create({
      id: regId, userId: id, competitionId: compId,
      paymentStatus: "paid", status: "active", createdAt: now,
    });
    await repo.registrations.addEvent(regId, eventId);

    const t = times[i]!;
    await repo.results.create({
      id: randomUUID(),
      roundId: round1,
      userId: id,
      solves: [t, t, t, t, t].map((ms) => ({
        time_ms: ms, penalty: "none" as const, inspectionPenalty: "none" as const,
      })),
      bestSingleMs: t, ao5Ms: t, meanMs: t, medianMs: t, stdMs: 0,
      rank: i + 1,
      videoUrl: null,
      // Flag the *fastest* competitor, so the difference is visible: without
      // review they would have advanced first.
      flagStatus: flagOne && i === 0 ? "flagged" : "clean",
      flagReasons: [],
      submittedAt: now,
    });
  }

  return { compId, eventId, round1, round2, users };
}

const manualPublish = (roundId: string) =>
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

describe("the deadline", () => {
  it("is derived from the next round's opening time", async () => {
    const f = await twoRounds({ round2OpensInMinutes: 120 });
    await repo.systemSettings.update({ autoPublishLeadMinutes: 30 });

    const round = (await repo.rounds.findById(f.round1))!;
    const at = await autoPublishAt(repo, round);
    const next = await nextRoundOf(repo, round);

    expect(at).not.toBeNull();
    expect(at!.getTime()).toBe(new Date(next!.opensAt!).getTime() - 30 * 60_000);
  });

  it("does not exist for a final round", async () => {
    const f = await twoRounds({ finalOnly: true });
    await repo.systemSettings.update({ autoPublishLeadMinutes: 30 });

    const round = (await repo.rounds.findById(f.round1))!;
    expect(await nextRoundOf(repo, round)).toBeNull();
    expect(await autoPublishAt(repo, round)).toBeNull();
  });

  it("is off when the lead is zero", async () => {
    const f = await twoRounds();
    await repo.systemSettings.update({ autoPublishLeadMinutes: 0 });

    const round = (await repo.rounds.findById(f.round1))!;
    expect(await autoPublishAt(repo, round)).toBeNull();
  });
});

describe("publishing automatically", () => {
  it("publishes past a flagged result that a human could not", async () => {
    const f = await twoRounds({ flagOne: true });

    // A person is stopped — reviewing is their job.
    const manual = await manualPublish(f.round1);
    expect(manual.statusCode).toBe(409);
    expect(manual.json().error).toBe("results_not_verified");

    const round = (await repo.rounds.findById(f.round1))!;
    const outcome = await publishRound(repo, noopRealtime, round, {
      actorId: "system:auto-publish",
      auto: true,
    });
    expect(outcome.ok).toBe(true);
  });

  it("leaves the flagged competitor in the standings but out of the shortlist", async () => {
    const f = await twoRounds({ flagOne: true });
    const round = (await repo.rounds.findById(f.round1))!;
    await publishRound(repo, noopRealtime, round, { actorId: "sys", auto: true });

    const advanced = await repo.advancements.findByRound(f.round1);
    // The fastest was flagged, so the next two go through instead.
    expect(advanced.map((a) => a.userId)).toEqual([f.users[1]!.id, f.users[2]!.id]);
    expect(await repo.advancements.isAdvanced(f.round2, f.users[0]!.id)).toBe(false);

    // Still present in the round's results — published, just not advanced.
    const results = await repo.results.findByRound(f.round1);
    expect(results.some((r) => r.userId === f.users[0]!.id)).toBe(true);
  });

  it("records that it was automatic, not a person", async () => {
    const f = await twoRounds();
    const round = (await repo.rounds.findById(f.round1))!;
    await publishRound(repo, noopRealtime, round, { actorId: "sys", auto: true });

    const log = await repo.auditLog.findAll();
    expect(log.some((e) => e.action === "round_results_auto_published" && e.target === f.round1))
      .toBe(true);
    expect(log.some((e) => e.action === "round_results_published" && e.target === f.round1))
      .toBe(false);
  });
});

describe("the scenario this exists for", () => {
  it("round 2 admits the shortlist even though nobody published round 1", async () => {
    // Round 2 opens in a minute; the deadline passed two minutes ago.
    const f = await twoRounds({ round2OpensInMinutes: 1 });
    await repo.systemSettings.update({ autoPublishLeadMinutes: 3 });

    // Nobody has published, so nobody is admitted — the broken state.
    expect(await repo.advancements.isAdvanced(f.round2, f.users[0]!.id)).toBe(false);

    // The ticker recovers a deadline that passed while nothing was listening.
    const stop = startRoundTicker(repo, noopRealtime);
    await new Promise((r) => setTimeout(r, 300));
    stop();

    expect((await repo.rounds.findById(f.round1))!.resultsPublishedAt).toBeTruthy();
    expect(await repo.advancements.isAdvanced(f.round2, f.users[0]!.id)).toBe(true);
    expect(await repo.advancements.isAdvanced(f.round2, f.users[1]!.id)).toBe(true);
    expect(await repo.advancements.isAdvanced(f.round2, f.users[3]!.id)).toBe(false);

    stop();
  });

  it("leaves a round alone when its deadline has not arrived", async () => {
    const f = await twoRounds({ round2OpensInMinutes: 600 });
    await repo.systemSettings.update({ autoPublishLeadMinutes: 30 });

    const stop = startRoundTicker(repo, noopRealtime);
    await new Promise((r) => setTimeout(r, 300));
    stop();

    expect((await repo.rounds.findById(f.round1))!.resultsPublishedAt).toBeFalsy();
    expect(await repo.advancements.findByRound(f.round1)).toEqual([]);
  });
});
