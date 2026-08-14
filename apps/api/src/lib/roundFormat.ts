import {
  FORMAT_ATTEMPTS,
  FORMAT_CUTOFF_ATTEMPTS,
  defaultFormatForEvent,
  type WcaFormat,
} from "@cubers/types";
import type { CompetitionEvent, Round } from "../db/types";

/**
 * Resolve the WCA format for a round.
 *
 * Rounds created before migration 041 have no stored format, so fall back to the
 * event's WCA default. Every consumer that needs an attempt count, a ranking
 * metric or a cutoff attempt count must go through this rather than guessing
 * from the event type.
 */
export function formatForRound(
  round: Pick<Round, "format">,
  eventType: string | null | undefined,
): WcaFormat {
  return round.format ?? defaultFormatForEvent(eventType ?? "333");
}

/** Attempts a competitor gets in this round. */
export function attemptsForRound(
  round: Pick<Round, "format">,
  eventType: string | null | undefined,
): number {
  return FORMAT_ATTEMPTS[formatForRound(round, eventType)];
}

/** Attempts a cutoff applies to in this round (Regulation 9g). */
export function cutoffAttemptsForRound(
  round: Pick<Round, "format">,
  eventType: string | null | undefined,
): number {
  return FORMAT_CUTOFF_ATTEMPTS[formatForRound(round, eventType)];
}

/**
 * Cutoff for a round: the round's own value, or the competition event's as the
 * inherited default. `null` on the round is not distinguished from unset — a
 * round that should have no cutoff is expressed by the event having none.
 */
export function cutoffForRound(
  round: Pick<Round, "cutoffMs">,
  event: Pick<CompetitionEvent, "cutoffMs"> | null | undefined,
): number | undefined {
  return round.cutoffMs ?? event?.cutoffMs ?? undefined;
}

/** Per-attempt time limit for a round, inherited from the event when unset. */
export function timeLimitForRound(
  round: Pick<Round, "timeLimitMs">,
  event: Pick<CompetitionEvent, "timeLimitMs"> | null | undefined,
): number | undefined {
  return round.timeLimitMs ?? event?.timeLimitMs ?? undefined;
}
