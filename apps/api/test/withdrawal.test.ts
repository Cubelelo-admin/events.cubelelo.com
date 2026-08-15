import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { createMemRepo } from "../src/db/mem-repo";
import type { Repository } from "../src/db/repo";
import { seed, SEED_DEMO_COMP_ID } from "../src/db/seed";
import { adminToken, bearer, devToken, syncVerifiedUser } from "./helpers";

/**
 * Leaving a competition.
 *
 * Before this, nothing could undo a registration by any route: the competitor's
 * withdraw endpoint refused anything marked `paid`, which — since free
 * competitions are written as paid too — was every row in the table, and there
 * was no admin equivalent at all.
 */

let app: FastifyInstance;
let repo: Repository;
let admin: string;
let eventId: string;

const register = (token: string, events: string[] = [eventId]) =>
  app.inject({
    method: "POST",
    url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}/register`,
    payload: { eventIds: events },
    headers: bearer(token),
  });

const withdraw = (token: string, regId: string) =>
  app.inject({ method: "DELETE", url: `/api/v1/registrations/${regId}`, headers: bearer(token) });

const participants = (token: string) =>
  app.inject({
    method: "GET",
    url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}/participants`,
    headers: bearer(token),
  });

async function newCompetitor(email: string) {
  const token = await devToken(app, email, email.split("@")[0]);
  const user = await syncVerifiedUser(app, repo, token);
  return { token, id: user.id };
}

beforeAll(async () => {
  repo = createMemRepo();
  await seed(repo);
  app = await buildApp(repo);
  admin = await adminToken(app);
  const events = await repo.competitionEvents.findByCompetition(SEED_DEMO_COMP_ID);
  eventId = events[0]!.id;
});

describe("withdrawing from a free competition", () => {
  it("withdraws, disappears everywhere, and can register again", async () => {
    const { token, id } = await newCompetitor("leaver@test.com");

    const reg = await register(token);
    expect(reg.statusCode).toBe(201);
    const regId = reg.json().registrationId;

    // In: gate and participant list agree.
    expect(await repo.registrations.isRegisteredForEvent(id, eventId)).toBe(true);
    const before = await participants(token);
    expect((before.json().participants ?? before.json()).some((p: { userId: string }) => p.userId === id))
      .toBe(true);

    const out = await withdraw(token, regId);
    expect(out.statusCode).toBe(200);
    expect(out.json().status).toBe("withdrawn");

    // Out: they agree again. This is the pairing the old code got wrong.
    expect(await repo.registrations.isRegisteredForEvent(id, eventId)).toBe(false);
    const after = await participants(token);
    expect((after.json().participants ?? after.json()).some((p: { userId: string }) => p.userId === id))
      .toBe(false);

    const progress = await app.inject({
      method: "GET",
      url: `/api/v1/competitions/${SEED_DEMO_COMP_ID}/my-progress`,
      headers: bearer(token),
    });
    expect(progress.json().registered).toBe(false);

    // And back in — the unique (user_id, competition_id) row is reused.
    const again = await register(token);
    expect(again.statusCode).toBe(201);
    expect(again.json().registrationId).toBe(regId);
    expect(await repo.registrations.isRegisteredForEvent(id, eventId)).toBe(true);
  });

  it("refuses to withdraw twice", async () => {
    const { token } = await newCompetitor("twice@test.com");
    const regId = (await register(token)).json().registrationId;

    expect((await withdraw(token, regId)).statusCode).toBe(200);
    const second = await withdraw(token, regId);
    expect(second.statusCode).toBe(409);
    expect(second.json().error).toBe("registration_not_active");
  });

  it("refuses to withdraw someone else's registration", async () => {
    const { token } = await newCompetitor("owner@test.com");
    const regId = (await register(token)).json().registrationId;

    const { token: other } = await newCompetitor("stranger@test.com");
    const res = await withdraw(other, regId);
    expect(res.statusCode).toBe(403);
  });

  it("refuses once results have been submitted", async () => {
    const { token, id } = await newCompetitor("hasresults@test.com");
    const regId = (await register(token)).json().registrationId;

    const rounds = await repo.rounds.findByCompetition(SEED_DEMO_COMP_ID);
    const round = rounds.find((r) => r.competitionEventId === eventId)!;
    await repo.results.create({
      id: "00000000-0000-0000-0000-0000000000f1",
      roundId: round.id,
      userId: id,
      solves: [{ time_ms: 9000, penalty: "none", inspectionPenalty: "none" }],
      bestSingleMs: 9000,
      ao5Ms: null,
      meanMs: null,
      medianMs: null,
      stdMs: null,
      rank: null,
      videoUrl: null,
      flagStatus: "clean",
      flagReasons: [],
      submittedAt: new Date().toISOString(),
    });

    const res = await withdraw(token, regId);
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toBe("registration_has_results");
  });

  it("frees the slot for someone else when a limit is set", async () => {
    await repo.competitions.update(SEED_DEMO_COMP_ID, { registrationLimit: 0 });
    const active = (await repo.registrations.findByCompetition(SEED_DEMO_COMP_ID))
      .filter((r) => r.status === "active").length;
    await repo.competitions.update(SEED_DEMO_COMP_ID, { registrationLimit: active + 1 });

    const { token } = await newCompetitor("lastslot@test.com");
    expect((await register(token)).statusCode).toBe(201);

    const { token: queued } = await newCompetitor("queued@test.com");
    const full = await register(queued);
    expect(full.statusCode).toBe(409);
    expect(full.json().error).toBe("registration_full");

    const regId = (await repo.registrations.findByUserAndComp(
      (await repo.users.findByEmail("lastslot@test.com"))!.id,
      SEED_DEMO_COMP_ID,
    ))!.id;
    expect((await withdraw(token, regId)).statusCode).toBe(200);

    expect((await register(queued)).statusCode).toBe(201);
    await repo.competitions.update(SEED_DEMO_COMP_ID, { registrationLimit: undefined });
  });
});

describe("admin removal", () => {
  const remove = (regId: string, token = admin) =>
    app.inject({
      method: "DELETE",
      url: `/api/v1/admin/competitions/${SEED_DEMO_COMP_ID}/registrations/${regId}`,
      payload: { reason: "duplicate entry" },
      headers: bearer(token),
    });

  it("removes a participant and records why", async () => {
    const { token, id } = await newCompetitor("removeme@test.com");
    const regId = (await register(token)).json().registrationId;

    const res = await remove(regId);
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe("removed");

    expect(await repo.registrations.isRegisteredForEvent(id, eventId)).toBe(false);

    const log = await repo.auditLog.findAll();
    const entry = log.find((e) => e.action === "registration_remove" && e.target === regId);
    expect(entry).toBeDefined();
    expect(entry!.reason).toBe("duplicate entry");
  });

  it("refuses a registration from another competition", async () => {
    const { token } = await newCompetitor("othercomp@test.com");
    const regId = (await register(token)).json().registrationId;
    const res = await app.inject({
      method: "DELETE",
      url: `/api/v1/admin/competitions/00000000-0000-0000-0000-0000000000ff/registrations/${regId}`,
      headers: bearer(admin),
    });
    expect([403, 404]).toContain(res.statusCode);
  });

  it("refuses a moderator who does not own the competition", async () => {
    const { token } = await newCompetitor("modtarget@test.com");
    const regId = (await register(token)).json().registrationId;

    const modToken = await devToken(app, "outsider-mod@test.com", "Outsider Mod");
    const mod = await syncVerifiedUser(app, repo, modToken);
    await repo.users.update(mod.id, { role: "moderator" });

    const res = await remove(regId, modToken);
    expect(res.statusCode).toBe(403);
  });
});
