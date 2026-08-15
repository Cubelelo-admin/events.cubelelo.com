import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { createMemRepo } from "../src/db/mem-repo";
import type { Repository } from "../src/db/repo";
import { seed, SEED_DEMO_COMP_ID } from "../src/db/seed";
import { bearer, devToken, syncVerifiedUser } from "./helpers";

/**
 * The "Not Registered" bug: the competition endpoints reported `registered: true`
 * from the bare existence of a registration row, while the scramble and submit
 * gates required `payment_status = 'paid'`. A user awaiting payment was told they
 * were in, then refused at the timer.
 *
 * Validity now lives in `registrations.status`, so these pin the two answers
 * together on a **free** competition — the case the old `countsForCompetition`
 * exemption got wrong, because it counted anyone at all on a free competition
 * while the event gate still refused them.
 */

let app: FastifyInstance;
let repo: Repository;
let token: string;
let userId: string;
let eventId: string;

beforeAll(async () => {
  repo = createMemRepo();
  await seed(repo);
  app = await buildApp(repo);

  token = await devToken(app, "pending-payment@test.com", "Pending Payer");
  const user = await syncVerifiedUser(app, repo, token);
  userId = user.id;

  const events = await repo.competitionEvents.findByCompetition(SEED_DEMO_COMP_ID);
  eventId = events[0]!.id;

  // A registration that exists but has not been paid for.
  const regId = randomUUID();
  await repo.registrations.create({
    id: regId,
    userId,
    competitionId: SEED_DEMO_COMP_ID,
    paymentStatus: "paid",
    status: "withdrawn",
    createdAt: new Date().toISOString(),
  });
  await repo.registrations.addEvent(regId, eventId);
});

describe("a withdrawn registration is not an active registration", () => {
  it("is refused by the event gate", async () => {
    expect(await repo.registrations.isRegisteredForEvent(userId, eventId)).toBe(false);
  });

  it("reports registered: false from my-progress", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}/my-progress`,
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().registered).toBe(false);
  });

  it("reports registered: false on the event detail", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}/event/${eventId}`,
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().userStatus?.registered ?? false).toBe(false);
  });

  it("is excluded from the participant list of a free competition", async () => {
    // The seeded demo competition is free — exactly where the old exemption
    // counted people the event gate would refuse.
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}/participants`,
      headers: bearer(token),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const rows = Array.isArray(body) ? body : (body.participants ?? []);
    expect(rows.some((p: { userId?: string }) => p.userId === userId)).toBe(false);
  });
});

describe("a paid registration is active", () => {
  it("passes the event gate and reports registered", async () => {
    const paidToken = await devToken(app, "paid@test.com", "Paid Cuber");
    const paid = await syncVerifiedUser(app, repo, paidToken);

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}/register`,
      payload: { eventIds: [eventId] },
      headers: bearer(paidToken),
    });
    expect(res.statusCode).toBe(201);

    expect(await repo.registrations.isRegisteredForEvent(paid.id, eventId)).toBe(true);

    const progress = await app.inject({
      method: "GET",
      url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}/my-progress`,
      headers: bearer(paidToken),
    });
    expect(progress.json().registered).toBe(true);
  });
});
