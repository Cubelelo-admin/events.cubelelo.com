"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { fetchRankings, type RankingEntry } from "@/lib/api";
import { eventDisplayName } from "@/lib/eventNames";
import { EventIcon } from "@/components/EventIcon";
import { EVENT_IDS } from "@cubers/scramble-core";
import { formatTime } from "@cubers/timer-core";
import { useAuth } from "@/features/auth/AuthProvider";
import { Skeleton, SkeletonRow } from "@/components/Skeleton";

const PODIUM_STYLE = [
  { border: "border-accent-gold/50", bg: "bg-accent-gold/10", text: "text-accent-gold", medal: "🥇", order: "md:order-2", height: "md:h-40" },
  { border: "border-accent-silver/50", bg: "bg-accent-silver/10", text: "text-accent-silver", medal: "🥈", order: "md:order-1", height: "md:h-32" },
  { border: "border-accent-bronze/50", bg: "bg-accent-bronze/10", text: "text-accent-bronze", medal: "🥉", order: "md:order-3", height: "md:h-28" },
];

const RANK_HISTORY_KEY = "cubers_rankings_last_seen";

function loadRankHistory(event: string): Record<string, number> {
  try {
    const raw = localStorage.getItem(RANK_HISTORY_KEY);
    if (!raw) return {};
    const all = JSON.parse(raw);
    return all[event] ?? {};
  } catch {
    return {};
  }
}

function saveRankHistory(event: string, ranks: Record<string, number>) {
  try {
    const raw = localStorage.getItem(RANK_HISTORY_KEY);
    const all = raw ? JSON.parse(raw) : {};
    all[event] = ranks;
    localStorage.setItem(RANK_HISTORY_KEY, JSON.stringify(all));
  } catch {}
}

export default function RankingsPage() {
  const { user } = useAuth();
  const [event, setEvent] = useState("333");
  const [entries, setEntries] = useState<RankingEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [deltas, setDeltas] = useState<Record<string, number>>({});

  useEffect(() => {
    setLoading(true);
    fetchRankings(event)
      .then((data) => {
        setEntries(data);
        // Compare against ranks from the last time this event's leaderboard was
        // viewed (persisted locally) — a real, honest "since you last checked"
        // delta rather than a decorative static arrow.
        const prev = loadRankHistory(event);
        const nextDeltas: Record<string, number> = {};
        const nextHistory: Record<string, number> = {};
        data.forEach((r, i) => {
          const prevRank = prev[r.clId];
          if (prevRank !== undefined && prevRank !== i) {
            nextDeltas[r.clId] = prevRank - i;
          }
          nextHistory[r.clId] = i;
        });
        setDeltas(nextDeltas);
        saveRankHistory(event, nextHistory);
      })
      .catch(() => setEntries([]))
      .finally(() => setLoading(false));
  }, [event]);

  const podium = entries.slice(0, 3);
  const rest = entries.slice(3);

  return (
    <>
      {/* ══ Event rail — fixed to viewport on desktop, same technique as AdminShell ══ */}
      <nav className="flex gap-1.5 overflow-x-auto px-6 pb-2 pt-4 lg:fixed lg:left-0 lg:top-14 lg:z-30 lg:h-[calc(100vh-56px)] lg:w-56 lg:flex-col lg:gap-0.5 lg:overflow-y-auto lg:overflow-x-visible lg:border-r lg:border-[var(--border-default)] lg:bg-[var(--bg-glass)] lg:px-3 lg:py-6 lg:backdrop-blur-xl">
        {EVENT_IDS.map((id) => (
          <button
            key={id}
            onClick={() => setEvent(id)}
            className={`flex shrink-0 items-center gap-2.5 rounded-lg px-3 py-2 text-sm font-medium transition lg:shrink ${
              event === id
                ? "bg-accent-primary/10 font-semibold text-accent-primary"
                : "text-zinc-600 hover:bg-zinc-100 dark:text-zinc-400 dark:hover:bg-zinc-900"
            }`}
          >
            <EventIcon eventId={id} size={18} />
            <span className="whitespace-nowrap">{eventDisplayName(id)}</span>
          </button>
        ))}
      </nav>

      <div className="lg:pl-56">
        <main className="mx-auto max-w-6xl px-6 py-10">
          <h1 className="mb-6 text-2xl font-bold text-zinc-900 dark:text-zinc-100">Rankings</h1>

      {loading ? (
        <>
          <div className="mb-8 grid grid-cols-3 gap-3">
            <Skeleton className="h-32 rounded-xl" />
            <Skeleton className="h-40 rounded-xl" />
            <Skeleton className="h-28 rounded-xl" />
          </div>
          <div className="overflow-hidden rounded-xl border border-[var(--border-default)] bg-[var(--bg-card)] backdrop-blur-md">
            <table className="w-full text-sm">
              <tbody>
                {Array.from({ length: 6 }).map((_, i) => (
                  <SkeletonRow key={i} cols={5} />
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : entries.length === 0 ? (
        <div className="glass-card rounded-xl p-10 text-center text-[var(--text-tertiary)]">
          No rankings yet for {eventDisplayName(event)}.
        </div>
      ) : (
        <>
          {/* Podium — top 3 */}
          {podium.length > 0 && (
            <div className="mb-10 grid grid-cols-3 items-end gap-3">
              {podium.map((r, i) => {
                const style = PODIUM_STYLE[i];
                const isMe = user?.clId === r.clId;
                return (
                  <div
                    key={`${r.userId}-${r.eventType}`}
                    className={`fade-slide-in flex flex-col items-center justify-end rounded-xl border ${style.border} ${style.bg} ${style.height} p-4 text-center ${style.order} ${
                      isMe ? "ring-2 ring-accent-primary" : ""
                    }`}
                    style={{ animationDelay: `${i * 80}ms` }}
                  >
                    <span className="mb-1 text-2xl">{style.medal}</span>
                    <Link
                      href={`/profile/${r.clId}`}
                      className="max-w-full truncate text-sm font-semibold text-zinc-900 hover:underline dark:text-zinc-100"
                    >
                      {r.name}
                    </Link>
                    <span className={`font-mono text-lg font-bold ${style.text}`}>
                      {r.bestAo5Ms !== null && r.bestAo5Ms !== Infinity ? formatTime(r.bestAo5Ms) : "—"}
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
                  <th className="px-4 py-3 w-16">#</th>
                  <th className="px-4 py-3">Name</th>
                  <th className="px-4 py-3">CL ID</th>
                  <th className="px-4 py-3 text-right">Average (ao5)</th>
                  <th className="px-4 py-3 text-right">Best Single</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((r, i) => {
                  const isMe = user?.clId === r.clId;
                  return (
                    <tr
                      key={`${r.userId}-${r.eventType}`}
                      className={`row-count-in border-b border-zinc-100 dark:border-zinc-800/50 ${
                        isMe
                          ? "bg-accent-primary/10 shadow-[inset_0_0_0_1px_var(--accent-primary)] dark:bg-accent-primary/5"
                          : "hover:bg-zinc-50 dark:hover:bg-zinc-900/40"
                      }`}
                      style={{ animationDelay: `${Math.min(i, 20) * 25}ms` }}
                    >
                      <td className="px-4 py-3 font-mono text-zinc-400">
                        <span className="inline-flex items-center gap-1.5">
                          {i === 0 ? "🥇" : i === 1 ? "🥈" : i === 2 ? "🥉" : i + 1}
                          <RankDelta delta={deltas[r.clId]} />
                        </span>
                      </td>
                      <td className="px-4 py-3 font-medium text-zinc-800 dark:text-zinc-200">
                        {r.name}
                        {isMe && (
                          <span className="ml-2 rounded-full bg-accent-primary/20 px-1.5 py-0.5 text-[10px] font-semibold text-accent-primary">
                            YOU
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/profile/${r.clId}`}
                          className="font-mono text-emerald-400 hover:text-emerald-300"
                        >
                          {r.clId}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-zinc-800 dark:text-zinc-200">
                        {r.bestAo5Ms !== null && r.bestAo5Ms !== Infinity
                          ? formatTime(r.bestAo5Ms)
                          : "DNF"}
                      </td>
                      <td className="px-4 py-3 text-right font-mono text-zinc-800 dark:text-zinc-200">
                        {r.bestSingleMs !== null && r.bestSingleMs !== Infinity
                          ? formatTime(r.bestSingleMs)
                          : "DNF"}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </>
      )}
        </main>
      </div>
    </>
  );
}

/** Shows real movement since the last time this leaderboard was viewed on this device. */
function RankDelta({ delta }: { delta: number | undefined }) {
  if (!delta) return null;
  if (delta > 0) {
    return (
      <span className="fade-slide-in text-xs font-semibold text-emerald-500" title={`Up ${delta} since your last visit`}>
        ▲{delta}
      </span>
    );
  }
  return (
    <span className="fade-slide-in text-xs font-semibold text-red-500" title={`Down ${Math.abs(delta)} since your last visit`}>
      ▼{Math.abs(delta)}
    </span>
  );
}
