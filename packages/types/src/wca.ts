/**
 * WCA round-format standard — the single source of truth for how many attempts a
 * round has, how competitors in it are ranked, and how many attempts a cutoff
 * applies to.
 *
 * Before this module the same knowledge was duplicated in four places with
 * different content (a `MEAN_OF_3_EVENTS` set in the results route, a
 * `SOLVES_PER_ROUND = 5` constant in the web terminal, a
 * `DEFAULT_SCRAMBLE_COUNT = 5` in the round lifecycle, and the scramble-core
 * event registry). Anything that needs to know "how many attempts?" or "ranked
 * by single or average?" must read it from here.
 *
 * Format codes are the official WCA ones (Regulation 9b).
 */

/** WCA format code: 1=Best of 1, 2=Best of 2, 3=Best of 3, a=Average of 5, m=Mean of 3. */
export type WcaFormat = "1" | "2" | "3" | "a" | "m";

export const WCA_FORMATS: readonly WcaFormat[] = ["1", "2", "3", "a", "m"] as const;

export function isWcaFormat(value: unknown): value is WcaFormat {
  return typeof value === "string" && (WCA_FORMATS as readonly string[]).includes(value);
}

/** Number of attempts a competitor gets in each format. */
export const FORMAT_ATTEMPTS: Record<WcaFormat, number> = {
  "1": 1,
  "2": 2,
  "3": 3,
  a: 5,
  m: 3,
};

/**
 * Which metric decides a competitor's rank in the round (Regulation 9f9).
 * Best-of formats rank by the single; Ao5/Mo3 rank by the average, with the
 * single as the tiebreak.
 */
export const FORMAT_RANKS_BY: Record<WcaFormat, "single" | "average"> = {
  "1": "single",
  "2": "single",
  "3": "single",
  a: "average",
  m: "average",
};

/**
 * Which stored stat holds the average for a format. Ao5 uses the trimmed
 * average, Mo3 the arithmetic mean — conflating the two is why Mo3 rounds
 * previously fell through to being ranked by single.
 */
export const FORMAT_AVERAGE_STAT: Record<WcaFormat, "ao5" | "mean" | null> = {
  "1": null,
  "2": null,
  "3": null,
  a: "ao5",
  m: "mean",
};

/**
 * How many attempts a cutoff applies to (Regulation 9g). A combined round gives
 * the competitor these attempts; they only continue to the rest of the format if
 * at least one is strictly better than the cutoff.
 */
export const FORMAT_CUTOFF_ATTEMPTS: Record<WcaFormat, number> = {
  "1": 0, // no meaningful cutoff for a single attempt
  "2": 1,
  "3": 1,
  a: 2,
  m: 1,
};

/**
 * Default format per event, matching the WCA event table.
 *
 * Note that blindfolded events are **Best of 3**, not Mean of 3 — they were
 * previously treated as Mo3, which is the wrong ranking metric.
 */
export const DEFAULT_FORMAT: Record<string, WcaFormat> = {
  "333": "a",
  "222": "a",
  "444": "a",
  "555": "a",
  "333oh": "a",
  pyram: "a",
  skewb: "a",
  minx: "a",
  sq1: "a",
  clock: "a",
  fto: "a", // not a WCA event; treated as a standard Ao5 side event
  "666": "m",
  "777": "m",
  "333fm": "m",
  "333bf": "3",
  "444bf": "3",
  "555bf": "3",
  "333mbf": "3",
};

/** Format an event defaults to when a round does not specify one. */
export function defaultFormatForEvent(eventType: string): WcaFormat {
  return DEFAULT_FORMAT[eventType] ?? "a";
}

/** Attempts in a round of this format. */
export function attemptsForFormat(format: WcaFormat): number {
  return FORMAT_ATTEMPTS[format];
}

/**
 * Extra scrambles generated beyond the attempt count, for extra attempts
 * granted under Regulation A5 (labelled E1, E2 by the WCA).
 */
export const EXTRA_SCRAMBLES = 2;

/** Scrambles to generate for a round: one per attempt, plus the WCA extras. */
export function scrambleCountForFormat(format: WcaFormat): number {
  return FORMAT_ATTEMPTS[format] + EXTRA_SCRAMBLES;
}
