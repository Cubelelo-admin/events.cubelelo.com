import { describe, it, expect } from "vitest";
import type { WcaFormat } from "@cubers/types";
import { computeRankUpdates, type RankableResult } from "../src/lib/resultStats";

/**
 * WCA ranking rules (Regulation 9f9), exercised directly on the pure ranking
 * function so each rule is pinned independently of the HTTP layer.
 */

const r = (
  id: string,
  stats: { ao5Ms?: number | null; meanMs?: number | null; bestSingleMs?: number | null },
  flagStatus = "clean",
): RankableResult => ({
  id,
  ao5Ms: stats.ao5Ms ?? null,
  meanMs: stats.meanMs ?? null,
  bestSingleMs: stats.bestSingleMs ?? null,
  flagStatus,
});

/** Rank by id, for readable assertions. */
function ranksOf(results: RankableResult[], format: WcaFormat): Record<string, number | null> {
  return Object.fromEntries(computeRankUpdates(results, format).map((u) => [u.id, u.rank]));
}

describe("ranking metric follows the round format", () => {
  it("ranks an Average-of-5 round on ao5", () => {
    const ranks = ranksOf(
      [
        r("slow", { ao5Ms: 12_000, bestSingleMs: 9_000 }),
        r("fast", { ao5Ms: 10_000, bestSingleMs: 11_000 }),
      ],
      "a",
    );
    expect(ranks.fast).toBe(1);
    expect(ranks.slow).toBe(2);
  });

  it("ranks a Mean-of-3 round on the mean, not the single", () => {
    // ao5Ms is null for a 3-attempt set. Reading it for every format made these
    // rounds fall through to being ranked by best single, which would have put
    // "worseMean" first.
    const ranks = ranksOf(
      [
        r("worseMean", { meanMs: 95_000, bestSingleMs: 80_000 }),
        r("betterMean", { meanMs: 90_000, bestSingleMs: 88_000 }),
      ],
      "m",
    );
    expect(ranks.betterMean).toBe(1);
    expect(ranks.worseMean).toBe(2);
  });

  it("ranks a Best-of-3 round on the single alone", () => {
    const ranks = ranksOf(
      [
        r("worseSingle", { meanMs: 60_000, bestSingleMs: 70_000 }),
        r("betterSingle", { meanMs: 90_000, bestSingleMs: 65_000 }),
      ],
      "3",
    );
    expect(ranks.betterSingle).toBe(1);
    expect(ranks.worseSingle).toBe(2);
  });
});

describe("tie handling", () => {
  it("gives tied competitors the same rank and skips the next", () => {
    const ranks = ranksOf(
      [
        r("a", { ao5Ms: 10_000, bestSingleMs: 9_000 }),
        r("b", { ao5Ms: 10_000, bestSingleMs: 9_000 }),
        r("c", { ao5Ms: 11_000, bestSingleMs: 9_500 }),
      ],
      "a",
    );
    expect(ranks.a).toBe(1);
    expect(ranks.b).toBe(1);
    expect(ranks.c).toBe(3); // rank 2 is consumed by the tie
  });

  it("breaks an equal average on the better single", () => {
    const ranks = ranksOf(
      [
        r("worseSingle", { ao5Ms: 10_000, bestSingleMs: 9_500 }),
        r("betterSingle", { ao5Ms: 10_000, bestSingleMs: 8_000 }),
      ],
      "a",
    );
    expect(ranks.betterSingle).toBe(1);
    expect(ranks.worseSingle).toBe(2);
  });
});

describe("DNF and disqualification ordering", () => {
  it("sorts a DNF average below every valid average", () => {
    const ranks = ranksOf(
      [
        r("dnfAverage", { ao5Ms: null, bestSingleMs: 5_000 }),
        r("valid", { ao5Ms: 20_000, bestSingleMs: 19_000 }),
      ],
      "a",
    );
    expect(ranks.valid).toBe(1);
    expect(ranks.dnfAverage).toBe(2);
  });

  it("leaves disqualified results unranked rather than at rank 0", () => {
    const ranks = ranksOf(
      [
        r("dq", { ao5Ms: 5_000, bestSingleMs: 4_000 }, "disqualified"),
        r("clean", { ao5Ms: 20_000, bestSingleMs: 19_000 }),
      ],
      "a",
    );
    expect(ranks.clean).toBe(1);
    // A rank of 0 sorted above rank 1 in every consumer that orders ascending,
    // so a disqualified competitor appeared at the top of the leaderboard.
    expect(ranks.dq).toBeNull();
  });

  it("does not let a disqualified result consume a rank number", () => {
    const ranks = ranksOf(
      [
        r("dq", { ao5Ms: 5_000, bestSingleMs: 4_000 }, "disqualified"),
        r("first", { ao5Ms: 10_000, bestSingleMs: 9_000 }),
        r("second", { ao5Ms: 11_000, bestSingleMs: 9_500 }),
      ],
      "a",
    );
    expect(ranks.first).toBe(1);
    expect(ranks.second).toBe(2);
  });
});
