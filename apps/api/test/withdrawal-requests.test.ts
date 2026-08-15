import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { createMemRepo } from "../src/db/mem-repo";
import type { Repository } from "../src/db/repo";
import { seed, SEED_DEMO_COMP_ID } from "../src/db/seed";
import { adminToken, bearer, devToken, syncVerifiedUser } from "./helpers";

/**
 * Leaving a paid competition.
 *
 * Money changed hands, so an organiser decides — but the API used to say
 * "contact the organiser" and give the competitor no way to do it. This is the
 * appeals flow applied to registrations, and these tests hold it to the same
 * contract: one open request at a time, moderator scoping, and an approval that
 * actually changes something.
 */

let app: FastifyInstance;
let repo: Repository;
let admin: string;
let eventId: string;
let compId: string;

const requestWithdrawal = (token: string, registrationId: string, reason = "cannot attend") =>
  app.inject({
    method: "POST",
    url: "/api/v1/withdrawal-requests",
    payload: { registrationId, reason },
    headers: bearer(token),
  });

const resolve = (id: string, action: "approved" | "rejected", token = admin) =>
  app.inject({
    method: "POST",
    url: `/api/v1/admin/withdrawal-requests/${id}/resolve`,
    payload: { action, adminResponse: "refund issued" },
    headers: bearer(token),
  });

/** Register + pay, since a paid competition creates nothing until fulfilment. */
async function paidCompetitor(email: string) {
  const token = await devToken(app, email, email.split("@")[0]);
  const user = await syncVerifiedUser(app, repo, token);

  const order = await app.inject({
    method: "POST",
    url: "/api/v1/payments/order",
    payload: { competitionId: compId, eventIds: [eventId] },
    headers: bearer(token),
  });
  expect(order.statusCode).toBe(201);

  const confirm = await app.inject({
    method: "POST",
    url: `/api/v1/admin/payments/${order.json().paymentId}/confirm`,
    payload: { reason: "test" },
    headers: bearer(admin),
  });
  expect(confirm.statusCode).toBe(200);

  const reg = await repo.registrations.findByUserAndComp(user.id, compId);
  return { token, id: user.id, regId: reg!.id };
}

beforeAll(async () => {
  repo = createMemRepo();
  await seed(repo);
  app = await buildApp(repo);
  admin = await adminToken(app);
  await app.inject({ method: "POST", url: "/api/v1/auth/sync", headers: bearer(admin) });

  compId = SEED_DEMO_COMP_ID;
  await app.inject({
    method: "PATCH",
    url: `/api/v1/admin/competitions/${compId}`,
    payload: { baseFee: 10000, perEventFee: 5000 },
    headers: bearer(admin),
  });

  const events = await repo.competitionEvents.findByCompetition(compId);
  eventId = events[0]!.id;
});

describe("requesting withdrawal from a paid competition", () => {
  it("creates a request and shows it to the competitor", async () => {
    const { token, regId } = await paidCompetitor("payer1@test.com");

    const res = await requestWithdrawal(token, regId);
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe("pending");

    const mine = await app.inject({
      method: "GET",
      url: "/api/v1/me/withdrawal-requests",
      headers: bearer(token),
    });
    expect(mine.json()).toHaveLength(1);
    expect(mine.json()[0].competitionTitle).toBeTruthy();
  });

  it("allows only one open request per registration", async () => {
    const { token, regId } = await paidCompetitor("payer2@test.com");
    expect((await requestWithdrawal(token, regId)).statusCode).toBe(201);

    const second = await requestWithdrawal(token, regId);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("request_already_submitted");
  });

  it("refuses a request for someone else's registration", async () => {
    const { regId } = await paidCompetitor("payer3@test.com");
    const { token: other } = await paidCompetitor("payer4@test.com");

    const res = await requestWithdrawal(other, regId);
    expect(res.statusCode).toBe(403);
  });

  it("requires a reason", async () => {
    const { token, regId } = await paidCompetitor("payer5@test.com");
    const res = await requestWithdrawal(token, regId, "   ");
    expect(res.statusCode).toBe(400);
  });
});

describe("resolving a request", () => {
  it("approving withdraws the registration and frees the competitor", async () => {
    const { token, id, regId } = await paidCompetitor("approve@test.com");
    const requestId = (await requestWithdrawal(token, regId)).json().id;

    expect(await repo.registrations.isRegisteredForEvent(id, eventId)).toBe(true);

    const res = await resolve(requestId, "approved");
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("approved");

    expect((await repo.registrations.findById(regId))!.status).toBe("withdrawn");
    expect(await repo.registrations.isRegisteredForEvent(id, eventId)).toBe(false);

    const log = await repo.auditLog.findAll();
    expect(log.some((e) => e.action === "withdrawal_approved" && e.target === regId)).toBe(true);
  });

  it("rejecting leaves the registration standing", async () => {
    const { token, id, regId } = await paidCompetitor("reject@test.com");
    const requestId = (await requestWithdrawal(token, regId)).json().id;

    expect((await resolve(requestId, "rejected")).statusCode).toBe(200);

    expect((await repo.registrations.findById(regId))!.status).toBe("active");
    expect(await repo.registrations.isRegisteredForEvent(id, eventId)).toBe(true);
  });

  it("refuses to resolve the same request twice", async () => {
    const { token, regId } = await paidCompetitor("twice2@test.com");
    const requestId = (await requestWithdrawal(token, regId)).json().id;

    expect((await resolve(requestId, "approved")).statusCode).toBe(200);
    const again = await resolve(requestId, "rejected");
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe("request_already_resolved");
  });

  it("refuses a moderator who does not own the competition", async () => {
    const { token, regId } = await paidCompetitor("modscope@test.com");
    const requestId = (await requestWithdrawal(token, regId)).json().id;

    const modToken = await devToken(app, "outsider-mod2@test.com", "Outsider Mod");
    const mod = await syncVerifiedUser(app, repo, modToken);
    await repo.users.update(mod.id, { role: "moderator" });

    const res = await resolve(requestId, "approved", modToken);
    expect(res.statusCode).toBe(403);
  });
});

describe("the admin list", () => {
  it("carries the payment detail an organiser needs to refund by hand", async () => {
    const { token, regId } = await paidCompetitor("detail@test.com");
    await requestWithdrawal(token, regId);

    const res = await app.inject({
      method: "GET",
      url: "/api/v1/admin/withdrawal-requests?status=pending",
      headers: bearer(admin),
    });
    expect(res.statusCode).toBe(200);

    const row = res.json().data.find((w: { registrationId: string }) => w.registrationId === regId);
    expect(row).toBeDefined();
    expect(row.userEmail).toBe("detail@test.com");
    expect(row.paymentAmount).toBeGreaterThan(0);
    expect(row.paymentId).toBeTruthy();
    expect(row.eventTypes.length).toBeGreaterThan(0);
    expect(row.reason).toBe("cannot attend");
  });
});
