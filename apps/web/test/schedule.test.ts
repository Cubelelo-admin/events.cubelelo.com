import { describe, it, expect } from "vitest";
import {
  computeRoundSchedules,
  mergeRoundSlots,
  shiftRoundsAroundEvent,
  toLocalDatetime,
  type RoundSlot,
  type ScheduledEvent,
} from "../src/features/admin/competition/schedule";

/**
 * Regression cover for the admin schedule arithmetic.
 *
 * Two bugs here reached the user because typecheck and a build cannot catch
 * logic errors: a recascade that discarded everything it computed, and a
 * gap-closing shift that summed freed slots across days rather than within them.
 * Both are pinned below.
 */

/** 9am on a fixed date, so day boundaries in the assertions are unambiguous. */
const START = new Date(2026, 0, 10, 9, 0);
const THIRTY = () => 30;

describe("computeRoundSchedules", () => {
  it("lays out one day per round number, events in order", () => {
    const { schedules } = computeRoundSchedules(
      START,
      [
        { eventType: "333", roundCount: 2 },
        { eventType: "222", roundCount: 2 },
      ],
      0,
      THIRTY,
    );

    // Day 1: 3x3 R1 at 09:00, 2x2 R1 at 09:30.
    expect(schedules[0]![0]!.startTime).toBe(toLocalDatetime(new Date(2026, 0, 10, 9, 0)));
    expect(schedules[1]![0]!.startTime).toBe(toLocalDatetime(new Date(2026, 0, 10, 9, 30)));
    // Day 2 repeats the pattern.
    expect(schedules[0]![1]!.startTime).toBe(toLocalDatetime(new Date(2026, 0, 11, 9, 0)));
    expect(schedules[1]![1]!.startTime).toBe(toLocalDatetime(new Date(2026, 0, 11, 9, 30)));
  });

  it("honours the gap between events", () => {
    const { schedules } = computeRoundSchedules(
      START,
      [
        { eventType: "333", roundCount: 1 },
        { eventType: "222", roundCount: 1 },
      ],
      15,
      THIRTY,
    );
    expect(schedules[1]![0]!.startTime).toBe(toLocalDatetime(new Date(2026, 0, 10, 9, 45)));
  });

  it("gives an archived event no slot, and closes the gap it leaves", () => {
    const { schedules } = computeRoundSchedules(
      START,
      [
        { eventType: "333", roundCount: 1 },
        { eventType: "222", roundCount: 1, archived: true },
        { eventType: "444", roundCount: 1 },
      ],
      0,
      THIRTY,
    );

    expect(schedules[1]).toEqual([]);
    // 4x4 takes the archived event's 09:30 slot rather than starting at 10:00.
    expect(schedules[2]![0]!.startTime).toBe(toLocalDatetime(new Date(2026, 0, 10, 9, 30)));
  });

  it("does not let an archived event stretch the number of days", () => {
    const { schedules } = computeRoundSchedules(
      START,
      [
        { eventType: "333", roundCount: 1 },
        { eventType: "222", roundCount: 5, archived: true },
      ],
      0,
      THIRTY,
    );
    expect(schedules[0]).toHaveLength(1);
  });

  it("produces nothing when every event is archived", () => {
    const { schedules, endsAt } = computeRoundSchedules(
      START,
      [{ eventType: "333", roundCount: 2, archived: true }],
      0,
      THIRTY,
    );
    expect(schedules).toEqual([[]]);
    expect(endsAt).toBe(START);
  });
});

describe("mergeRoundSlots", () => {
  const computed: RoundSlot[] = [
    { startTime: "2026-01-10T09:00", durationMinutes: 30 },
    { startTime: "2026-01-11T09:00", durationMinutes: 30 },
  ];
  const existing: RoundSlot[] = [
    { startTime: "2026-01-10T14:00", durationMinutes: 45 },
    { startTime: "2026-01-11T14:00", durationMinutes: 45 },
  ];

  it("takes the recomputed time for slots the admin never touched", () => {
    // `existing[i] ?? computed[i]` kept the old value every time, so a recascade
    // computed new times and threw all of them away.
    expect(mergeRoundSlots(computed, existing, () => false)).toEqual(computed);
  });

  it("keeps a slot the admin typed by hand", () => {
    const merged = mergeRoundSlots(computed, existing, (i) => i === 0);
    expect(merged[0]).toEqual(existing[0]);
    expect(merged[1]).toEqual(computed[1]);
  });

  it("falls back to the computed slot when a pinned one is missing", () => {
    expect(mergeRoundSlots(computed, [], () => true)).toEqual(computed);
  });
});

describe("shiftRoundsAroundEvent", () => {
  /** Two days, three events, 30-minute rounds starting 09:00 with no gap. */
  const events = (): ScheduledEvent[] => [
    {
      id: "e1",
      rounds: [
        { id: "e1r1", opensAt: new Date(2026, 0, 10, 9, 0).toISOString(), durationMinutes: 30 },
        { id: "e1r2", opensAt: new Date(2026, 0, 11, 9, 0).toISOString(), durationMinutes: 30 },
      ],
    },
    {
      id: "e2",
      rounds: [
        { id: "e2r1", opensAt: new Date(2026, 0, 10, 9, 30).toISOString(), durationMinutes: 30 },
        { id: "e2r2", opensAt: new Date(2026, 0, 11, 9, 30).toISOString(), durationMinutes: 30 },
      ],
    },
    {
      id: "e3",
      rounds: [
        { id: "e3r1", opensAt: new Date(2026, 0, 10, 10, 0).toISOString(), durationMinutes: 30 },
        { id: "e3r2", opensAt: new Date(2026, 0, 11, 10, 0).toISOString(), durationMinutes: 30 },
      ],
    },
  ];

  const byId = (out: { roundId: string; opensAt: string }[]) =>
    Object.fromEntries(out.map((o) => [o.roundId, o.opensAt]));

  it("shifts each day by only that day's freed slot", () => {
    // The bug: summing every earlier freed slot moved day 2 by 60 minutes
    // instead of 30, dragging it outside the competition window.
    const out = byId(shiftRoundsAroundEvent(events(), "e2", "archive", 0));

    expect(out.e3r1).toBe(new Date(2026, 0, 10, 9, 30).toISOString());
    expect(out.e3r2).toBe(new Date(2026, 0, 11, 9, 30).toISOString());
  });

  it("leaves rounds scheduled before the archived event alone", () => {
    const out = byId(shiftRoundsAroundEvent(events(), "e2", "archive", 0));
    expect(out.e1r1).toBeUndefined();
    expect(out.e1r2).toBeUndefined();
  });

  it("moves nothing when the last event is archived", () => {
    expect(shiftRoundsAroundEvent(events(), "e3", "archive", 0)).toEqual([]);
  });

  it("includes the gap in the freed slot", () => {
    const out = byId(shiftRoundsAroundEvent(events(), "e2", "archive", 10));
    // 30 minutes of round plus a 10-minute gap.
    expect(out.e3r1).toBe(new Date(2026, 0, 10, 9, 20).toISOString());
  });

  it("restoring is the exact inverse of archiving", () => {
    const archived = byId(shiftRoundsAroundEvent(events(), "e2", "archive", 0));
    const restored = byId(shiftRoundsAroundEvent(events(), "e2", "restore", 0));

    expect(archived.e3r1).toBe(new Date(2026, 0, 10, 9, 30).toISOString());
    expect(restored.e3r1).toBe(new Date(2026, 0, 10, 10, 30).toISOString());
  });

  it("recomputes each shifted round's close time from its duration", () => {
    const out = shiftRoundsAroundEvent(events(), "e2", "archive", 0);
    const e3r1 = out.find((o) => o.roundId === "e3r1")!;
    expect(e3r1.closesAt).toBe(new Date(2026, 0, 10, 10, 0).toISOString());
  });

  it("ignores events that are already archived", () => {
    const withArchived = events();
    withArchived[2]!.archived = true;
    expect(shiftRoundsAroundEvent(withArchived, "e2", "archive", 0)).toEqual([]);
  });

  it("returns nothing when the changed event has no scheduled rounds", () => {
    const unscheduled = events();
    unscheduled[1]!.rounds = [{ id: "e2r1", opensAt: null, durationMinutes: 30 }];
    expect(shiftRoundsAroundEvent(unscheduled, "e2", "archive", 0)).toEqual([]);
  });
});
