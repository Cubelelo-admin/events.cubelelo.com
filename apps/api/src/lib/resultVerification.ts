import { randomUUID } from "node:crypto";
import type { FlagStatus, SolvePenalty } from "@cubers/types";
import type { Repository } from "../db/repo";
import type { AuditLogEntry, Result } from "../db/types";
import type { Realtime } from "../sockets/realtime";
import { applyResultOverride, parseSolvePenalties, requiresAttemptPenalties } from "./resultStats";
import { reshortlistAdvancedRound } from "./roundLifecycle";

/** The verdicts a judge or admin may record against a result. */
export const FLAG_ACTIONS: FlagStatus[] = ["verified", "plus2", "dnf", "disqualified"];

/** Verdicts that take something away, and therefore need a stated reason. */
const DESTRUCTIVE: FlagStatus[] = ["plus2", "dnf", "disqualified"];

export interface VerifyInput {
  result: Result;
  action: FlagStatus | undefined;
  reason?: string;
  comment?: string;
  solvePenalties?: (SolvePenalty | null)[];
  /** Who is recording the verdict. */
  actorId: string;
  /**
   * Audit action prefix — `result` for admins, `judge_result` for judges,
   * `bulk_result` for a bulk action. The one thing the callers legitimately
   * record differently.
   */
  auditPrefix: "result" | "judge_result" | "bulk_result";
}

export type VerifyOutcome =
  | { ok: true; flagStatus: FlagStatus }
  | { ok: false; status: number; error: string };

/**
 * Record a verdict against a result.
 *
 * This is everything the admin and judge verify routes do *after* deciding the
 * caller is allowed in. The two used to be ~70 duplicated lines that differed
 * only in authorization and the audit prefix, so every fix had to land twice —
 * the `plus2`/`dnf` enum crash lived in both copies, and so did the missing
 * appeal handling. Authorization deliberately stays with each route, because
 * that is the one thing they genuinely do differently.
 *
 * It does not advance anyone: shortlisting happens when the verifier publishes
 * the round. The one exception is a disqualification on a round that has already
 * advanced, which re-derives that round's shortlist so the disqualified
 * competitor loses their place in the next one.
 */
export async function verifyResult(
  repo: Repository,
  realtime: Realtime,
  input: VerifyInput,
): Promise<VerifyOutcome> {
  const { result, action, actorId, auditPrefix } = input;

  if (!action || !FLAG_ACTIONS.includes(action)) {
    return { ok: false, status: 400, error: "invalid_action" };
  }
  if (DESTRUCTIVE.includes(action) && !input.reason) {
    return { ok: false, status: 400, error: "reason_required" };
  }

  const solvePenalties = parseSolvePenalties(input.solvePenalties, result.solves.length);
  if (solvePenalties === "invalid") {
    return { ok: false, status: 400, error: "invalid_solve_penalties" };
  }
  // A +2 or DNF belongs to a specific attempt; refuse to guess which.
  if (requiresAttemptPenalties(action) && !solvePenalties) {
    return { ok: false, status: 400, error: "attempt_penalties_required" };
  }

  const now = new Date().toISOString();

  await repo.results.update(result.id, {
    flagStatus: action,
    verifiedBy: actorId,
    verifiedAt: now,
    verificationComment: input.comment || undefined,
  });

  // §10 — audit trail with old and new values.
  const entry: AuditLogEntry = {
    id: randomUUID(),
    adminId: actorId,
    action: `${auditPrefix}_${action}`,
    target: result.id,
    reason: input.reason,
    oldValue: JSON.stringify({
      flagStatus: result.flagStatus,
      flagReasons: result.flagReasons,
      judgeOverrides: result.judgeOverrides ?? null,
    }),
    newValue: JSON.stringify({
      flagStatus: action,
      comment: input.comment || null,
      solvePenalties: solvePenalties ?? null,
    }),
    createdAt: now,
  };
  await repo.auditLog.create(entry);

  // Re-derive stats under the verdict, re-rank, rebuild the competitor's PB and
  // broadcast. Runs for every action, so a "verified" verdict also restores the
  // stats a previous penalty changed.
  await applyResultOverride(repo, realtime, result, action, solvePenalties);

  const round = await repo.rounds.findById(result.roundId);
  if (round && round.status === "advanced" && action === "disqualified") {
    await reshortlistAdvancedRound(repo, realtime, round, result.userId);
  }

  return { ok: true, flagStatus: action };
}
