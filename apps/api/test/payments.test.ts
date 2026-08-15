import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { createMemRepo } from "../src/db/mem-repo";
import type { Repository } from "../src/db/repo";
import { seed, SEED_DEMO_COMP_ID } from "../src/db/seed";
import { adminToken, bearer, devToken, syncVerifiedUser } from "./helpers";

let app: FastifyInstance;
let repo: Repository;
let userToken: string;
let registrationId: string;
let eventId: string;
let adminTokenValue: string;

beforeAll(async () => {
  repo = createMemRepo();
  await seed(repo);
  app = await buildApp(repo);

  // Sync admin first
  const admin = await adminToken(app);
  adminTokenValue = admin;
  await app.inject({ method: "POST", url: "/api/v1/auth/sync", headers: bearer(admin) });

  // Make the demo competition paid via admin PATCH
  await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/competitions/${SEED_DEMO_COMP_ID}`,
    payload: { baseFee: 10000, perEventFee: 5000 },
    headers: bearer(admin),
  });

  userToken = await devToken(app, "payer@test.com", "Payer");
  await syncVerifiedUser(app, repo, userToken);

  const detail = await app.inject({
    method: "GET",
    url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}`,
  });
  eventId = detail.json().events[0].id;

  // Since migration 040 the flow is payment-first: registering for a paid
  // competition creates nothing and simply quotes the fee. The registration is
  // created when the payment is fulfilled.
  const reg = await app.inject({
    method: "POST",
    url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}/register`,
    payload: { eventIds: [eventId] },
    headers: bearer(userToken),
  });
  expect(reg.statusCode).toBe(200);
  expect(reg.json().registrationId).toBeNull();
  expect(reg.json().paymentStatus).toBe("requires_payment");
});

describe("payment flow", () => {
  let paymentId: string;

  it("creates a payment order", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/payments/order",
      payload: { competitionId: SEED_DEMO_COMP_ID, eventIds: [eventId] },
      headers: bearer(userToken),
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.orderId).toMatch(/^order_/);
    expect(body.amount).toBe(15000); // 10000 + 5000*1
    paymentId = body.paymentId;
  });

  it("creates no registration while the payment is unpaid", async () => {
    const payer = await repo.users.findByEmail("payer@test.com");
    const reg = await repo.registrations.findByUserAndComp(payer!.id, SEED_DEMO_COMP_ID);
    expect(reg).toBeNull();

    // And nothing claims the user is registered.
    const progress = await app.inject({
      method: "GET",
      url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}/my-progress`,
      headers: bearer(userToken),
    });
    expect(progress.json().registered).toBe(false);
  });

  it("creates the registration once the payment is fulfilled", async () => {
    // Razorpay is not configured in tests, so the verify/webhook endpoints
    // (which need a signing secret) cannot run. The admin manual-confirm route
    // performs the same fulfilment and is the offline-payment path in its own
    // right, so it is what this exercises.
    const confirm = await app.inject({
      method: "POST",
      url: `/api/v1/admin/payments/${paymentId}/confirm`,
      payload: { reason: "test" },
      headers: bearer(adminTokenValue),
    });
    expect(confirm.statusCode).toBe(200);

    const regs = await app.inject({
      method: "GET",
      url: "/api/v1/me/registrations",
      headers: bearer(userToken),
    });
    const reg = regs.json().find(
      (r: { competitionId: string }) => r.competitionId === SEED_DEMO_COMP_ID,
    );
    expect(reg?.paymentStatus).toBe("paid");
    registrationId = reg.id;

    // The gate and the flag now agree.
    const payer = await repo.users.findByEmail("payer@test.com");
    expect(await repo.registrations.isRegisteredForEvent(payer!.id, eventId)).toBe(true);
    const progress = await app.inject({
      method: "GET",
      url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}/my-progress`,
      headers: bearer(userToken),
    });
    expect(progress.json().registered).toBe(true);
  });
});
