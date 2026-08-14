import type { CompType, WcaFormat } from "@cubers/types";
import { defaultFormatForEvent, isWcaFormat } from "@cubers/types";
import type { AdvancementCriteria, Competition } from "../../db/types";
import { parseAdvancementCriteria } from "../../lib/advancementCriteria";

/**
 * The competition authoring contract, shared by `POST /admin/competitions` and
 * `PATCH /admin/competitions/:id`.
 *
 * The two endpoints previously declared their own body types with field sets
 * that did not overlap in either direction — `registrationLimit` was create-only
 * (and the Manage screen's saves of it were silently discarded), while
 * `featured`, the banners and `cancellationReason` were update-only.
 * That asymmetry is what made the Create and Manage screens drift apart. One
 * type, one reducer: a field settable on one endpoint is settable on both.
 *
 * The few genuinely asymmetric fields are called out below and are *not* part of
 * this type.
 */

/** Advancement criteria as it arrives on the wire, before validation. */
export interface RawAdvancementCriteria {
  method: string;
  rankLimit?: number;
  timeLimitMs?: number;
  bestSingleMs?: number;
}

/** Per-round schedule slot inside an event spec. */
export interface RawRoundSchedule {
  startTime?: string;
  durationMinutes?: number;
}

/**
 * An event and its rounds.
 *
 * `roundCriteria` / `roundSchedule` accept `null` *or* `undefined` for a skipped
 * slot — the two endpoints previously declared one each for a structurally
 * identical payload.
 */
export interface CompetitionEventInput {
  eventType: string;
  roundCount?: number;
  /** Default cutoff for rounds of this event. Rounds may override it. */
  cutoffMs?: number;
  /** Default time limit for rounds of this event. Rounds may override it. */
  timeLimitMs?: number;
  fee?: number;
  /**
   * Hidden from competitors. Settable at create as well as update, because the
   * Create screen offers Archive rather than a discard action — an event you
   * decide against is created archived rather than not created at all.
   */
  archived?: boolean;
  durationMinutes?: number;
  advancementCount?: number;
  advancementCriteria?: RawAdvancementCriteria;
  roundCriteria?: Array<RawAdvancementCriteria | null | undefined>;
  roundSchedule?: Array<RawRoundSchedule | null | undefined>;
  /**
   * Per-round overrides, parallel to the rounds. A slot left empty falls back to
   * the event-level value — `cutoffMs` / `timeLimitMs` above, or the event's WCA
   * default format. These let a combined first round be followed by an
   * uncombined final, which is the normal WCA pattern.
   */
  roundFormats?: Array<string | null | undefined>;
  roundCutoffMs?: Array<number | null | undefined>;
  roundTimeLimitMs?: Array<number | null | undefined>;
  /**
   * Push a changed `cutoffMs` / `timeLimitMs` down onto rounds that have not been
   * given a deliberate override. Without it the event value only seeds new
   * rounds, so existing rounds keep whatever they were set to.
   */
  applyToExistingRounds?: boolean;
}

/** Every competition-level field either endpoint accepts. */
export interface CompetitionInput {
  title?: string;
  type?: CompType;
  description?: string;
  /** The admin's own additional rules text, on top of any selected rule sets. */
  rulesMd?: string;
  /**
   * Rule sets this competition uses, in display order. An empty array clears the
   * selection. Omitted means "leave as-is".
   */
  ruleSetIds?: string[];
  baseFee?: number;
  perEventFee?: number;
  registrationOpensAt?: string | null;
  registrationDeadline?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  registrationLimit?: number | null;
  videoDeadlineMinutes?: number;
  featured?: boolean;
  featuredOrder?: number;
  bannerUrl?: string;
  mobileBannerUrl?: string;
  events?: CompetitionEventInput[];
}

/**
 * Fields deliberately outside `CompetitionInput` because they only make sense on
 * one endpoint:
 *   - `saveAsDraft`  — create only; update uses `status`.
 *   - `status`       — update only; create always starts as a draft.
 *   - `cancellationReason` — update only; you cannot create a cancelled competition.
 *   - `eventType` / `roundCount` at the top level — the legacy single-event
 *     create shorthand, kept for older clients.
 */
export interface CreateOnlyInput {
  saveAsDraft?: boolean;
  eventType?: string;
  roundCount?: number;
}

/** Competition-level fields writable through the shared reducer. */
type WritableField = Exclude<keyof CompetitionInput, "events">;

/**
 * Apply the input's competition-level fields onto a partial Competition.
 *
 * Only keys actually present on `input` are touched, so a PATCH stays a partial
 * update. `null` on a nullable field clears it; `undefined` means "not supplied".
 * Returns an error code instead of throwing so callers can pick the status.
 */
export function applyCompetitionFields(
  input: CompetitionInput,
  target: Partial<Competition>,
  opts: { isAdmin: boolean },
): { ok: true } | { ok: false; status: number; code: string } {
  const has = (k: WritableField) => k in input && input[k] !== undefined;

  if (has("title") && typeof input.title === "string") target.title = input.title.trim();
  if (has("type") && input.type && COMP_TYPES.includes(input.type)) target.type = input.type;
  if (has("description") && typeof input.description === "string") target.description = input.description;
  if (has("rulesMd") && typeof input.rulesMd === "string") target.rulesMd = input.rulesMd;

  // Rule set associations live in their own table, so they are applied by the
  // route rather than folded into the competition row here.

  if (has("baseFee")) {
    if (typeof input.baseFee !== "number" || input.baseFee < 0 || !Number.isFinite(input.baseFee))
      return { ok: false, status: 400, code: "invalid_base_fee" };
    target.baseFee = Math.round(input.baseFee);
  }
  if (has("perEventFee")) {
    if (typeof input.perEventFee !== "number" || input.perEventFee < 0 || !Number.isFinite(input.perEventFee))
      return { ok: false, status: 400, code: "invalid_per_event_fee" };
    target.perEventFee = Math.round(input.perEventFee);
  }

  for (const key of ["registrationOpensAt", "registrationDeadline", "startsAt", "endsAt"] as const) {
    if (!(key in input)) continue;
    const value = input[key];
    if (value === null) {
      target[key] = undefined;
      continue;
    }
    if (typeof value !== "string") continue;
    // An unparseable date silently became NaN in every downstream comparison,
    // and NaN comparisons are false — so a bad date passed schedule validation.
    if (Number.isNaN(Date.parse(value))) return { ok: false, status: 400, code: "invalid_date" };
    target[key] = value;
  }

  if ("registrationLimit" in input) {
    const limit = input.registrationLimit;
    if (limit === null) {
      target.registrationLimit = undefined;
    } else if (typeof limit === "number" && limit > 0) {
      target.registrationLimit = Math.round(limit);
    } else if (limit !== undefined) {
      return { ok: false, status: 400, code: "invalid_registration_limit" };
    }
  }

  if (has("videoDeadlineMinutes")) {
    if (typeof input.videoDeadlineMinutes !== "number" || input.videoDeadlineMinutes < 0)
      return { ok: false, status: 400, code: "invalid_video_deadline" };
    target.videoDeadlineMinutes = Math.round(input.videoDeadlineMinutes);
  }

  // Only full admins may feature a competition; moderators can run their own
  // competitions but not promote them onto the homepage.
  if (has("featured") && typeof input.featured === "boolean") {
    if (!opts.isAdmin) return { ok: false, status: 403, code: "featured_admin_only" };
    target.featured = input.featured;
  }
  if (has("featuredOrder") && typeof input.featuredOrder === "number") {
    if (!opts.isAdmin) return { ok: false, status: 403, code: "featured_admin_only" };
    target.featuredOrder = input.featuredOrder;
  }

  if (has("bannerUrl") && typeof input.bannerUrl === "string") target.bannerUrl = input.bannerUrl;
  if (has("mobileBannerUrl") && typeof input.mobileBannerUrl === "string") {
    target.mobileBannerUrl = input.mobileBannerUrl;
  }

  return { ok: true };
}

/**
 * Validate the `ruleSetIds` array from a request.
 *
 * `undefined` means the caller did not mention rule sets, so the existing
 * selection is left alone. An empty array is meaningful — it clears the
 * selection. Duplicates are collapsed, matching the join table's primary key.
 */
export function parseRuleSetIds(input: unknown): string[] | undefined | "invalid" {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input)) return "invalid";
  if (input.some((id) => typeof id !== "string" || id.trim() === "")) return "invalid";
  return [...new Set(input as string[])];
}

/** Valid competition types. Mirrors the `CompType` union. */
export const COMP_TYPES: CompType[] = ["paid", "free", "practice"];

/** Rounds per event are clamped to this range wherever `roundCount` is written. */
export const MIN_ROUND_COUNT = 1;
export const MAX_ROUND_COUNT = 10;

export function clampRoundCount(value: number | undefined): number {
  return Math.max(MIN_ROUND_COUNT, Math.min(value ?? 1, MAX_ROUND_COUNT));
}

/** Re-exported for callers building round rows from an event spec. */
export type { AdvancementCriteria };

/**
 * Build one round row from an event spec.
 *
 * This loop existed three times — the create path, and both branches of the
 * PATCH event reconciliation — and had drifted: the new-event branch dropped
 * `advancementCount` entirely, and all three cast `criteria.method` to the union
 * with no validation. One builder, so a round created through any path is
 * identical.
 *
 * Returns an error code if the spec's criteria are invalid.
 */
export function buildRoundFields(
  spec: CompetitionEventInput,
  roundNumber: number,
  totalRounds: number,
): { ok: true; fields: RoundFields } | { ok: false; code: string } {
  const slot = spec.roundSchedule?.[roundNumber - 1];
  const durationMinutes = slot?.durationMinutes ?? spec.durationMinutes;
  const opensAt = slot?.startTime;

  let closesAt: string | undefined;
  if (opensAt && durationMinutes) {
    closesAt = new Date(new Date(opensAt).getTime() + durationMinutes * 60_000).toISOString();
  }

  // A per-round criteria wins; otherwise the event-level one applies to every
  // non-final round. The final round never advances anyone.
  const isFinal = roundNumber >= totalRounds;
  const rawCriteria = spec.roundCriteria?.[roundNumber - 1] ?? (isFinal ? undefined : spec.advancementCriteria);
  const parsed = parseAdvancementCriteria(rawCriteria);
  if (!parsed.ok) return { ok: false, code: parsed.code };

  // A per-round override wins; otherwise the event's value seeds the round.
  const rawFormat = spec.roundFormats?.[roundNumber - 1];
  const format = isWcaFormat(rawFormat) ? rawFormat : defaultFormatForEvent(spec.eventType);

  return {
    ok: true,
    fields: {
      format,
      cutoffMs: spec.roundCutoffMs?.[roundNumber - 1] ?? spec.cutoffMs,
      timeLimitMs: spec.roundTimeLimitMs?.[roundNumber - 1] ?? spec.timeLimitMs,
      advancementCount: isFinal ? undefined : spec.advancementCount,
      advancementCriteria: parsed.criteria,
      opensAt,
      closesAt,
      durationMinutes,
    },
  };
}

/** The round columns derived from an event spec. */
export interface RoundFields {
  format: WcaFormat;
  cutoffMs?: number;
  timeLimitMs?: number;
  advancementCount?: number;
  advancementCriteria?: AdvancementCriteria;
  opensAt?: string;
  closesAt?: string;
  durationMinutes?: number;
}
