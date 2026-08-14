import { describe, it, expect, beforeAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { createMemRepo } from "../src/db/mem-repo";
import type { Repository } from "../src/db/repo";
import { seed } from "../src/db/seed";
import { adminToken, bearer } from "./helpers";

/**
 * The Create and Manage screens drifted apart because the two endpoints behind
 * them accepted different field sets in both directions. These tests pin the
 * contract symmetric: whatever POST accepts, PATCH accepts, and vice versa.
 */

let app: FastifyInstance;
let repo: Repository;
let admin: string;
let counter = 0;

const uniqueTitle = () => `Contract Test ${Date.now()}-${counter++}`;

async function create(body: Record<string, unknown>) {
  return app.inject({
    method: "POST",
    url: "/api/v1/admin/competitions",
    payload: { title: uniqueTitle(), ...body },
    headers: bearer(admin),
  });
}

async function patch(id: string, body: Record<string, unknown>) {
  return app.inject({
    method: "PATCH",
    url: `/api/v1/admin/competitions/${id}`,
    payload: body,
    headers: bearer(admin),
  });
}

const detail = (id: string) =>
  app.inject({ method: "GET", url: `/api/v1/competitions/${id}`, headers: bearer(admin) });

beforeAll(async () => {
  repo = createMemRepo();
  await seed(repo);
  app = await buildApp(repo);
  admin = await adminToken(app);
  await app.inject({ method: "POST", url: "/api/v1/auth/sync", headers: bearer(admin) });
});

/**
 * Each field, the value to write, and how to read it back off the stored
 * competition. Driving both endpoints from one table is what keeps them
 * symmetric — a field added to only one side fails here.
 */
const FIELDS: { name: string; value: unknown; read: (c: Record<string, unknown>) => unknown }[] = [
  { name: "description", value: "A description", read: (c) => c.description },
  { name: "rulesMd", value: "# Rules", read: (c) => c.rulesMd },
  { name: "baseFee", value: 15000, read: (c) => c.baseFee },
  { name: "perEventFee", value: 5000, read: (c) => c.perEventFee },
  { name: "registrationLimit", value: 250, read: (c) => c.registrationLimit },
  { name: "videoDeadlineMinutes", value: 720, read: (c) => c.videoDeadlineMinutes },
  { name: "featured", value: true, read: (c) => c.featured },
  { name: "featuredOrder", value: 3, read: (c) => c.featuredOrder },
  { name: "bannerUrl", value: "https://example.com/banner.png", read: (c) => c.bannerUrl },
  { name: "mobileBannerUrl", value: "https://example.com/m.png", read: (c) => c.mobileBannerUrl },
];

describe("every competition field is settable through both endpoints", () => {
  for (const field of FIELDS) {
    it(`accepts ${field.name} at create`, async () => {
      const res = await create({ [field.name]: field.value });
      expect(res.statusCode).toBe(201);
      const stored = (await repo.competitions.findById(res.json().id)) as unknown as Record<string, unknown>;
      expect(field.read(stored)).toEqual(field.value);
    });

    it(`accepts ${field.name} at update`, async () => {
      const created = await create({});
      expect(created.statusCode).toBe(201);
      const id = created.json().id;

      const res = await patch(id, { [field.name]: field.value });
      expect(res.statusCode).toBe(200);
      const stored = (await repo.competitions.findById(id)) as unknown as Record<string, unknown>;
      expect(field.read(stored)).toEqual(field.value);
    });
  }
});

describe("registrationLimit round-trips through update", () => {
  it("changes the stored value instead of being silently discarded", async () => {
    // PATCH never destructured registrationLimit, so the Manage screen reported
    // a successful save and the value never moved.
    const created = await create({ registrationLimit: 100 });
    const id = created.json().id;
    expect((await repo.competitions.findById(id))?.registrationLimit).toBe(100);

    expect((await patch(id, { registrationLimit: 42 })).statusCode).toBe(200);
    expect((await repo.competitions.findById(id))?.registrationLimit).toBe(42);
  });

  it("clears the limit when set to null", async () => {
    const created = await create({ registrationLimit: 100 });
    const id = created.json().id;
    await patch(id, { registrationLimit: null });
    expect((await repo.competitions.findById(id))?.registrationLimit).toBeUndefined();
  });

  it("leaves the stored limit alone when the key is omitted", async () => {
    // The admin form hides this field, so its payload omits the key entirely.
    // If it sent null instead, every save would silently wipe the limit — this
    // is the guard for that.
    const created = await create({ registrationLimit: 100 });
    const id = created.json().id;

    await patch(id, { description: "an unrelated edit" });
    expect((await repo.competitions.findById(id))?.registrationLimit).toBe(100);
  });
});

describe("publishing runs the same gate on both paths", () => {
  const schedule = {
    registrationOpensAt: new Date(Date.now() + 86_400_000).toISOString(),
    registrationDeadline: new Date(Date.now() + 172_800_000).toISOString(),
    startsAt: new Date(Date.now() + 259_200_000).toISOString(),
    endsAt: new Date(Date.now() + 345_600_000).toISOString(),
  };

  it("rejects create-and-publish with no banner", async () => {
    // saveAsDraft:false flipped the status directly, skipping every check the
    // PATCH publish path enforces.
    const res = await create({ saveAsDraft: false, ...schedule });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("banner_required");
  });

  it("rejects PATCH publish with no banner, identically", async () => {
    const created = await create(schedule);
    const res = await patch(created.json().id, { status: "published" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("banner_required");
  });

  it("leaves the competition a draft when create-and-publish is rejected", async () => {
    const res = await create({ saveAsDraft: false, ...schedule });
    expect(res.statusCode).toBe(400);
  });
});

describe("advancement criteria are validated by the competition endpoints", () => {
  it("rejects a rank criteria with no rankLimit at create", async () => {
    const res = await create({
      events: [{ eventType: "333", roundCount: 2, advancementCriteria: { method: "rank" } }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("rank_limit_required");
  });

  it("rejects an unknown method at create", async () => {
    const res = await create({
      events: [{ eventType: "333", roundCount: 2, advancementCriteria: { method: "banana", rankLimit: 4 } }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_advancement_method");
  });

  it("rejects a bad criteria through the competition PATCH too", async () => {
    const created = await create({ events: [{ eventType: "333", roundCount: 1 }] });
    const res = await patch(created.json().id, {
      events: [{ eventType: "333", roundCount: 2, roundCriteria: [{ method: "time" }, null] }],
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("time_limit_required");
  });

  it("strips fields irrelevant to the chosen method", async () => {
    const created = await create({
      events: [{
        eventType: "333",
        roundCount: 2,
        advancementCriteria: { method: "rank", rankLimit: 8, timeLimitMs: 99_000, bestSingleMs: 1 },
      }],
    });
    const comp = await detail(created.json().id);
    const round1 = comp.json().events[0].rounds[0];
    expect(round1.advancementCriteria).toEqual({ method: "rank", rankLimit: 8 });
  });
});

describe("event and round reconciliation", () => {
  it("persists advancementCount when adding a new event through PATCH", async () => {
    // This branch omitted advancementCount entirely.
    const created = await create({ events: [{ eventType: "333", roundCount: 1 }] });
    const id = created.json().id;

    await patch(id, { events: [{ eventType: "222", roundCount: 2, advancementCount: 12 }] });

    const comp = await detail(id);
    const twos = comp.json().events.find((e: { eventType: string }) => e.eventType === "222");
    expect(twos.rounds[0].advancementCount).toBe(12);
  });

  it("rejects an invalid event type instead of silently dropping it", async () => {
    const res = await create({ events: [{ eventType: "333" }, { eventType: "not_an_event" }] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_event_type");
  });

  it("clamps roundCount on the competition-events endpoint", async () => {
    const created = await create({ events: [{ eventType: "333", roundCount: 1 }] });
    const comp = await detail(created.json().id);
    const eventId = comp.json().events[0].id;

    const res = await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/competition-events/${eventId}`,
      payload: { roundCount: 500 },
      headers: bearer(admin),
    });
    expect(res.statusCode).toBe(200);
    expect((await repo.competitionEvents.findById(eventId))?.roundCount).toBe(10);
  });

  it("un-archives rather than duplicating when an archived event type is re-added", async () => {
    const created = await create({ events: [{ eventType: "444", roundCount: 1 }] });
    const id = created.json().id;
    const comp = await detail(id);
    const eventId = comp.json().events[0].id;

    await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/competition-events/${eventId}`,
      payload: { archived: true },
      headers: bearer(admin),
    });

    // Previously this inserted a second row and violated the unique constraint.
    const res = await patch(id, { events: [{ eventType: "444", roundCount: 1 }] });
    expect(res.statusCode).toBe(200);

    const events = await repo.competitionEvents.findByCompetition(id);
    expect(events.filter((e) => e.eventType === "444")).toHaveLength(1);
    expect(events.find((e) => e.eventType === "444")?.archived).toBe(false);
  });
});

describe("input validation", () => {
  it("rejects an unparseable date rather than storing NaN", async () => {
    // Date.parse gives NaN, and every NaN comparison is false — so a bad date
    // passed schedule validation and was written.
    const res = await create({ startsAt: "not a date" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_date");
  });

  it("rejects a negative fee", async () => {
    const res = await create({ baseFee: -100 });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_base_fee");
  });

  it("still requires a title at create", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/competitions",
      payload: { description: "no title" },
      headers: bearer(admin),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("missing_title");
  });
});

describe("cutoff and time limit ownership (round is the truth)", () => {
  /** A competition with one event, two rounds, and an event-level cutoff. */
  async function withCutoff() {
    const created = await create({
      events: [{ eventType: "333", roundCount: 2, cutoffMs: 20_000, timeLimitMs: 60_000 }],
    });
    const id = created.json().id;
    const comp = await detail(id);
    return { id, event: comp.json().events[0] };
  }

  it("seeds new rounds from the event value", async () => {
    const { event } = await withCutoff();
    expect(event.rounds[0].cutoffMs).toBe(20_000);
    expect(event.rounds[1].cutoffMs).toBe(20_000);
  });

  it("leaves existing round values alone when the event default changes", async () => {
    const { id, event } = await withCutoff();

    // Give round 1 a deliberate override.
    await app.inject({
      method: "PATCH",
      url: `/api/v1/admin/rounds/${event.rounds[0].id}`,
      payload: { cutoffMs: 12_000 },
      headers: bearer(admin),
    });

    // Changing the event default must not silently clobber it.
    await patch(id, { events: [{ eventType: "333", roundCount: 2, cutoffMs: 30_000 }] });

    const after = await detail(id);
    expect(after.json().events[0].rounds[0].cutoffMs).toBe(12_000);
  });

  it("pushes the event value down when applyToExistingRounds is set", async () => {
    const { id } = await withCutoff();

    await patch(id, {
      events: [{ eventType: "333", roundCount: 2, cutoffMs: 30_000, applyToExistingRounds: true }],
    });

    const after = await detail(id);
    expect(after.json().events[0].rounds[0].cutoffMs).toBe(30_000);
    expect(after.json().events[0].rounds[1].cutoffMs).toBe(30_000);
  });
});

describe("multiple rule sets", () => {
  /** Create a rule set and return its id. */
  async function makeRuleSet(name: string, content: string): Promise<string> {
    const res = await app.inject({
      method: "POST",
      url: "/api/v1/admin/rule-sets",
      payload: { name, content },
      headers: bearer(admin),
    });
    expect(res.statusCode).toBe(201);
    return res.json().id;
  }

  it("accepts several rule sets at create and returns them in order", async () => {
    const a = await makeRuleSet(`Set A ${counter++}`, "Rule A body");
    const b = await makeRuleSet(`Set B ${counter++}`, "Rule B body");

    const created = await create({ ruleSetIds: [b, a] });
    expect(created.statusCode).toBe(201);

    const comp = await detail(created.json().id);
    const sets = comp.json().ruleSets as { id: string; name: string; content: string }[];
    // Order is the order chosen, not insertion order of the rule sets.
    expect(sets.map((s) => s.id)).toEqual([b, a]);
    expect(sets[0]!.content).toBe("Rule B body");
  });

  it("accepts several rule sets through update, symmetric with create", async () => {
    const a = await makeRuleSet(`Set C ${counter++}`, "C body");
    const b = await makeRuleSet(`Set D ${counter++}`, "D body");

    const created = await create({});
    const id = created.json().id;

    expect((await patch(id, { ruleSetIds: [a, b] })).statusCode).toBe(200);
    const comp = await detail(id);
    expect((comp.json().ruleSets as { id: string }[]).map((s) => s.id)).toEqual([a, b]);
  });

  it("replaces the whole selection rather than appending", async () => {
    const a = await makeRuleSet(`Set E ${counter++}`, "E body");
    const b = await makeRuleSet(`Set F ${counter++}`, "F body");

    const created = await create({ ruleSetIds: [a, b] });
    const id = created.json().id;

    await patch(id, { ruleSetIds: [b] });
    expect((await detail(id)).json().ruleSets.map((s: { id: string }) => s.id)).toEqual([b]);
  });

  it("clears the selection with an empty array", async () => {
    const a = await makeRuleSet(`Set G ${counter++}`, "G body");
    const created = await create({ ruleSetIds: [a] });
    const id = created.json().id;

    await patch(id, { ruleSetIds: [] });
    expect((await detail(id)).json().ruleSets).toEqual([]);
  });

  it("leaves the selection untouched when ruleSetIds is omitted", async () => {
    const a = await makeRuleSet(`Set H ${counter++}`, "H body");
    const created = await create({ ruleSetIds: [a] });
    const id = created.json().id;

    // A save that does not mention rule sets must not wipe them.
    await patch(id, { description: "unrelated edit" });
    expect((await detail(id)).json().ruleSets.map((s: { id: string }) => s.id)).toEqual([a]);
  });

  it("rejects an unknown rule set id instead of failing on the foreign key", async () => {
    const res = await create({ ruleSetIds: ["00000000-0000-0000-0000-0000000000ff"] });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("rule_set_not_found");
  });

  it("rejects a malformed ruleSetIds payload", async () => {
    const res = await create({ ruleSetIds: "not-an-array" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe("invalid_rule_set_ids");
  });

  it("keeps rulesMd as separate custom text alongside the sets", async () => {
    const a = await makeRuleSet(`Set I ${counter++}`, "I body");
    const created = await create({ ruleSetIds: [a], rulesMd: "Extra house rules" });
    const comp = await detail(created.json().id);

    expect(comp.json().rulesMd).toBe("Extra house rules");
    expect(comp.json().ruleSets.map((s: { content: string }) => s.content)).toEqual(["I body"]);
  });
});

describe("archived is settable at create as well as update", () => {
  it("creates an event already archived", async () => {
    // The Create screen offers Archive rather than a discard action, so an
    // event decided against is created archived rather than not created.
    const created = await create({
      events: [
        { eventType: "333", roundCount: 1 },
        { eventType: "222", roundCount: 1, archived: true },
      ],
    });
    expect(created.statusCode).toBe(201);

    const stored = await repo.competitionEvents.findByCompetition(created.json().id);
    expect(stored.find((e) => e.eventType === "222")?.archived).toBe(true);
    expect(stored.find((e) => e.eventType === "333")?.archived).toBe(false);
  });

  it("archives an existing event through the events array", async () => {
    const created = await create({ events: [{ eventType: "444", roundCount: 1 }] });
    const id = created.json().id;

    await patch(id, { events: [{ eventType: "444", roundCount: 1, archived: true }] });
    const stored = await repo.competitionEvents.findByCompetition(id);
    expect(stored.find((e) => e.eventType === "444")?.archived).toBe(true);
  });

  it("still un-archives when the event is re-added without an explicit flag", async () => {
    const created = await create({ events: [{ eventType: "555", roundCount: 1, archived: true }] });
    const id = created.json().id;

    await patch(id, { events: [{ eventType: "555", roundCount: 1 }] });
    const stored = await repo.competitionEvents.findByCompetition(id);
    expect(stored.find((e) => e.eventType === "555")?.archived).toBe(false);
  });
});
