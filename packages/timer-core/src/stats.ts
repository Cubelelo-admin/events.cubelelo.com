import type { Solve, SolveStats } from "@cubers/types";

/** Internal sentinel for a DNF when reducing to comparable numbers. */
const DNF = Number.POSITIVE_INFINITY;

/** Averages above this are rounded to the nearest second, not centisecond (WCA 9f2). */
const TEN_MINUTES_MS = 600_000;

/**
 * Round an average or mean per WCA Regulation 9f2: to the nearest centisecond,
 * or — for results over ten minutes — to the nearest second.
 *
 * Raw attempt times are untouched; only the derived average is rounded. Rounding
 * to the nearest millisecond, as this previously did, produces averages that
 * cannot be represented in official results.
 */
export function roundAverage(ms: number): number {
  if (ms > TEN_MINUTES_MS) return Math.round(ms / 1000) * 1000;
  return Math.round(ms / 10) * 10;
}

/** Effective time of a solve: either DNF → Infinity, or raw + inspection +2 + manual +2. */
export function effectiveTime(solve: Solve): number {
  const insp = solve.inspectionPenalty ?? "none";
  const manual = solve.penalty;
  if (insp === "dnf" || manual === "dnf") return DNF;
  let extra = 0;
  if (insp === "plus2") extra += 2000;
  if (manual === "plus2") extra += 2000;
  return solve.time_ms + extra;
}

/** Best (fastest) valid single, or null if every solve is a DNF / no solves. */
export function bestSingle(solves: Solve[]): number | null {
  const valid = solves.map(effectiveTime).filter((t) => t !== DNF);
  return valid.length ? Math.min(...valid) : null;
}

/** Arithmetic mean of all solves. WCA: any DNF makes the mean a DNF (→ null). */
export function mean(solves: Solve[]): number | null {
  if (solves.length === 0) return null;
  const times = solves.map(effectiveTime);
  if (times.some((t) => t === DNF)) return null;
  return roundAverage(times.reduce((a, b) => a + b, 0) / times.length);
}

/** Median of valid solves (DNFs excluded), or null if none are valid. */
export function median(solves: Solve[]): number | null {
  const valid = solves
    .map(effectiveTime)
    .filter((t) => t !== DNF)
    .sort((a, b) => a - b);
  if (valid.length === 0) return null;
  const mid = Math.floor(valid.length / 2);
  return valid.length % 2
    ? valid[mid]!
    : Math.round((valid[mid - 1]! + valid[mid]!) / 2);
}

/** Population standard deviation of valid solves, or null if none. */
export function stdDev(solves: Solve[]): number | null {
  const valid = solves.map(effectiveTime).filter((t) => t !== DNF);
  if (valid.length === 0) return null;
  const m = valid.reduce((a, b) => a + b, 0) / valid.length;
  const variance = valid.reduce((a, b) => a + (b - m) ** 2, 0) / valid.length;
  return Math.round(Math.sqrt(variance));
}

/**
 * WCA trimmed average of the last `count` solves.
 * Drops the fastest & slowest (5% rounded up from each end → 1 for ao5/ao12),
 * averages the rest. Returns null if there are fewer than `count` solves, or if
 * too many DNFs survive the trim (a "DNF average").
 */
export function average(solves: Solve[], count: number): number | null {
  if (solves.length < count) return null;
  const window = solves.slice(-count).map(effectiveTime);
  const trim = Math.ceil(count * 0.05);
  const dnfCount = window.filter((t) => t === DNF).length;
  if (dnfCount > trim) return null; // DNF average
  const sorted = [...window].sort((a, b) => a - b);
  const counting = sorted.slice(trim, count - trim);
  return roundAverage(counting.reduce((a, b) => a + b, 0) / counting.length);
}

export const ao5 = (solves: Solve[]): number | null => average(solves, 5);
export const ao12 = (solves: Solve[]): number | null => average(solves, 12);

/** Convenience: the full stat block stored on results / personal_bests. */
export function computeStats(solves: Solve[]): SolveStats {
  return {
    best_single_ms: bestSingle(solves),
    ao5_ms: ao5(solves),
    mean_ms: mean(solves),
    median_ms: median(solves),
    std_ms: stdDev(solves),
  };
}
