"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { formatTime } from "@cubers/timer-core";
import type { ResultDto } from "@/lib/api";
import { SkeletonRow } from "@/components/Skeleton";

export function ResultTable({
  results,
  showFlagStatus,
  live = false,
}: {
  results: ResultDto[];
  showFlagStatus: boolean;
  live?: boolean;
}) {
  const prevRanks = useRef<Map<string, number | null>>(new Map());
  const [justMoved, setJustMoved] = useState<Set<string>>(new Set());

  useEffect(() => {
    if (!live) return;
    const moved = new Set<string>();
    for (const r of results) {
      const prev = prevRanks.current.get(r.id);
      if (prev !== undefined && prev !== r.rank) moved.add(r.id);
    }
    if (moved.size > 0) {
      setJustMoved(moved);
      const t = setTimeout(() => setJustMoved(new Set()), 1200);
      prevRanks.current = new Map(results.map((r) => [r.id, r.rank]));
      return () => clearTimeout(t);
    }
    prevRanks.current = new Map(results.map((r) => [r.id, r.rank]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, live]);

  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="w-full text-left text-sm">
        <thead className="bg-zinc-50 dark:bg-zinc-900/60">
          <tr>
            <th className="px-4 py-3 font-medium text-zinc-500">Rank</th>
            <th className="px-4 py-3 font-medium text-zinc-500">Competitor</th>
            <th className="px-4 py-3 font-medium text-zinc-500">ao5</th>
            <th className="px-4 py-3 font-medium text-zinc-500">Best</th>
            {showFlagStatus && (
              <th className="px-4 py-3 font-medium text-zinc-500">Status</th>
            )}
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-100 dark:divide-zinc-800">
          {results.map((r) => (
            <tr
              key={r.id}
              className={`transition-colors duration-700 ${
                justMoved.has(r.id) ? "bg-accent-primary/15" : "bg-white dark:bg-zinc-900/40"
              }`}
            >
              <td className="px-4 py-3 font-mono text-zinc-400">{r.rank ?? "—"}</td>
              <td className="px-4 py-3 font-medium text-zinc-900 dark:text-zinc-100">
                <Link href={`/profile/${r.userClId ?? r.userId}`} className="text-emerald-600 hover:text-emerald-500 dark:text-emerald-400 dark:hover:text-emerald-300">
                  {r.userName ?? r.userId}
                </Link>
              </td>
              <td className="px-4 py-3 font-mono text-zinc-700 dark:text-zinc-300">
                {r.ao5Ms !== null ? formatTime(r.ao5Ms) : "DNF"}
              </td>
              <td className="px-4 py-3 font-mono text-zinc-700 dark:text-zinc-300">
                {r.bestSingleMs !== null ? formatTime(r.bestSingleMs) : "—"}
              </td>
              {showFlagStatus && (
                <td className="px-4 py-3">
                  <span
                    className={`rounded px-1.5 py-0.5 text-xs ${
                      r.flagStatus === "clean" || r.flagStatus === "verified"
                        ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                        : r.flagStatus === "flagged"
                          ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                          : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                    }`}
                  >
                    {r.flagStatus ?? "—"}
                  </span>
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ResultTableSkeleton() {
  return (
    <div className="overflow-x-auto rounded-lg border border-zinc-200 dark:border-zinc-800">
      <table className="w-full text-sm">
        <tbody>
          {Array.from({ length: 5 }).map((_, i) => (
            <SkeletonRow key={i} cols={4} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
