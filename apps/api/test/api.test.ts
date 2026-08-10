import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { createMemRepo } from "../src/db/mem-repo";
import type { Repository } from "../src/db/repo";
import { seed, SEED_DEMO_COMP_ID } from "../src/db/seed";
import { adminToken, bearer, devToken, syncVerifiedUser } from "./helpers";

let app: FastifyInstance;
let repo: Repository;
let roundId: string;
let eventId: string;
let admin: string;

beforeAll(async () => {
  repo = createMemRepo();
  await seed(repo);
  app = await buildApp(repo);
  admin = await adminToken(app);

  // Sync admin user so auth plugin can resolve the token
  await app.inject({ method: "POST", url: "/api/v1/auth/sync", headers: bearer(admin) });

  // Resolve event + round IDs
  const detail = await app.inject({ method: "GET", url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}` });
  const comp = detail.json();
  eventId = comp.events[0].id;
  roundId = comp.events[0].rounds[0].id;

  // Register admin for the event so scramble tests pass
  await app.inject({
    method: "POST",
    url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}/register`,
    payload: { eventIds: [eventId] },
    headers: bearer(admin),
  });
});

async function getJson(url: string) {
  const res = await app.inject({ method: "GET", url });
  return { status: res.statusCode, body: res.json() };
}
async function getAuth(url: string, token: string) {
  const res = await app.inject({ method: "GET", url, headers: bearer(token) });
  return { status: res.statusCode, body: res.json() };
}
async function postJson(url: string, payload: object, headers?: Record<string, string>) {
  const res = await app.inject({ method: "POST", url, payload, headers });
  return { status: res.statusCode, body: res.json() };
}
async function patchJson(url: string, payload: object, headers?: Record<string, string>) {
  const res = await app.inject({ method: "PATCH", url, payload, headers });
  return { status: res.statusCode, body: res.json() };
}

/** Sync a user and register them for the seeded demo event so they can submit. */
async function loginAndRegister(email: string): Promise<{ token: string; id: string; clId: string }> {
  const token = await devToken(app, email);
  const { id, clId } = await syncVerifiedUser(app, repo, token);
  await app.inject({
    method: "POST",
    url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}/register`,
    payload: { eventIds: [eventId] },
    headers: bearer(token),
  });
  return { token, id, clId };
}

describe("health + competitions", () => {
  it("GET /health", async () => {
    // /health redirects to /api/v1/health; app.inject doesn't follow redirects
    expect((await getJson("/api/v1/health")).body).toMatchObject({ status: "ok" });
  });

  it("lists the seeded demo competition", async () => {
    const { body } = await getJson("/api/v1/competitions");
    expect(body.some((c: { id: string }) => c.id === SEED_DEMO_COMP_ID)).toBe(true);
  });

  it("returns demo detail with a 3x3 round, and resolves the round id", async () => {
    const { status, body } = await getJson(`/api/v1/competitions/${SEED_DEMO_COMP_ID}`);
    expect(status).toBe(200);
    const event = body.events.find((e: { eventType: string }) => e.eventType === "333");
    expect(event).toBeTruthy();
    roundId = event.rounds[0].id;
    expect(roundId).toBeTruthy();
  });

  it("404s an unknown competition", async () => {
    expect((await getJson("/api/v1/competitions/00000000-0000-0000-0000-999999999999")).status).toBe(404);
  });
});

describe("server-locked scrambles", () => {
  it("serves 5 scrambles for the open, locked round", async () => {
    const { status, body } = await getAuth(`/api/v1/rounds/${roundId}/scramble`, admin);
    expect(status).toBe(200);
    expect(body.scrambles).toHaveLength(5);
    expect(body.scrambles[0].length).toBeGreaterThan(0);
  });

  it("blocks scrambles for a closed round (409), then serves again once reopened", async () => {
    // Round status is schedule-driven: a closesAt in the past closes the round.
    const { body: round } = await getJson(`/api/v1/rounds/${roundId}`);
    const justAfterOpen = new Date(+new Date(round.opensAt) + 1).toISOString();
    const closeRes = await patchJson(
      `/api/v1/admin/rounds/${roundId}`,
      { closesAt: justAfterOpen },
      bearer(admin),
    );
    expect(closeRes.status).toBe(200);
    expect((await getAuth(`/api/v1/rounds/${roundId}/scramble`, admin)).status).toBe(409);

    // Pushing closesAt into the future reopens it.
    const inAnHour = new Date(Date.now() + 3_600_000).toISOString();
    await patchJson(`/api/v1/admin/rounds/${roundId}`, { closesAt: inAnHour }, bearer(admin));
    expect((await getAuth(`/api/v1/rounds/${roundId}/scramble`, admin)).status).toBe(200);
  });
});

describe("result submission + ranking", () => {
  it("requires authentication", async () => {
    const res = await postJson(`/api/v1/rounds/${roundId}/results`, {
      solves: [8000, 9000, 7000, 10000, 8500].map((t) => ({ time_ms: t, inspectionPenalty: "none", penalty: "none" })),
    });
    expect(res.status).toBe(401);
  });

  it("ranks the faster competitor first", async () => {
    const slow = await loginAndRegister("slow@x.com");
    const fast = await loginAndRegister("fast@x.com");

    await postJson(
      `/api/v1/rounds/${roundId}/results`,
      { solves: [12000, 13000, 11000, 14000, 12500].map((t) => ({ time_ms: t, inspectionPenalty: "none", penalty: "none" })) },
      bearer(slow.token),
    );
    const fastRes = await postJson(
      `/api/v1/rounds/${roundId}/results`,
      { solves: [8000, 9000, 7000, 10000, 8500].map((t) => ({ time_ms: t, inspectionPenalty: "none", penalty: "none" })) },
      bearer(fast.token),
    );
    expect(fastRes.status).toBe(201);
    expect(fastRes.body.userId).toBe(fast.id);

    const { body: board } = await getJson(`/api/v1/rounds/${roundId}/results`);
    expect(board[0].userId).toBe(fast.id);
    expect(board[0].rank).toBe(1);
    expect(board[1].userId).toBe(slow.id);
    expect(board[1].rank).toBe(2);
  });

  it("serves rankings with DB-level pagination", async () => {
    const p1 = await getJson("/api/v1/rankings?event=333&limit=1&page=1");
    expect(p1.status).toBe(200);
    expect(p1.body.rankings).toHaveLength(1);
    expect(p1.body.total).toBeGreaterThanOrEqual(2);

    const p2 = await getJson("/api/v1/rankings?event=333&limit=1&page=2");
    expect(p2.body.rankings).toHaveLength(1);
    expect(p2.body.total).toBe(p1.body.total);
    // Ascending by ao5: page 2 entry is no faster than page 1
    expect(p2.body.rankings[0].bestAo5Ms).toBeGreaterThanOrEqual(p1.body.rankings[0].bestAo5Ms);
  });

  it("rejects malformed solves", async () => {
    const { token } = await loginAndRegister("bad@x.com");
    const res = await postJson(
      `/api/v1/rounds/${roundId}/results`,
      { solves: [{ time_ms: "oops", penalty: "none" }] },
      bearer(token),
    );
    expect(res.status).toBe(400);
  });
});
