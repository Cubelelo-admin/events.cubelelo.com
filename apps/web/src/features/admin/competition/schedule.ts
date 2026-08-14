/**
 * Schedule arithmetic for the admin competition screens.
 *
 * These are deliberately pure — no React, no API — because the bugs that reached
 * the user here were logic errors that typecheck and a build cannot catch: a
 * recascade that discarded every value it computed, and a gap-closing shift that
 * summed freed slots across days instead of within them. Keeping the arithmetic
 * testable is the point of this module.
 *
 * The schedule model: one day per round number. Round 1 of every event runs on
 * the first day, round 2 on the second, and so on. Within a day, events run in
 * order with a fixed gap between them.
 */

export interface RoundSlot {
  startTime?: string;
  durationMinutes?: number;
}

export interface ScheduleEvent {
  eventType: string;
  roundCount: number;
  /** Archived events are not run, so they take no slot in the timeline. */
  archived?: boolean;
}

/** Local `datetime-local` string for a Date, in the viewer's timezone. */
export function toLocalDatetime(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/**
 * Lay out every round from the competition start.
 *
 * Returns one slot array per event, positionally aligned with `events` — an
 * archived event gets an empty array rather than being dropped, so callers can
 * index by event.
 */
export function computeRoundSchedules(
  compStart: Date,
  events: ScheduleEvent[],
  gapMinutes: number,
  durationFor: (eventType: string) => number,
): { schedules: RoundSlot[][]; endsAt: Date } {
  const schedules: RoundSlot[][] = events.map(() => []);
  const active = events.filter((e) => !e.archived);
  if (active.length === 0) return { schedules, endsAt: compStart };

  const maxRounds = Math.max(...active.map((e) => e.roundCount));
  let lastEnd = new Date(compStart);

  for (let dayOffset = 0; dayOffset < maxRounds; dayOffset++) {
    const dayBase =
      dayOffset === 0
        ? new Date(compStart)
        : new Date(
            compStart.getFullYear(),
            compStart.getMonth(),
            compStart.getDate() + dayOffset,
            compStart.getHours(),
            compStart.getMinutes(),
          );

    let cursor = new Date(dayBase);

    for (let ei = 0; ei < events.length; ei++) {
      const ev = events[ei]!;
      if (ev.archived) continue;
      if (dayOffset >= ev.roundCount) continue;

      const dur = durationFor(ev.eventType);
      schedules[ei]![dayOffset] = {
        startTime: toLocalDatetime(cursor),
        durationMinutes: dur,
      };

      const roundEnd = new Date(cursor.getTime() + dur * 60_000);
      if (roundEnd > lastEnd) lastEnd = roundEnd;
      cursor = new Date(roundEnd.getTime() + gapMinutes * 60_000);
    }
  }

  return { schedules, endsAt: lastEnd };
}

/** A saved round, as the Manage screen knows it. */
export interface ScheduledRound {
  id: string;
  opensAt?: string | null;
  durationMinutes: number;
}

export interface ScheduledEvent {
  id: string;
  archived?: boolean;
  rounds: ScheduledRound[];
}

/**
 * New times for the remaining rounds when an event is archived or restored.
 *
 * Archiving frees that event's slots, so rounds later **on the same day** move
 * earlier by exactly that much; restoring pushes them back. Rounds before the
 * change keep their times, so anything set by hand survives.
 *
 * The day scoping matters: summing every freed slot regardless of day shifts
 * later days backwards by time that was never theirs, usually landing outside
 * the competition window.
 */
export function shiftRoundsAroundEvent(
  events: ScheduledEvent[],
  changedEventId: string,
  direction: "archive" | "restore",
  gapMinutes: number,
): { roundId: string; opensAt: string; closesAt: string }[] {
  const dayOf = (iso: string) => new Date(iso).toDateString();

  const changed =
    events
      .find((e) => e.id === changedEventId)
      ?.rounds.filter((r) => r.opensAt)
      .map((r) => ({
        day: dayOf(r.opensAt!),
        start: +new Date(r.opensAt!),
        minutes: r.durationMinutes + gapMinutes,
      })) ?? [];
  if (changed.length === 0) return [];

  const sign = direction === "archive" ? -1 : 1;
  const out: { roundId: string; opensAt: string; closesAt: string }[] = [];

  for (const ev of events) {
    if (ev.id === changedEventId || ev.archived) continue;
    for (const r of ev.rounds) {
      if (!r.opensAt) continue;
      const start = +new Date(r.opensAt);
      const day = dayOf(r.opensAt);

      const shiftMinutes = changed
        .filter((c) => c.day === day && c.start < start)
        .reduce((sum, c) => sum + c.minutes, 0);
      if (shiftMinutes === 0) continue;

      const nextStart = new Date(start + sign * shiftMinutes * 60_000);
      const nextEnd = new Date(nextStart.getTime() + r.durationMinutes * 60_000);
      out.push({
        roundId: r.id,
        opensAt: nextStart.toISOString(),
        closesAt: nextEnd.toISOString(),
      });
    }
  }
  return out;
}

/**
 * Merge freshly computed slots over the existing ones, keeping only the slots
 * the admin pinned by typing a time.
 *
 * Preserving *every* existing slot — which is what `existing[i] ?? computed[i]`
 * does — means the recascade's output is always discarded, so archiving an event
 * or changing a round count silently does nothing.
 */
export function mergeRoundSlots(
  computed: RoundSlot[],
  /** Sparse: a slot the cascade never filled is simply absent. */
  existing: (RoundSlot | undefined)[],
  isPinned: (roundIndex: number) => boolean,
): RoundSlot[] {
  return computed.map((slot, i) => (isPinned(i) ? existing[i] ?? slot : slot));
}
