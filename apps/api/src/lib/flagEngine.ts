/**
 * §6 — Auto-flagging rules engine.
 *
 * Evaluates a result against configurable rules and returns structured
 * FlagReason[] that get stored on the result.  Runs at submission time
 * and can be re-run on demand (e.g. after admin changes rule thresholds).
 *
 * Severity scale (used by §7 priority sort):
 *   10  near_record      — result suspiciously close to platform record
 *    8  personal_deviation — result much better than user's PB
 *    6  missing_video     — required video not provided
 *    4  invalid_video     — video URL doesn't look like a valid host
 *    3  borderline_cutoff — result sitting right on the advancement line
 *    1  (anticheat)       — legacy threshold flag (below absolute minimum)
 */

import type { FlagReason, FlagRuleDefaults, RecordReference, PersonalBest, AdvancementCriteria } from "../db/types";

const VALID_VIDEO_HOSTS = [
  "youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com",
  "drive.google.com", "docs.google.com",
  "vimeo.com",
];

export interface FlagContext {
  /** The result being evaluated. */
  bestSingleMs: number | null;
  ao5Ms: number | null;
  videoUrl: string | null;
  /** Round-level config. */
  videoRequired: boolean;
  advancementCriteria?: AdvancementCriteria;
  advancementCount?: number;
  /** Event type (e.g. "333"). */
  eventType: string;
  /** Global flag-rule thresholds. */
  rules: FlagRuleDefaults;
  /** Record reference for this event (from system settings). */
  record: RecordReference | null;
  /** The competitor's personal best (null if first-time competitor). */
  personalBest: PersonalBest | null;
  /**
   * All ranked results in the round so far (for borderline cutoff).
   * Only the `rank` and `ao5Ms` fields are needed.
   */
  roundResultCount: number;
}

/**
 * Compute all flag reasons for a result.  Returns an empty array when no
 * rules fire — the result is clean.
 */
export function computeFlags(ctx: FlagContext): FlagReason[] {
  const reasons: FlagReason[] = [];

  // 1. Near-record check
  if (ctx.rules.nearRecordPct > 0 && ctx.record) {
    const pct = ctx.rules.nearRecordPct / 100;

    if (ctx.ao5Ms !== null && ctx.ao5Ms !== Infinity && ctx.record.ao5Ms) {
      if (ctx.ao5Ms <= ctx.record.ao5Ms * (1 + pct)) {
        reasons.push({
          type: "near_record",
          message: `ao5 ${fmtMs(ctx.ao5Ms)} is within ${ctx.rules.nearRecordPct}% of the record (${fmtMs(ctx.record.ao5Ms)})`,
          severity: 10,
        });
      }
    }

    if (ctx.bestSingleMs !== null && ctx.bestSingleMs !== Infinity && ctx.record.singleMs) {
      if (ctx.bestSingleMs <= ctx.record.singleMs * (1 + pct)) {
        reasons.push({
          type: "near_record",
          message: `Best single ${fmtMs(ctx.bestSingleMs)} is within ${ctx.rules.nearRecordPct}% of the record (${fmtMs(ctx.record.singleMs)})`,
          severity: 10,
        });
      }
    }
  }

  // 2. Personal deviation check
  if (ctx.rules.personalDeviationPct > 0 && ctx.personalBest) {
    const threshold = ctx.rules.personalDeviationPct / 100;

    if (ctx.ao5Ms !== null && ctx.ao5Ms !== Infinity && ctx.personalBest.bestAo5Ms !== null) {
      const improvement = 1 - ctx.ao5Ms / ctx.personalBest.bestAo5Ms;
      if (improvement > threshold) {
        reasons.push({
          type: "personal_deviation",
          message: `ao5 ${fmtMs(ctx.ao5Ms)} is ${Math.round(improvement * 100)}% better than PB (${fmtMs(ctx.personalBest.bestAo5Ms)})`,
          severity: 8,
        });
      }
    }

    if (ctx.bestSingleMs !== null && ctx.bestSingleMs !== Infinity && ctx.personalBest.bestSingleMs !== null) {
      const improvement = 1 - ctx.bestSingleMs / ctx.personalBest.bestSingleMs;
      if (improvement > threshold) {
        reasons.push({
          type: "personal_deviation",
          message: `Best single ${fmtMs(ctx.bestSingleMs)} is ${Math.round(improvement * 100)}% better than PB (${fmtMs(ctx.personalBest.bestSingleMs)})`,
          severity: 8,
        });
      }
    }
  }

  // 3. Missing video
  if (ctx.rules.missingVideo && ctx.videoRequired && !ctx.videoUrl) {
    reasons.push({
      type: "missing_video",
      message: "This round requires a video submission but none was provided",
      severity: 6,
    });
  }

  // 4. Invalid video host
  if (ctx.videoUrl) {
    try {
      const host = new URL(ctx.videoUrl).hostname.toLowerCase();
      const valid = VALID_VIDEO_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
      if (!valid) {
        reasons.push({
          type: "invalid_video",
          message: `Video URL host "${host}" is not a recognized video platform`,
          severity: 4,
        });
      }
    } catch {
      reasons.push({
        type: "invalid_video",
        message: "Video URL is malformed",
        severity: 4,
      });
    }
  }

  // 5. Borderline cutoff
  if (ctx.rules.borderlineCutoffMargin > 0 && ctx.advancementCount && ctx.advancementCount > 0) {
    // We can only do rank-based borderline check when we know the result count
    // The result hasn't been ranked yet at submission time, so we estimate
    // based on how many results exist: if the round is near capacity and
    // advancement is limited, flag results whose rank would be near the line.
    // This is a heuristic — exact borderline flagging happens after ranking.
    // For now, flag if the result count is within margin of advancement count.
    const cutoffLine = ctx.advancementCount;
    const margin = ctx.rules.borderlineCutoffMargin;
    const resultCount = ctx.roundResultCount + 1; // including this one
    if (resultCount >= cutoffLine - margin && resultCount <= cutoffLine + margin) {
      reasons.push({
        type: "borderline_cutoff",
        message: `Result count (${resultCount}) is near the advancement cutoff (top ${cutoffLine})`,
        severity: 3,
      });
    }
  }

  return reasons;
}

/**
 * §7 — Compute priority score for a result.
 * Higher = more urgent to review.
 * Used to sort the flagged tab in the verification workspace.
 */
export function computePriority(reasons: FlagReason[]): number {
  if (reasons.length === 0) return 0;
  // Priority = sum of severities (so multiple flags compound)
  // with a bonus for the max severity (so a single critical flag still ranks high)
  const sum = reasons.reduce((acc, r) => acc + r.severity, 0);
  const max = Math.max(...reasons.map((r) => r.severity));
  return sum + max;
}

/** Format milliseconds as seconds with 2 decimal places. */
function fmtMs(ms: number): string {
  return `${(ms / 1000).toFixed(2)}s`;
}
