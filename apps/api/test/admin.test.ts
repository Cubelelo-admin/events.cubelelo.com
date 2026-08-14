import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { createMemRepo } from "../src/db/mem-repo";
import { seed } from "../src/db/seed";
import { adminToken, bearer, devToken } from "./helpers";

let app: FastifyInstance;
let admin: string;

beforeAll(async () => {
  const repo = createMemRepo();
  await seed(repo);
  app = await buildApp(repo);
  admin = await adminToken(app);
  // Sync admin so auth plugin resolves the token
  await app.inject({ method: "POST", url: "/api/v1/auth/sync", headers: bearer(admin) });
});

async function post(url: string, payload: object, token = admin) {
  const res = await app.inject({ method: "POST", url, payload, headers: bearer(token) });
  return { status: res.statusCode, body: res.json() };
}
async function patch(url: string, payload: object, token = admin) {
  const res = await app.inject({ method: "PATCH", url, payload, headers: bearer(token) });
  return { status: res.statusCode, body: res.json() };
}
async function get(url: string, token?: string) {
  const res = await app.inject({ method: "GET", url, headers: token ? bearer(token) : {} });
  return { status: res.statusCode, body: res.json() };
}

describe("admin competition lifecycle", () => {
  let compId: string;
  let round1: string;

  it("creates a competition with an event and rounds", async () => {
    const res = await post("/api/v1/admin/competitions", {
      title: "Midweek Madness",
      type: "free",
      eventType: "333",
      roundCount: 2,
    });
    expect(res.status).toBe(201);
    compId = res.body.id;

    const detail = await get(`/api/v1/competitions/${compId}`, admin);
    expect(detail.body.status).toBe("draft");
    const event = detail.body.events[0];
    expect(event.eventType).toBe("333");
    expect(event.rounds).toHaveLength(2);
    expect(event.rounds[0].status).toBe("pending");
    expect(event.rounds[0].scrambleLocked).toBe(false);
    round1 = event.rounds[0].id;
  });

  it("rejects an invalid event type", async () => {
    const res = await post("/api/v1/admin/competitions", {
      title: "Bad",
      eventType: "not-a-cube",
    });
    expect(res.status).toBe(400);
  });

  it("generates + locks scrambles, then opens the round", async () => {
    expect((await post(`/api/v1/admin/rounds/${round1}/regenerate-scrambles`, {})).status).toBe(200);

    const detail = await get(`/api/v1/competitions/${compId}`, admin);
    const eventId = detail.body.events[0].id;
    expect(detail.body.events[0].rounds[0].scrambleLocked).toBe(true);

    // Register admin for this competition's event so scramble fetch passes
    await patch(`/api/v1/admin/competitions/${compId}`, { status: "registration_open" });
    await post(`/api/v1/competitions/${compId}/register`, { eventIds: [eventId] });

    // not open yet → scramble blocked
    expect((await get(`/api/v1/rounds/${round1}/scramble`, admin)).status).toBe(409);

    // Round status is schedule-driven: an opensAt in the past opens the round.
    const openRes = await patch(`/api/v1/admin/rounds/${round1}`, {
      opensAt: new Date(Date.now() - 1000).toISOString(),
    });
    expect(openRes.status).toBe(200);
    expect((await get(`/api/v1/rounds/${round1}`)).body.status).toBe("open");
    const scramble = await get(`/api/v1/rounds/${round1}/scramble`, admin);
    expect(scramble.status).toBe(200);
    // Ao5 round: 5 attempts + 2 WCA extras (E1, E2) reserved for extra attempts.
    expect(scramble.body.scrambles).toHaveLength(7);
  });

  it("updates competition status", async () => {
    const res = await patch(`/api/v1/admin/competitions/${compId}`, { status: "live" });
    expect(res.body.status).toBe("live");
  });
});

describe("admin RBAC", () => {
  it("rejects unauthenticated admin calls (401)", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/competitions",
      payload: { title: "x", eventType: "333" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("forbids non-admin users (403)", async () => {
    const userTok = await devToken(app, "regular@x.com");
    await app.inject({
      method: "POST",
      url: "/api/v1/auth/sync",
      headers: bearer(userTok),
    });
    const res = await post(
      "/api/v1/admin/competitions",
      { title: "x", eventType: "333" },
      userTok,
    );
    expect(res.status).toBe(403);
  });
});
