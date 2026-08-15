import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { createMemRepo } from "../src/db/mem-repo";
import type { Repository } from "../src/db/repo";
import type { Solve } from "@cubers/types";
import { seed, SEED_DEMO_COMP_ID } from "../src/db/seed";
import { bearer, devToken } from "./helpers";

let app: FastifyInstance;
let repo: Repository;
let roundId: string;
let claimerToken: string;
let claimerId: string;

const solves: Solve[] = [9000, 9500, 8000, 10000, 9200].map((t) => ({
  time_ms: t,
  inspectionPenalty: "none" as const,
  penalty: "none" as const,
}));

/** Insert a migrated_stub user with a result, registration, and payment. */
async function createStub(clId: string, email: string) {
  const stubId = randomUUID();
  const now = new Date().toISOString();
  await repo.users.create({
    id: stubId,
    clId,
    email,
    name: "Legacy Cuber",
    city: "Chennai",
    role: "user",
    wcaVerified: false,
    emailVerified: false,
    mobileVerified: false,
    profilePrivacy: "public",
    accountStage: "migrated_stub",
    createdAt: now,
  });
  await repo.results.create({
    id: randomUUID(),
    roundId,
    userId: stubId,
    solves,
    bestSingleMs: 8000,
    ao5Ms: 9233,
    meanMs: 9140,
    medianMs: 9200,
    stdMs: 650,
    rank: 1,
    videoUrl: null,
    flagStatus: "clean",
    flagReasons: [],
    submittedAt: now,
  });
  const registrationId = randomUUID();
  await repo.registrations.create({
    id: registrationId,
    userId: stubId,
    competitionId: SEED_DEMO_COMP_ID,
    paymentStatus: "paid",
    status: "active",
    createdAt: now,
  });
  await repo.payments.create({
    id: randomUUID(),
    userId: stubId,
    registrationId,
    amount: 10000,
    currency: "INR",
    status: "paid",
    createdAt: now,
  });
  return stubId;
}

beforeAll(async () => {
  repo = createMemRepo();
  await seed(repo);
  app = await buildApp(repo);

  const detail = await app.inject({
    method: "GET",
    url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}`,
  });
  roundId = detail.json().events[0].rounds[0].id;

  claimerToken = await devToken(app, "newlogin@test.com", "New Login");
  const sync = await app.inject({
    method: "POST",
    url: "/api/v1/auth/sync",
    headers: bearer(claimerToken),
  });
  claimerId = sync.json().id;
});

describe("migrate-claim transfers legacy history (HIGH-014)", () => {
  let stubId: string;

  it("claims a stub and moves results, registrations, and payments", async () => {
    stubId = await createStub("CL-2020-0007", "legacy@old.com");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/migrate-claim",
      payload: { legacyClId: "CL-2020-0007" },
      headers: bearer(claimerToken),
    });
    expect(res.statusCode).toBe(200);
    // Profile fields merged, own CL ID kept
    expect(res.json().city).toBe("Chennai");
    expect(res.json().clId).not.toBe("CL-2020-0007");

    // History now belongs to the claimer; nothing left on the stub
    expect(await repo.results.findByUser(claimerId)).toHaveLength(1);
    expect(await repo.results.findByUser(stubId)).toHaveLength(0);
    expect(await repo.registrations.findByUser(claimerId)).toHaveLength(1);
    expect(await repo.registrations.findByUser(stubId)).toHaveLength(0);
    const payments = await repo.payments.findAll();
    expect(payments.filter((p) => p.userId === claimerId)).toHaveLength(1);
    expect(payments.filter((p) => p.userId === stubId)).toHaveLength(0);

    // PB rebuilt from the transferred result
    const pb = (await repo.personalBests.findByUser(claimerId)).find(
      (p) => p.eventType === "333",
    );
    expect(pb?.bestAo5Ms).toBe(9233);
    expect(pb?.bestSingleMs).toBe(8000);

    // Stub is banned after the claim
    expect((await repo.users.findById(stubId))?.accountStage).toBe("banned");
  });

  it("skips rows that collide with the claimer's own history", async () => {
    // The claimer now owns a result in the seed round and a registration for
    // the seed competition (from the first claim) — a second stub with the
    // same round/competition must not displace them.
    const stub2 = await createStub("CL-2020-0042", "legacy2@old.com");

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/migrate-claim",
      payload: { legacyClId: "CL-2020-0042" },
      headers: bearer(claimerToken),
    });
    expect(res.statusCode).toBe(200);

    // Conflicting result/registration stayed on the stub; payment still moved
    expect(await repo.results.findByUser(claimerId)).toHaveLength(1);
    expect(await repo.results.findByUser(stub2)).toHaveLength(1);
    expect(await repo.registrations.findByUser(claimerId)).toHaveLength(1);
    expect(await repo.registrations.findByUser(stub2)).toHaveLength(1);
    const payments = await repo.payments.findAll();
    expect(payments.filter((p) => p.userId === claimerId)).toHaveLength(2);
  });

  it("rejects claiming an active (non-stub) account", async () => {
    const otherTok = await devToken(app, "active@test.com", "Active User");
    const sync = await app.inject({
      method: "POST",
      url: "/api/v1/auth/sync",
      headers: bearer(otherTok),
    });
    const activeClId = sync.json().clId;

    const res = await app.inject({
      method: "POST",
      url: "/api/v1/auth/migrate-claim",
      payload: { legacyClId: activeClId },
      headers: bearer(claimerToken),
    });
    expect(res.statusCode).toBe(409);
  });
});
