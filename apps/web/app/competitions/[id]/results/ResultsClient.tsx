"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import Link from "next/link";
import { fetchCompetition, fetchLeaderboard, submitAppeal, type CompetitionDetail, type ResultDto } from "@/lib/api";
import { eventDisplayName } from "@/lib/eventNames";
import { EventIcon } from "@/components/EventIcon";
import { useAuth } from "@/features/auth/AuthProvider";
import { formatTime } from "@cubers/timer-core";
import { StatusBadge } from "@/features/competitions/StatusBadge";
import { Modal } from "@/components/ui/Modal";
import { Button } from "@/components/ui/Button";
import { Textarea } from "@/components/ui/Input";
import { Skeleton } from "@/components/Skeleton";

const PODIUM_STYLE = [
  { border: "border-accent-gold/50", bg: "bg-accent-gold/10", text: "text-accent-gold", medal: "🥇", order: "md:order-2", height: "md:h-40" },
  { border: "border-accent-silver/50", bg: "bg-accent-silver/10", text: "text-accent-silver", medal: "🥈", order: "md:order-1", height: "md:h-32" },
  { border: "border-accent-bronze/50", bg: "bg-accent-bronze/10", text: "text-accent-bronze", medal: "🥉", order: "md:order-3", height: "md:h-28" },
];

export default function ResultsPage() {
  const params = useParams<{ id: string }>();
  const { user } = useAuth();
  const [comp, setComp] = useState<CompetitionDetail | null>(null);
  const [boards, setBoards] = useState<Map<string, ResultDto[]>>(new Map());
  const [activeRound, setActiveRound] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [appealModal, setAppealModal] = useState<{ resultId: string; open: boolean }>({ resultId: "", open: false });
  const [appealReason, setAppealReason] = useState("");
  const [appealStatus, setAppealStatus] = useState<"idle" | "sending" | "sent" | "error">("idle");
  const [appealError, setAppealError] = useState("");

  useEffect(() => {
    if (!params.id) return;
    fetchCompetition(params.id)
      .then(async (c) => {
        setComp(c);
        const map = new Map<string, ResultDto[]>();
        for (const ev of c.events) {
          for (const r of ev.rounds) {
            try {
              const lb = await fetchLeaderboard(r.id);
              if (lb.length > 0) map.set(r.id, lb);
            } catch {
              /* ignore */
            }
          }
        }
        setBoards(map);
        // Default to first round with results
        const first = c.events.flatMap((e) => e.rounds).find((r) => map.has(r.id));
        if (first) setActiveRound(first.id);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [params.id]);

  if (loading) {
    return (
      <main className="mx-auto max-w-5xl px-6 py-10">
        <Skeleton className="mb-2 h-8 w-64" />
        <Skeleton className="mb-6 h-4 w-32" />
        <div className="mb-8 grid grid-cols-3 gap-3">
          <Skeleton className="h-32 rounded-xl" />
          <Skeleton className="h-40 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
        </div>
        <Skeleton className="h-64 w-full rounded-xl" />
      </main>
    );
  }

  if (!comp) {
    return (
      <main className="flex min-h-[60vh] items-center justify-center text-red-500 dark:text-red-400">
        Competition not found
      </main>
    );
  }

  const allRounds = comp.events.flatMap((ev) =>
    ev.rounds.map((r) => ({ ...r, eventType: ev.eventType })),
  );

  const results = activeRound ? boards.get(activeRound) ?? [] : [];
  const podium = results.slice(0, 3);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <h1 className="mb-2 text-2xl font-bold text-zinc-900 dark:text-zinc-100">
        {comp.title} — Results
      </h1>
      <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
        <StatusBadge status={comp.status} />
      </p>

      {/* Round tabs */}
      <div className="mb-8 flex flex-wrap gap-2">
        {allRounds.map((r) => {
          const hasResults = boards.has(r.id);
          return (
            <button
              key={r.id}
              onClick={() => hasResults && setActiveRound(r.id)}
              disabled={!hasResults}
              className={`flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-semibold transition ${
                activeRound === r.id
                  ? "bg-accent-primary text-zinc-950"
                  : hasResults
                    ? "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
                    : "bg-zinc-100/60 text-zinc-400 cursor-not-allowed dark:bg-zinc-900/40 dark:text-zinc-600"
              }`}
            >
              <EventIcon eventId={r.eventType} size={16} />
              {eventDisplayName(r.eventType)} R{r.roundNumber}
            </button>
          );
        })}
      </div>

      {results.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-300 p-10 text-center text-zinc-500 dark:border-zinc-700">
          No results yet for this round.
        </div>
      ) : (
        <>
          {/* Podium — top 3 */}
          {podium.length > 0 && (
            <div className="mb-10 grid grid-cols-3 items-end gap-3">
              {podium.map((r, i) => {
                const style = PODIUM_STYLE[i];
                const isMe = user?.id === r.userId;
                return (
                  <div
                    key={r.id}
                    className={`fade-slide-in flex flex-col items-center justify-end rounded-xl border ${style.border} ${style.bg} ${style.height} p-4 text-center ${style.order} ${
                      isMe ? "ring-2 ring-accent-primary" : ""
                    }`}
                    style={{ animationDelay: `${i * 80}ms` }}
                  >
                    <span className="mb-1 text-2xl">{style.medal}</span>
                    <Link
                      href={`/profile/${r.userClId ?? r.userId}`}
                      className="max-w-full truncate text-sm font-semibold text-zinc-900 hover:underline dark:text-zinc-100"
                    >
                      {r.userName ?? r.userId}
                    </Link>
                    <span className={`font-mono text-lg font-bold ${style.text}`}>
                      {r.ao5Ms !== null && r.ao5Ms !== Infinity ? formatTime(r.ao5Ms) : "DNF"}
                    </span>
                  </div>
                );
              })}
            </div>
          )}

          <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-zinc-200 bg-zinc-50 text-left text-xs uppercase tracking-wider text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/60">
                  <th className="px-4 py-3">Rank</th>
                  <th className="px-4 py-3">Competitor</th>
                  <th className="px-4 py-3 text-right">Average (ao5)</th>
                  <th className="px-4 py-3 text-right">Best Single</th>
                  {user && <th className="px-4 py-3" />}
                </tr>
              </thead>
              <tbody>
                {results.map((r, i) => {
                  const isMe = user?.id === r.userId;
                  return (
                    <tr
                      key={r.id}
                      className={`row-count-in border-b border-zinc-100 dark:border-zinc-800/50 ${
                        isMe
                          ? "bg-accent-primary/10 shadow-[inset_0_0_0_1px_var(--accent-primary)]"
                          : "hover:bg-zinc-50 dark:hover:bg-zinc-900/40"
                      }`}
                      style={{ animationDelay: `${Math.min(i, 20) * 25}ms` }}
                    >
                      <td className="px-4 py-3 font-mono text-zinc-500 dark:text-zinc-300">
                        {i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : (r.rank ?? "—")}
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/profile/${r.userClId ?? r.userId}`}
                          className="text-emerald-600 hover:text-emerald-500 dark:text-emerald-400 dark:hover:text-emerald-300"
                        >
                          {r.userName ?? r.userId}
                        </Link>
                        {isMe && (
                          <span className="ml-2 rounded-full bg-accent-primary/20 px-1.5 py-0.5 text-[10px] font-semibold text-accent-primary">
                            YOU
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-zinc-800 dark:text-zinc-200">
                        {r.ao5Ms !== null && r.ao5Ms !== Infinity
                          ? formatTime(r.ao5Ms)
                          : "DNF"}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-zinc-800 dark:text-zinc-200">
                        {r.bestSingleMs !== null && r.bestSingleMs !== Infinity
                          ? formatTime(r.bestSingleMs)
                          : "DNF"}
                      </td>
                      {user && (
                        <td className="px-4 py-3">
                          {r.userId === user.id && (
                            <button
                              onClick={() => {
                                setAppealModal({ resultId: r.id, open: true });
                                setAppealReason("");
                                setAppealStatus("idle");
                              }}
                              className="rounded bg-amber-100 px-2 py-1 text-xs text-amber-700 hover:bg-amber-200 dark:bg-amber-900/30 dark:text-amber-400 dark:hover:bg-amber-900/50"
                            >
                              Appeal
                            </button>
                          )}
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Appeal modal */}
      <Modal
        open={appealModal.open}
        onClose={() => setAppealModal({ resultId: "", open: false })}
        title="Submit Appeal"
      >
        <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
          Explain why you believe this result should be reviewed.
        </p>
        <Textarea
          value={appealReason}
          onChange={(e) => setAppealReason(e.target.value)}
          placeholder="Reason for appeal..."
          rows={4}
          className="mb-3"
        />
        {appealStatus === "error" && (
          <p className="mb-3 text-sm text-red-600 dark:text-red-400">{appealError}</p>
        )}
        {appealStatus === "sent" && (
          <p className="mb-3 text-sm text-emerald-600 dark:text-emerald-400">Appeal submitted successfully!</p>
        )}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setAppealModal({ resultId: "", open: false })}>
            {appealStatus === "sent" ? "Close" : "Cancel"}
          </Button>
          {appealStatus !== "sent" && (
            <Button
              disabled={!appealReason.trim()}
              loading={appealStatus === "sending"}
              onClick={async () => {
                setAppealStatus("sending");
                try {
                  await submitAppeal(appealModal.resultId, appealReason.trim());
                  setAppealStatus("sent");
                } catch (e) {
                  setAppealError(e instanceof Error ? e.message : String(e));
                  setAppealStatus("error");
                }
              }}
            >
              Submit Appeal
            </Button>
          )}
        </div>
      </Modal>
    </main>
  );
}
