import { describe, it, expect } from "vitest";
import type { WcaFormat } from "@cubers/types";
import { computeShortlist, advancementCap } from "../src/lib/roundLifecycle";
import type { RankableResult } from "../src/lib/resultStats";

/**
 * WCA advancement rules (Regulation 9p), exercised on the pure shortlist
 * function.
 */

const c = (
  id: string,
  ao5Ms: number,
  bestSingleMs = ao5Ms - 1000,
): RankableResult & { userId: string } => ({
  id,
  userId: id,
  ao5Ms,
  meanMs: null,
  bestSingleMs,
  flagStatus: "clean",
});

/** A field of `n` competitors, each strictly slower than the last. */
const field = (n: number) =>
  Array.from({ length: n }, (_, i) => c(`c${i + 1}`, 10_000 + i * 1000));

const ids = (rs: { id: string }[]) => rs.map((r) => r.id);

describe("75% advancement cap (9p1)", () => {
  it("caps a rankLimit larger than three quarters of the field", () => {
    // 10 competitors, organiser asked for 9 → only 7 may advance.
    const out = computeShortlist(field(10), { method: "rank", rankLimit: 9 }, undefined, "a");
    expect(out).toHaveLength(7);
    expect(ids(out)).toEqual(["c1", "c2", "c3", "c4", "c5", "c6", "c7"]);
  });

  it("leaves a rankLimit under the cap alone", () => {
    const out = computeShortlist(field(10), { method: "rank", rankLimit: 4 }, undefined, "a");
    expect(ids(out)).toEqual(["c1", "c2", "c3", "c4"]);
  });

  it("caps a time-based criterion that would advance everyone", () => {
    // Every competitor is under the threshold, but only 75% may advance.
    const out = computeShortlist(
      field(8),
      { method: "time", timeLimitMs: 999_000 },
      undefined,
      "a",
    );
    expect(out).toHaveLength(6);
  });

  it("caps the legacy advancementCount path too", () => {
    const out = computeShortlist(field(10), undefined, 10, "a");
    expect(out).toHaveLength(7);
  });

  it("computes the cap by flooring", () => {
    expect(advancementCap(10)).toBe(7); // 7.5 → 7
    expect(advancementCap(8)).toBe(6);
    expect(advancementCap(4)).toBe(3);
  });
});

describe("minimum competitor count", () => {
  it("advances nobody from a single-competitor round", () => {
    expect(computeShortlist([c("solo", 10_000)], { method: "rank", rankLimit: 1 }, undefined, "a"))
      .toEqual([]);
  });
});

describe("tie-safe advancement boundary (9p3)", () => {
  it("extends the shortlist to include everyone tied on the limit line", () => {
    // c3 and c4 are identical; a rankLimit of 3 must not split them, and 4 of 8
    // is still within the 75% cap.
    const competitors = [
      c("c1", 10_000),
      c("c2", 11_000),
      c("c3", 12_000, 9_000),
      c("c4", 12_000, 9_000),
      ...Array.from({ length: 4 }, (_, i) => c(`c${i + 5}`, 20_000 + i * 1000)),
    ];
    const out = computeShortlist(competitors, { method: "rank", rankLimit: 3 }, undefined, "a");
    expect(ids(out)).toEqual(["c1", "c2", "c3", "c4"]);
  });

  it("drops a whole tied group rather than splitting it at the 75% cap", () => {
    // 4 competitors → cap is 3, but ranks 3 and 4 are tied. Advancing one and
    // not the other would decide it on array order, so neither advances.
    const competitors = [
      c("c1", 10_000),
      c("c2", 11_000),
      c("c3", 12_000, 9_000),
      c("c4", 12_000, 9_000),
    ];
    const out = computeShortlist(competitors, { method: "rank", rankLimit: 4 }, undefined, "a");
    expect(ids(out)).toEqual(["c1", "c2"]);
  });

  it("still splits competitors who only look tied on the average", () => {
    // Equal ao5, different singles — genuinely separable under 9f9.
    const competitors = [
      c("c1", 10_000),
      c("c2", 11_000),
      c("slower", 12_000, 9_500),
      c("faster", 12_000, 9_000),
    ];
    const out = computeShortlist(competitors, { method: "rank", rankLimit: 3 }, undefined, "a");
    expect(ids(out)).toEqual(["c1", "c2", "faster"]);
  });
});

describe("format-aware advancement", () => {
  it("uses the mean for a Mean-of-3 round's time criterion", () => {
    const competitors: RankableResult[] = [
      { id: "fast", ao5Ms: null, meanMs: 90_000, bestSingleMs: 88_000, flagStatus: "clean" },
      { id: "slow", ao5Ms: null, meanMs: 200_000, bestSingleMs: 190_000, flagStatus: "clean" },
    ];
    // Reading ao5Ms (null for a 3-attempt set) meant nobody ever cleared the bar.
    const out = computeShortlist(
      competitors,
      { method: "time", timeLimitMs: 100_000 },
      undefined,
      "m" as WcaFormat,
    );
    expect(ids(out)).toEqual(["fast"]);
  });
});
