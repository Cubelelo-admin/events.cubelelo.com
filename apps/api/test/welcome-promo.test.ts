import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { createMemRepo } from "../src/db/mem-repo";
import type { Repository } from "../src/db/repo";
import { seed, SEED_DEMO_COMP_ID } from "../src/db/seed";
import { adminToken, bearer, devToken, syncVerifiedUser } from "./helpers";

/**
 * The welcome promo is a first-order benefit, so "have you bought before?" has
 * to be asked of payments.
 *
 * It used to be asked of registrations — `hasPaidRegistration` — and free
 * competitions write `payment_status = 'paid'` on their registration rows. So
 * joining a single free competition looked like a purchase and silently burned
 * a welcome promo the competitor had never used.
 */

let app: FastifyInstance;
let repo: Repository;
let admin: string;
let eventId: string;
let promoCode: string;

/** Price the demo competition so orders go through the payment path. */
async function makePaid() {
  await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/competitions/${SEED_DEMO_COMP_ID}`,
    payload: { baseFee: 10000, perEventFee: 5000 },
    headers: bearer(admin),
  });
}

const order = (token: string, promo?: string) =>
  app.inject({
    method: "POST",
    url: "/api/v1/payments/order",
    payload: { competitionId: SEED_DEMO_COMP_ID, eventIds: [eventId], promoCode: promo },
    headers: bearer(token),
  });

beforeAll(async () => {
  repo = createMemRepo();
  await seed(repo);
  app = await buildApp(repo);
  admin = await adminToken(app);
  await app.inject({ method: "POST", url: "/api/v1/auth/sync", headers: bearer(admin) });

  const events = await repo.competitionEvents.findByCompetition(SEED_DEMO_COMP_ID);
  eventId = events[0]!.id;

  promoCode = `WELCOME${Date.now()}`;
  await repo.promoCodes.create({
    id: randomUUID(),
    code: promoCode,
    type: "welcome",
    discountType: "percentage",
    discountValue: 50,
    maxUses: 0,
    maxUsesPerUser: 0,
    usedCount: 0,
    active: true,
    createdAt: new Date().toISOString(),
  });
});

describe("the welcome promo", () => {
  it("still applies after joining a free competition", async () => {
    const token = await devToken(app, "freejoiner@test.com", "Free Joiner");
    await syncVerifiedUser(app, repo, token);

    // Join while it is free — this writes a registration marked `paid`.
    const reg = await app.inject({
      method: "POST",
      url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}/register`,
      payload: { eventIds: [eventId] },
      headers: bearer(token),
    });
    expect(reg.statusCode).toBe(201);
    expect(reg.json().paymentStatus).toBe("paid");

    // No money has actually changed hands.
    const user = await repo.users.findByEmail("freejoiner@test.com");
    expect(await repo.payments.hasCompletedPayment(user!.id)).toBe(false);

    // So a paid order must still honour the welcome promo. (The free
    // registration is cleared first, or the order is refused for being already
    // registered before the promo is even looked at.)
    await repo.registrations.update(
      (await repo.registrations.findByUserAndComp(user!.id, SEED_DEMO_COMP_ID))!.id,
      { status: "withdrawn" },
    );
    await makePaid();
    const res = await order(token, promoCode);
    expect(res.statusCode).toBe(201);
    expect(res.json().amount).toBeLessThan(15000);
  });

  it("is refused once the competitor has actually paid for something", async () => {
    await makePaid();
    const token = await devToken(app, "buyer@test.com", "Buyer");
    const user = await syncVerifiedUser(app, repo, token);

    const first = await order(token);
    expect(first.statusCode).toBe(201);
    await app.inject({
      method: "POST",
      url: `/api/v1/admin/payments/${first.json().paymentId}/confirm`,
      payload: { reason: "test" },
      headers: bearer(admin),
    });

    expect(await repo.payments.hasCompletedPayment(user.id)).toBe(true);

    // Second competition, welcome promo — they are no longer new.
    await repo.registrations.update(
      (await repo.registrations.findByUserAndComp(user.id, SEED_DEMO_COMP_ID))!.id,
      { status: "withdrawn" },
    );
    const res = await order(token, promoCode);
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("promo_welcome_only");
  });
});
