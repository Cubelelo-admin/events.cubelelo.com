"use client";

import { useLeaderboard } from "@/features/realtime/useLeaderboard";
import { ResultTable } from "./ResultTable";

/**
 * A round's standings, live or final.
 *
 * Until the organiser publishes, this is a provisional board that moves as
 * results come in and as judges apply penalties. Publishing freezes it — the
 * shortlist for the next round is computed from exactly these numbers — so
 * after that it is presented as the final standing rather than a live feed.
 */
export function LiveRankingsPanel({
  roundId,
  roundStatus,
  publishedAt,
}: {
  roundId: string;
  roundStatus: string;
  /** ISO timestamp once the round's results are final. */
  publishedAt?: string | null;
}) {
  const board = useLeaderboard(roundId);
  const isFinal = Boolean(publishedAt);

  if (roundStatus === "pending") {
    return <p className="text-sm text-zinc-500">Waiting for the round to open…</p>;
  }

  if (board.length === 0) {
    return <p className="text-sm text-zinc-500">No results yet.</p>;
  }

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
          {isFinal ? "Final Standings" : "Live Rankings"}
        </h3>
        {isFinal ? (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
            Final
          </span>
        ) : (
          <span className="rounded-full bg-zinc-100 px-2 py-0.5 text-[10px] font-medium text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            Provisional — may change during verification
          </span>
        )}
      </div>

      <ResultTable results={board} showFlagStatus live={!isFinal} />
    </div>
  );
}
