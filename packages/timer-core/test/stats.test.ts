import { describe, it, expect } from "vitest";
import type { Solve } from "@cubers/types";
import {
  effectiveTime,
  bestSingle,
  mean,
  median,
  average,
  ao5,
  ao12,
} from "../src/stats.js";

const s = (time_ms: number, penalty: Solve["penalty"] = "none", inspectionPenalty: Solve["inspectionPenalty"] = "none"): Solve => ({
  time_ms,
  inspectionPenalty,
  penalty,
});

describe("effectiveTime", () => {
  it("adds 2000ms for +2 and returns Infinity for DNF", () => {
    expect(effectiveTime(s(10_000))).toBe(10_000);
    expect(effectiveTime(s(10_000, "plus2"))).toBe(12_000);
    expect(effectiveTime(s(10_000, "dnf"))).toBe(Infinity);
  });
});

describe("bestSingle", () => {
  it("returns the fastest valid single", () => {
    expect(bestSingle([s(10_000), s(9_000), s(11_000)])).toBe(9_000);
  });
  it("ignores DNFs but counts +2 time", () => {
    expect(bestSingle([s(8_000, "dnf"), s(9_000, "plus2")])).toBe(11_000);
  });
  it("returns null when all DNF", () => {
    expect(bestSingle([s(8_000, "dnf"), s(9_000, "dnf")])).toBeNull();
  });
});

describe("ao5 (WCA trimming)", () => {
  it("drops best and worst, averages the middle three", () => {
    expect(ao5([s(10_000), s(12_000), s(11_000), s(9_000), s(13_000)])).toBe(11_000);
  });
  it("a single DNF is treated as the worst and trimmed away", () => {
    expect(ao5([s(10_000), s(12_000), s(11_000), s(9_000, "dnf"), s(9_000)])).toBe(11_000);
  });
  it("two or more DNFs make the average a DNF (null)", () => {
    expect(ao5([s(10_000, "dnf"), s(12_000), s(11_000), s(9_000, "dnf"), s(13_000)])).toBeNull();
  });
  it("applies +2 before trimming", () => {
    // 9s+2 = 11s; set {10,11,11,12,13} → trim 10 & 13 → mean(11,11,12)=11333.3,
    // rounded to the nearest centisecond per WCA 9f2 → 11.33 s.
    expect(ao5([s(10_000), s(12_000), s(11_000), s(9_000, "plus2"), s(13_000)])).toBe(11_330);
  });
  it("returns null with fewer than 5 solves", () => {
    expect(ao5([s(10_000), s(11_000)])).toBeNull();
  });
});

describe("ao12", () => {
  it("averages the middle 10 of 12", () => {
    const solves = Array.from({ length: 12 }, (_, i) => s((i + 1) * 1000));
    // trim 1000 & 12000 → mean(2000..11000) = 6500
    expect(ao12(solves)).toBe(6_500);
  });
});

describe("mean & median", () => {
  it("mean is DNF (null) if any solve is DNF", () => {
    expect(mean([s(10_000), s(12_000, "dnf"), s(11_000)])).toBeNull();
  });
  it("mean averages all when valid", () => {
    expect(mean([s(10_000), s(12_000), s(11_000)])).toBe(11_000);
  });
  it("median of odd count", () => {
    expect(median([s(10_000), s(12_000), s(11_000)])).toBe(11_000);
  });
});

describe("average uses only the last N solves", () => {
  it("rolls over the most recent 5", () => {
    const solves = [s(99_000), s(10_000), s(12_000), s(11_000), s(9_000), s(13_000)];
    expect(average(solves, 5)).toBe(11_000); // ignores the leading 99s
  });
});

describe("WCA 9f2 rounding", () => {
  it("rounds an average to the nearest centisecond, not millisecond", () => {
    // mean(11_000, 11_000, 12_000) = 11333.33… → 11.33 s
    expect(ao5([s(10_000), s(12_000), s(11_000), s(11_000), s(13_000)])).toBe(11_330);
  });

  it("rounds .005 s up to the next centisecond", () => {
    // mean(10_000, 10_000, 10_017) = 10005.67… → 10.01 s
    expect(mean([s(10_000), s(10_000), s(10_017)])).toBe(10_010);
  });

  it("rounds averages over ten minutes to the nearest second", () => {
    // mean(700_400, 700_400, 700_400) = 700400 → 700 s
    expect(mean([s(700_400), s(700_400), s(700_400)])).toBe(700_000);
  });

  it("leaves an average of exactly ten minutes on the centisecond rule", () => {
    expect(mean([s(600_000), s(600_000), s(600_000)])).toBe(600_000);
  });

  it("does not round raw singles", () => {
    expect(bestSingle([s(11_333), s(12_000)])).toBe(11_333);
  });
});
