import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { createMemRepo } from "../src/db/mem-repo";
import type { Repository } from "../src/db/repo";
import { seed, SEED_DEMO_COMP_ID } from "../src/db/seed";
import { adminToken, bearer, devToken, syncVerifiedUser } from "./helpers";

/**
 * Endpoints that were reachable without a token and exposed personal or
 * internal data. Each of these returned 200 to an anonymous caller.
 */

let app: FastifyInstance;
let repo: Repository;
let admin: string;
let userTok: string;
let roundId: string;

beforeAll(async () => {
  repo = createMemRepo();
  await seed(repo);
  app = await buildApp(repo);
  admin = await adminToken(app);
  await app.inject({ method: "POST", url: "/api/v1/auth/sync", headers: bearer(admin) });

  const detail = await app.inject({ method: "GET", url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}` });
  const eventId = detail.json().events[0].id;
  roundId = detail.json().events[0].rounds[0].id;

  userTok = await devToken(app, "anon-check@test.com", "Anon Check");
  await syncVerifiedUser(app, repo, userTok);
  await app.inject({
    method: "POST",
    url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}/register`,
    payload: { eventIds: [eventId] },
    headers: bearer(userTok),
  });
});

const anon = (url: string, method: "GET" | "POST" = "GET", payload?: unknown) =>
  app.inject({ method, url, ...(payload ? { payload } : {}) });

describe("endpoints requiring authentication", () => {
  it("rejects an anonymous participant list — it names real people and their cities", async () => {
    const res = await anon(`/api/v1/competitions/${SEED_DEMO_COMP_ID}/participants`);
    expect(res.statusCode).toBe(401);
  });

  it("serves the participant list to a signed-in user", async () => {
    const res = await app.inject({
      method: "GET",
      url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}/participants`,
      headers: bearer(userTok),
    });
    expect(res.statusCode).toBe(200);
  });

  it("hides registration times from non-organisers", async () => {
    const asUser = await app.inject({
      method: "GET",
      url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}/participants`,
      headers: bearer(userTok),
    });
    const first = asUser.json().participants[0];
    expect(first).toBeDefined();
    expect(first.registeredAt).toBeUndefined();

    const asAdmin = await app.inject({
      method: "GET",
      url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}/participants`,
      headers: bearer(admin),
    });
    expect(asAdmin.json().participants[0].registeredAt).toBeDefined();
  });

  it("rejects anonymous user search — a 2-character query walked the directory", async () => {
    expect((await anon("/api/v1/users/search?q=an")).statusCode).toBe(401);
  });

  it("omits people from global search for anonymous callers, but keeps public content", async () => {
    const res = await anon("/api/v1/search?q=an");
    expect(res.statusCode).toBe(200);
    const items = res.json() as { type: string }[];
    expect(items.some((i) => i.type === "user")).toBe(false);
  });

  it("rejects anonymous promo validation — it confirmed code validity and value", async () => {
    const res = await anon("/api/v1/promo/validate", "POST", { code: "ANYTHING" });
    expect(res.statusCode).toBe(401);
  });
});

describe("public results do not leak moderation data", () => {
  it("omits verifiedBy, verificationComment and flagReasons", async () => {
    await app.inject({
      method: "POST",
      url: `/api/v1/rounds/${roundId}/results`,
      payload: {
        solves: [12_000, 13_000, 11_000, 14_000, 12_500].map((t) => ({
          time_ms: t, inspectionPenalty: "none", penalty: "none",
        })),
      },
      headers: bearer(userTok),
    });

    const res = await anon(`/api/v1/rounds/${roundId}/verified-results`);
    expect(res.statusCode).toBe(200);
    const rows = res.json() as Record<string, unknown>[];
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row).not.toHaveProperty("verifiedBy");
      expect(row).not.toHaveProperty("verificationComment");
      expect(row).not.toHaveProperty("flagReasons");
      // The competitor-facing fields are still there.
      expect(row).toHaveProperty("ao5Ms");
      expect(row).toHaveProperty("userName");
    }
  });
});
