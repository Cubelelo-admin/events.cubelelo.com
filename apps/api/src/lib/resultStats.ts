import { randomUUID } from "node:crypto";
import { computeStats, effectiveTime } from "@cubers/timer-core";
import type { FlagStatus, Solve, SolvePenalty, WcaFormat } from "@cubers/types";
import { FORMAT_AVERAGE_STAT } from "@cubers/types";
import { formatForRound } from "./roundFormat";
import { setLeaderboardCache, type CachedLeaderboardEntry } from "./leaderboardCache";
import type { Repository } from "../db/repo";
import type { Result } from "../db/types";
import type { Realtime } from "../sockets/realtime";

/** The subset of a result the ranking rules actually read. */
export interface RankableResult {
  id: string;
  ao5Ms: number | null;
  meanMs: number | null;
  bestSingleMs: number | null;
  flagStatus: string;
}

/** A null stat (DNF average, no valid single) sorts last. */
const key = (n: number | null): number => (n === null ? Number.POSITIVE_INFINITY : n);

/**
 * The two values a competitor is ranked on, in order (WCA Regulation 9f9).
 *
 * Best-of formats rank on the single alone. Average formats rank on the format's
 * own average — Ao5 on the trimmed average, Mo3 on the arithmetic mean — with the
 * single as the tiebreak. Reading `ao5Ms` for every format is what previously made
 * Mo3 rounds fall through to being ranked by single, since `ao5()` returns null
 * for a 3-attempt set.
 */
export function rankingKeys(r: RankableResult, format: WcaFormat): [number, number] {
  const avgStat = FORMAT_AVERAGE_STAT[format];
  if (avgStat === null) return [key(r.bestSingleMs), key(r.bestSingleMs)];
  const average = avgStat === "ao5" ? r.ao5Ms : r.meanMs;
  return [key(average), key(r.bestSingleMs)];
}

/** Sort comparator for a round's standings. Shared by ranking and advancement. */
export function compareForRanking(format: WcaFormat) {
  return (a: RankableResult, b: RankableResult): number => {
    const [aPrimary, aSecondary] = rankingKeys(a, format);
    const [bPrimary, bSecondary] = rankingKeys(b, format);
    return aPrimary - bPrimary || aSecondary - bSecondary;
  };
}

/** True when two results are genuinely tied under this format's ranking rules. */
export function isTied(a: RankableResult, b: RankableResult, format: WcaFormat): boolean {
  const [aP, aS] = rankingKeys(a, format);
  const [bP, bS] = rankingKeys(b, format);
  return aP === bP && aS === bS;
}

/**
 * Rank every result in a round under its WCA format.
 *
 * Disqualified results are unranked (`rank: null`) rather than rank 0. Rank 0
 * sorted *above* rank 1 in every consumer that orders ascending, which put
 * disqualified entries at the top of the leaderboard.
 */
/**
 * Publish a round's standings: cache them and broadcast them.
 *
 * There used to be two ways this happened. Submitting a result built an enriched
 * board — competitor names joined in — cached it and emitted it. Every judge
 * verdict, appeal and re-shortlist went through `applyResultOverride`, which
 * emitted the raw results with no names and *cleared* the cache instead of
 * refilling it. Since the client replaces the board wholesale, a single +2 wiped
 * every name off the live leaderboard until the next refetch.
 *
 * One shape, one cache policy, both paths.
 */
export async function publishLeaderboard(
  repo: Repository,
  realtime: Realtime,
  roundId: string,
  board: Result[],
): Promise<CachedLeaderboardEntry[]> {
  const enriched = await buildLeaderboard(repo, board);
  await setLeaderboardCache(roundId, enriched);
  realtime.emitLeaderboard(roundId, enriched);
  return enriched;
}

/**
 * The board in rank order with competitor names joined in.
 *
 * Separate from publishing so a plain read can build the same shape without
 * broadcasting to everyone watching the round. This was written out by hand in
 * three places, each free to drift from the others.
 */
export async function buildLeaderboard(
  repo: Repository,
  board: Result[],
): Promise<CachedLeaderboardEntry[]> {
  const ordered = [...board].sort(
    (a, b) => (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER),
  );

  const usersMap = await repo.users.findByIds([...new Set(ordered.map((r) => r.userId))]);
  return ordered.map((r) => {
    const u = usersMap.get(r.userId);
    return {
      id: r.id,
      userId: r.userId,
      userName: u?.name ?? r.userId,
      userClId: u?.clId ?? r.userId,
      ao5Ms: r.ao5Ms,
      meanMs: r.meanMs,
      bestSingleMs: r.bestSingleMs,
      rank: r.rank,
      flagStatus: r.flagStatus,
    };
  });
}

export async function recomputeRanks(repo: Repository, roundId: string, prefetched?: Result[]): Promise<Result[]> {
  const all = prefetched ?? await repo.results.findByRound(roundId);
  const [round, event] = await Promise.all([
    repo.rounds.findById(roundId),
    repo.competitionEvents.findByRound(roundId),
  ]);
  const format = round ? formatForRound(round, event?.eventType) : "a";

  const updates = computeRankUpdates(all, format);
  await repo.results.updateRanks(updates);
  const rankMap = new Map(updates.map((u) => [u.id, u.rank]));
  return all.map((r) => ({ ...r, rank: rankMap.has(r.id) ? rankMap.get(r.id)! : r.rank }));
}

/**
 * Standard competition ranking: tied results share a rank and the next rank
 * skips accordingly (1, 2, 2, 4). Sequential `i + 1` numbering previously split
 * genuinely tied competitors in whatever order the repository happened to
 * return them.
 */
export function computeRankUpdates(
  all: RankableResult[],
  format: WcaFormat,
): { id: string; rank: number | null }[] {
  const eligible = all.filter((r) => r.flagStatus !== "disqualified");
  const disqualified = all.filter((r) => r.flagStatus === "disqualified");

  const ranked = [...eligible].sort(compareForRanking(format));

  const updates: { id: string; rank: number | null }[] = [];
  let currentRank = 0;
  ranked.forEach((r, i) => {
    const prev = ranked[i - 1];
    if (!prev || !isTied(prev, r, format)) currentRank = i + 1;
    updates.push({ id: r.id, rank: currentRank });
  });

  for (const r of disqualified) updates.push({ id: r.id, rank: null });
  return updates;
}

/**
 * The attempt set a result's stats are computed from: the competitor's raw
 * solves with the judge's per-attempt overrides layered on top.
 *
 * Raw solves are never mutated, so clearing the overrides restores the original
 * numbers exactly.
 */
export function effectiveSolves(
  solves: Solve[],
  overrides: (SolvePenalty | null)[] | undefined,
): Solve[] {
  if (!overrides?.length) return solves;
  return solves.map((s, i) => {
    const o = overrides[i];
    return o ? { ...s, penalty: o } : s;
  });
}

/**
 * Derived stats for a result under a judge action.
 *
 * A +2 or DNF belongs to one attempt (WCA 10f / A6), so it is applied to that
 * attempt and the whole stat block is recomputed. Adding a flat 2000 ms to the
 * single, average, mean and median simultaneously — as this previously did —
 * is wrong on every count: a +2 on one attempt moves an Ao5 by 0.667 s, or not
 * at all when that attempt is trimmed, and only touches the single if the
 * penalised attempt was the fastest.
 *
 * `disqualified` is genuinely result-level and leaves the stats intact; the
 * result is excluded from ranking and personal bests instead.
 */
function statsForOverrides(
  result: Result,
  overrides: (SolvePenalty | null)[] | undefined,
): Pick<Result, "bestSingleMs" | "ao5Ms" | "meanMs" | "medianMs" | "stdMs"> {
  const base = computeStats(effectiveSolves(result.solves, overrides));
  return {
    bestSingleMs: base.best_single_ms,
    ao5Ms: base.ao5_ms,
    meanMs: base.mean_ms,
    medianMs: base.median_ms,
    stdMs: base.std_ms,
  };
}

/**
 * Validate a `solvePenalties` array from a judge request.
 *
 * Returns `undefined` when the judge sent nothing (a result-level action),
 * `"invalid"` when the array is malformed or the wrong length for the result,
 * or the normalised array. An all-null array is treated as "no overrides" so a
 * judge clearing every penalty restores the raw stats.
 */
export function parseSolvePenalties(
  input: unknown,
  solveCount: number,
): (SolvePenalty | null)[] | undefined | "invalid" {
  if (input === undefined || input === null) return undefined;
  if (!Array.isArray(input) || input.length !== solveCount) return "invalid";

  const out: (SolvePenalty | null)[] = [];
  for (const raw of input) {
    if (raw === null || raw === undefined || raw === "none") {
      out.push(null);
    } else if (raw === "plus2" || raw === "dnf") {
      out.push(raw);
    } else {
      return "invalid";
    }
  }
  return out.some((p) => p !== null) ? out : undefined;
}

/**
 * Actions that name a penalty without naming an attempt. A +2 or DNF is a
 * property of one attempt, so these require the judge to say which — there is
 * no correct way to infer it, and guessing silently changes a competitor's
 * standing.
 */
export function requiresAttemptPenalties(action: FlagStatus): boolean {
  return action === "plus2" || action === "dnf";
}

/**
 * Resolve the overrides a judge action implies. Any action other than
 * `plus2`/`dnf` clears them, so a "verified" verdict restores the raw stats.
 */
export function overridesForAction(
  action: FlagStatus,
  explicit?: (SolvePenalty | null)[],
): (SolvePenalty | null)[] | undefined {
  if (!requiresAttemptPenalties(action)) return undefined;
  return explicit;
}

/**
 * Rebuild a user's personal best for an event from their non-disqualified
 * competition results. Overwrites (repo.personalBests.replace) so a PB set by
 * a since-penalized result is corrected, not just min-merged.
 */
export async function recomputePersonalBest(
  repo: Repository,
  userId: string,
  eventType: string,
): Promise<void> {
  const all = await repo.results.findByUser(userId);

  // One batched lookup, not one query per round. This runs on every result
  // submission and every judge verdict, and a competitor with results in twenty
  // rounds was costing twenty round-trips to resolve their event types.
  const eventByRound = await repo.competitionEvents.findByRounds([
    ...new Set(all.map((r) => r.roundId)),
  ]);

  const eligible = all.filter(
    (r) => eventByRound.get(r.roundId)?.eventType === eventType && r.flagStatus !== "disqualified",
  );

  const min = (pick: (r: Result) => number | null): number | null => {
    const vals = eligible.map(pick).filter((n): n is number => n !== null);
    return vals.length ? Math.min(...vals) : null;
  };

  const existing = (await repo.personalBests.findByUser(userId)).find(
    (pb) => pb.eventType === eventType,
  );
  await repo.personalBests.replace({
    id: existing?.id ?? randomUUID(),
    userId,
    eventType,
    bestSingleMs: min((r) => r.bestSingleMs),
    bestAo5Ms: min((r) => r.ao5Ms),
    bestMeanMs: min((r) => r.meanMs),
    bestMedianMs: min((r) => r.medianMs),
    bestRank: min((r) => (r.rank && r.rank > 0 ? r.rank : null)),
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Everything downstream of a judge/admin override (HIGH-009): re-derive the
 * result's stats under the action, re-rank the round, rebuild the user's PB,
 * and push the corrected leaderboard to the room.
 */
export async function applyResultOverride(
  repo: Repository,
  realtime: Realtime,
  result: Result,
  action: FlagStatus,
  /** Per-attempt penalties from the judge, parallel to `result.solves`. */
  solvePenalties?: (SolvePenalty | null)[],
): Promise<void> {
  const overrides = overridesForAction(action, solvePenalties);
  await repo.results.update(result.id, {
    ...statsForOverrides(result, overrides),
    judgeOverrides: overrides,
  });
  const board = await recomputeRanks(repo, result.roundId);

  const event = await repo.competitionEvents.findByRound(result.roundId);
  if (event) await recomputePersonalBest(repo, result.userId, event.eventType);

  // Replaces the cached board rather than dropping it, so the next reader does
  // not fall back to a rebuild — and carries the names the client needs.
  await publishLeaderboard(repo, realtime, result.roundId, board);
}
