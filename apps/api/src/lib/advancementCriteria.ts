import type { AdvancementCriteria } from "../db/types";

/**
 * Validation for a round's advancement criteria.
 *
 * `PATCH /admin/rounds/:id` validated each method's required field, while the
 * competition create and update endpoints cast `criteria.method` straight to the
 * union with no checking at four separate sites. A criteria of
 * `{ method: "banana" }`, or `{ method: "rank" }` with no `rankLimit`, persisted
 * into `rounds.advancement_criteria` and then silently advanced nobody
 * (`applyMethod` returns `[]` for anything it does not recognise). One validator
 * for every writer.
 */

export interface RawAdvancementCriteria {
  method?: string;
  rankLimit?: number;
  timeLimitMs?: number;
  bestSingleMs?: number;
}

export type CriteriaResult =
  | { ok: true; criteria: AdvancementCriteria | undefined }
  | { ok: false; code: string };

/**
 * Parse and validate criteria from a request.
 *
 * `null` and `undefined` both mean "no criteria" and yield `criteria: undefined`.
 * Fields irrelevant to the chosen method are dropped rather than persisted, so a
 * stored criteria always carries exactly the one limit its method uses.
 */
export function parseAdvancementCriteria(raw: unknown): CriteriaResult {
  if (raw === null || raw === undefined) return { ok: true, criteria: undefined };
  if (typeof raw !== "object") return { ok: false, code: "invalid_advancement_method" };

  const c = raw as RawAdvancementCriteria;

  if (c.method === "rank") {
    if (!c.rankLimit || c.rankLimit < 1) return { ok: false, code: "rank_limit_required" };
    return { ok: true, criteria: { method: "rank", rankLimit: Math.round(c.rankLimit) } };
  }
  if (c.method === "time") {
    if (!c.timeLimitMs || c.timeLimitMs < 1) return { ok: false, code: "time_limit_required" };
    return { ok: true, criteria: { method: "time", timeLimitMs: Math.round(c.timeLimitMs) } };
  }
  if (c.method === "best_single") {
    if (!c.bestSingleMs || c.bestSingleMs < 1) return { ok: false, code: "best_single_limit_required" };
    return { ok: true, criteria: { method: "best_single", bestSingleMs: Math.round(c.bestSingleMs) } };
  }
  return { ok: false, code: "invalid_advancement_method" };
}
