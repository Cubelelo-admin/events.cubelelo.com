import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { createMemRepo } from "../src/db/mem-repo";
import type { Repository } from "../src/db/repo";
import { seed, SEED_DEMO_COMP_ID } from "../src/db/seed";
import { adminToken, bearer, devToken, syncVerifiedUser } from "./helpers";

/**
 * `max_uses_per_user` is enforced by counting redemption rows.
 *
 * Two things defeated that. In Postgres, `promo_code_usages` carried a
 * `UNIQUE (promo_code_id, user_id)` constraint and the insert used
 * `ON CONFLICT DO NOTHING`, so the second redemption was silently not recorded
 * and the count stuck at 1 — a code allowing three uses could be redeemed
 * forever. In memory both methods were stubs, so the limit did not exist at all
 * and nothing tested it.
 */

let app: FastifyInstance;
let repo: Repository;
let admin: string;
let eventId: string;
let token: string;
let userId: string;

const order = (promo?: string) =>
  app.inject({
    method: "POST",
    url: "/api/v1/payments/order",
    payload: { competitionId: SEED_DEMO_COMP_ID, eventIds: [eventId], promoCode: promo },
    headers: bearer(token),
  });

/**
 * Complete a redemption: pay for the order, then leave the competition.
 *
 * Both steps are needed before another order can be placed — an unpaid order is
 * handed back as-is (200, promo untouched) and an active registration is
 * refused outright.
 */
async function completeAndLeave(paymentId: string) {
  const confirm = await app.inject({
    method: "POST",
    url: `/api/v1/admin/payments/${paymentId}/confirm`,
    payload: { reason: "test" },
    headers: bearer(admin),
  });
  expect(confirm.statusCode).toBe(200);

  const reg = await repo.registrations.findByUserAndComp(userId, SEED_DEMO_COMP_ID);
  if (reg) await repo.registrations.update(reg.id, { status: "withdrawn" });
}

beforeAll(async () => {
  repo = createMemRepo();
  await seed(repo);
  app = await buildApp(repo);
  admin = await adminToken(app);
  await app.inject({ method: "POST", url: "/api/v1/auth/sync", headers: bearer(admin) });

  await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/competitions/${SEED_DEMO_COMP_ID}`,
    payload: { baseFee: 10000, perEventFee: 5000 },
    headers: bearer(admin),
  });

  const events = await repo.competitionEvents.findByCompetition(SEED_DEMO_COMP_ID);
  eventId = events[0]!.id;

  token = await devToken(app, "repeat@test.com", "Repeat Buyer");
  const user = await syncVerifiedUser(app, repo, token);
  userId = user.id;
});

describe("per-user promo limits", () => {
  it("allows exactly max_uses_per_user redemptions, then refuses", async () => {
    const code = `TWICE${Date.now()}`;
    await repo.promoCodes.create({
      id: randomUUID(),
      code,
      type: "general",
      discountType: "percentage",
      discountValue: 10,
      maxUses: 0,
      maxUsesPerUser: 2,
      usedCount: 0,
      active: true,
      createdAt: new Date().toISOString(),
    });

    const promoId = (await repo.promoCodes.findByCode(code))!.id;

    const first = await order(code);
    expect(first.statusCode).toBe(201);
    expect(await repo.promoCodes.userUsageCount(promoId, userId)).toBe(1);
    await completeAndLeave(first.json().paymentId);

    const second = await order(code);
    expect(second.statusCode).toBe(201);
    // The count must actually advance — this is what the swallowed conflict broke.
    expect(await repo.promoCodes.userUsageCount(promoId, userId)).toBe(2);
    await completeAndLeave(second.json().paymentId);

    const third = await order(code);
    expect(third.statusCode).toBe(409);
    expect(third.json().error).toBe("promo_already_used");
  });

  it("refuses a single-use code on the second attempt", async () => {
    const code = `ONCE${Date.now()}`;
    await repo.promoCodes.create({
      id: randomUUID(),
      code,
      type: "general",
      discountType: "flat",
      discountValue: 1000,
      maxUses: 0,
      maxUsesPerUser: 1,
      usedCount: 0,
      active: true,
      createdAt: new Date().toISOString(),
    });

    const first = await order(code);
    expect(first.statusCode).toBe(201);
    await completeAndLeave(first.json().paymentId);

    const second = await order(code);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("promo_already_used");
  });
});
