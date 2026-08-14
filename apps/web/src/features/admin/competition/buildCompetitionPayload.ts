import {
  hoursToMinutes,
  minutesToHours,
  paiseToRupees,
  rupeesToPaise,
  toISO,
  toLocalDatetime,
  toPositiveInt,
  type CompetitionDetailsValue,
} from "./competitionFields";

/**
 * The competition-level request body, matching the API's `CompetitionInput`.
 * The same shape is accepted by `POST /admin/competitions` and
 * `PATCH /admin/competitions/:id`.
 */
export interface CompetitionPayload {
  title: string;
  type: string;
  description?: string;
  rulesMd?: string;
  ruleSetIds?: string[];
  baseFee?: number;
  perEventFee?: number;
  registrationLimit?: number | null;
  videoDeadlineMinutes?: number;
  featured?: boolean;
  featuredOrder?: number;
  registrationOpensAt?: string | null;
  registrationDeadline?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
}

/**
 * Build the request body from form state.
 *
 * One builder for both screens. Create used to trim the title and omit a blank
 * description while Manage sent both untrimmed and always — so the same form
 * values produced different requests depending on which screen you were on.
 *
 * A field the form still shows sends its value — blank meaning an explicit
 * clear. A field the form hides omits its key entirely, so the stored value is
 * left alone rather than being wiped by a blank input.
 */
export function buildCompetitionPayload(value: CompetitionDetailsValue): CompetitionPayload {
  const isFree = value.type === "free";

  return {
    title: value.title.trim(),
    type: value.type,
    description: value.description.trim(),
    rulesMd: value.rulesMd.trim(),
    ruleSetIds: value.ruleSetIds,
    // A free competition has no fees; sending 0 rather than omitting them means
    // switching paid → free actually clears the old amounts.
    baseFee: isFree ? 0 : rupeesToPaise(value.baseFee) ?? 0,
    perEventFee: isFree ? 0 : rupeesToPaise(value.perEventFee) ?? 0,
    // `registrationLimit` is deliberately NOT sent. The input is hidden, so the
    // form value is always blank — emitting it would send null and wipe the
    // stored limit on every save. Omitting the key leaves it untouched.

    // Typed in hours, stored in minutes — the API and every deadline
    // calculation work in minutes.
    ...(hoursToMinutes(value.videoDeadlineHours) !== undefined
      ? { videoDeadlineMinutes: hoursToMinutes(value.videoDeadlineHours) }
      : {}),
    featured: value.featured,
    ...(value.featured && toPositiveInt(value.featuredOrder) !== undefined
      ? { featuredOrder: toPositiveInt(value.featuredOrder) }
      : {}),
    registrationOpensAt: toISO(value.registrationOpensAt),
    registrationDeadline: toISO(value.registrationDeadline),
    startsAt: toISO(value.startsAt),
    endsAt: toISO(value.endsAt),
  };
}

/** Hydrate form state from a fetched competition. The inverse of the builder. */
export function competitionToDetailsValue(comp: {
  title: string;
  type: string;
  description?: string;
  rulesMd?: string;
  /** Resolved rule sets from the API — the form only needs their ids. */
  ruleSets?: { id: string }[];
  baseFee?: number;
  perEventFee?: number;
  registrationLimit?: number | null;
  videoDeadlineMinutes?: number | null;
  featured?: boolean;
  featuredOrder?: number | null;
  registrationOpensAt?: string | null;
  registrationDeadline?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
}): CompetitionDetailsValue {
  return {
    title: comp.title ?? "",
    description: comp.description ?? "",
    rulesMd: comp.rulesMd ?? "",
    ruleSetIds: (comp.ruleSets ?? []).map((rs) => rs.id),
    type: comp.type === "paid" ? "paid" : "free",
    baseFee: paiseToRupees(comp.baseFee),
    perEventFee: paiseToRupees(comp.perEventFee),
    registrationLimit: comp.registrationLimit == null ? "" : String(comp.registrationLimit),
    videoDeadlineHours: minutesToHours(comp.videoDeadlineMinutes),
    featured: comp.featured ?? false,
    featuredOrder: comp.featuredOrder == null ? "" : String(comp.featuredOrder),
    registrationOpensAt: toLocalDatetime(comp.registrationOpensAt),
    registrationDeadline: toLocalDatetime(comp.registrationDeadline),
    startsAt: toLocalDatetime(comp.startsAt),
    endsAt: toLocalDatetime(comp.endsAt),
  };
}
