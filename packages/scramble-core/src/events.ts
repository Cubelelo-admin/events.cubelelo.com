/**
 * WCA event registry for the platform.
 *
 * `id`        — our internal/stored event key (matches DB `event_type`).
 * `name`      — display name.
 * `wcaEvent`  — the cubing.js event id passed to `randomScrambleForEvent`.
 * `puzzle`    — the cubing.js puzzle id used by the 2D <twisty-player> visualizer.
 * `priority`  — "must" / "should" from the locked PRD (Module 1, §2.1).
 */
export interface CubeEvent {
  id: string;
  name: string;
  wcaEvent: string;
  puzzle: string;
  priority: "must" | "should";
}

export const EVENTS = {
  "333": { id: "333", name: "3x3", wcaEvent: "333", puzzle: "3x3x3", priority: "must" },
  "222": { id: "222", name: "2x2", wcaEvent: "222", puzzle: "2x2x2", priority: "must" },
  "444": { id: "444", name: "4x4", wcaEvent: "444", puzzle: "4x4x4", priority: "must" },
  "555": { id: "555", name: "5x5", wcaEvent: "555", puzzle: "5x5x5", priority: "must" },
  "666": { id: "666", name: "6x6", wcaEvent: "666", puzzle: "6x6x6", priority: "must" },
  "777": { id: "777", name: "7x7", wcaEvent: "777", puzzle: "7x7x7", priority: "must" },
  pyram: { id: "pyram", name: "Pyraminx", wcaEvent: "pyram", puzzle: "pyraminx", priority: "must" },
  skewb: { id: "skewb", name: "Skewb", wcaEvent: "skewb", puzzle: "skewb", priority: "must" },
  minx: { id: "minx", name: "Megaminx", wcaEvent: "minx", puzzle: "megaminx", priority: "must" },
  "333oh": { id: "333oh", name: "3x3 One-Handed", wcaEvent: "333oh", puzzle: "3x3x3", priority: "must" },
  "333bf": { id: "333bf", name: "3x3 Blindfolded", wcaEvent: "333bf", puzzle: "3x3x3", priority: "must" },
  sq1: { id: "sq1", name: "Square-1", wcaEvent: "sq1", puzzle: "square1", priority: "should" },
  clock: { id: "clock", name: "Clock", wcaEvent: "clock", puzzle: "clock", priority: "should" },
  "444bf": { id: "444bf", name: "4x4 Blindfolded", wcaEvent: "444bf", puzzle: "4x4x4", priority: "should" },
  "555bf": { id: "555bf", name: "5x5 Blindfolded", wcaEvent: "555bf", puzzle: "5x5x5", priority: "should" },
  "333mbf": { id: "333mbf", name: "Multi-Blind", wcaEvent: "333mbf", puzzle: "3x3x3", priority: "should" },
  fto: { id: "fto", name: "FTO", wcaEvent: "fto", puzzle: "fto", priority: "should" },
  "333fm": { id: "333fm", name: "Fewest Moves", wcaEvent: "333fm", puzzle: "3x3x3", priority: "should" },
} as const satisfies Record<string, CubeEvent>;

export type EventId = keyof typeof EVENTS;

export const EVENT_IDS = Object.keys(EVENTS) as EventId[];

export function isEventId(value: string): value is EventId {
  return value in EVENTS;
}

export function getEvent(id: EventId): CubeEvent {
  return EVENTS[id];
}
