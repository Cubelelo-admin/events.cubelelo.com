"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { fetchAllAppeals, resolveAppeal, type AppealDto } from "@/lib/api";
import { EmptyState } from "@/components/EmptyState";
import { formatTime } from "@cubers/timer-core";
import { eventDisplayName } from "@/lib/eventNames";

const STATUS_COLOR: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  accepted: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
  rejected: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

function solvePenaltyLabel(s: { time_ms: number; penalty: string; inspectionPenalty?: string }): string {
  if (s.penalty === "dnf" || s.inspectionPenalty === "dnf") return "DNF";
  const extra = (s.penalty === "plus2" ? 2000 : 0) + (s.inspectionPenalty === "plus2" ? 2000 : 0);
  const t = s.time_ms + extra;
  const formatted = formatTime(t);
  return extra > 0 ? `${formatted}+` : formatted;
}

export default function AdminAppealsPage() {
  const [appeals, setAppeals] = useState<AppealDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [responseText, setResponseText] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<"all" | "pending" | "accepted" | "rejected">("all");

  const load = useCallback(() => {
    setLoading(true);
    fetchAllAppeals()
      .then(setAppeals)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleResolve(id: string, action: "accepted" | "rejected") {
    setResolving(id);
    try {
      await resolveAppeal(id, action, responseText[id]);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setResolving(null);
    }
  }

  const filtered = filter === "all" ? appeals : appeals.filter((a) => a.status === filter);

  return (
    <div className="mx-auto max-w-[1400px] px-8 py-10">
      <h1 className="mb-4 text-xl font-bold text-zinc-900 dark:text-zinc-100">Appeals</h1>

      {error && (
        <div className="mb-4 rounded bg-red-100 px-4 py-2 text-red-700 dark:bg-red-900/30 dark:text-red-300">{error}</div>
      )}

      <div className="mb-4 flex gap-2">
        {(["all", "pending", "accepted", "rejected"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded px-3 py-1 text-sm capitalize ${
              filter === f ? "bg-emerald-600 text-white" : "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-zinc-500">Loading…</p>
      ) : filtered.length === 0 ? (
        <EmptyState icon="📮" title="No appeals found" description="Result appeals from competitors will show up here." />
      ) : (
        <div className="space-y-4">
          {filtered.map((a) => (
            <div key={a.id} className="rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900 p-4">
              {/* Header: user info + status */}
              <div className="mb-3 flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="mb-1 flex items-center gap-2">
                    <span className="font-medium text-zinc-900 dark:text-white">{a.userName ?? "Unknown"}</span>
                    <span className="text-sm text-zinc-500">{a.userClId}</span>
                    <span className={`rounded px-2 py-0.5 text-xs ${STATUS_COLOR[a.status] ?? ""}`}>
                      {a.status}
                    </span>
                  </div>

                  {/* Competition / Event / Round context */}
                  <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-zinc-600 dark:text-zinc-400">
                    {a.competitionName && (
                      <Link
                        href={`/competitions/${a.competitionId}`}
                        className="font-medium text-emerald-700 hover:underline dark:text-emerald-400"
                      >
                        {a.competitionName}
                      </Link>
                    )}
                    {a.eventType && (
                      <span className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium dark:bg-zinc-800">
                        {eventDisplayName(a.eventType)}
                      </span>
                    )}
                    {a.roundNumber != null && <span>Round {a.roundNumber}</span>}
                    <span className="text-zinc-400">•</span>
                    <span>Flag: {a.flagStatus ?? "—"}</span>
                  </div>
                </div>
                <span className="shrink-0 text-xs text-zinc-500">
                  {new Date(a.createdAt).toLocaleDateString()}
                </span>
              </div>

              {/* Reason */}
              <div className="mb-3 rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-800/60">
                <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Reason</p>
                <p className="text-sm text-zinc-800 dark:text-zinc-200">{a.reason}</p>
              </div>

              {/* Solve times + ao5 */}
              {a.solves && a.solves.length > 0 && (
                <div className="mb-3 flex flex-wrap items-center gap-3 text-sm">
                  <span className="font-medium text-zinc-500 dark:text-zinc-400">Solves:</span>
                  <div className="flex gap-2">
                    {a.solves.map((s, i) => (
                      <span
                        key={i}
                        className={`rounded px-2 py-0.5 text-xs font-mono ${
                          s.penalty === "dnf" || s.inspectionPenalty === "dnf"
                            ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                            : s.penalty === "plus2" || s.inspectionPenalty === "plus2"
                              ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                              : "bg-zinc-100 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
                        }`}
                      >
                        {solvePenaltyLabel(s)}
                      </span>
                    ))}
                  </div>
                  <span className="text-zinc-400">|</span>
                  <span className="font-medium text-zinc-500 dark:text-zinc-400">ao5:</span>
                  <span className="font-mono text-zinc-800 dark:text-zinc-200">
                    {a.ao5Ms != null ? formatTime(a.ao5Ms) : "DNF"}
                  </span>
                  {a.bestSingleMs != null && (
                    <>
                      <span className="text-zinc-400">|</span>
                      <span className="font-medium text-zinc-500 dark:text-zinc-400">Best:</span>
                      <span className="font-mono text-zinc-800 dark:text-zinc-200">{formatTime(a.bestSingleMs)}</span>
                    </>
                  )}
                </div>
              )}

              {/* Video URL */}
              {a.videoUrl && (
                <div className="mb-3 text-sm">
                  <span className="font-medium text-zinc-500 dark:text-zinc-400">Video: </span>
                  <a
                    href={a.videoUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-emerald-700 hover:underline dark:text-emerald-400"
                  >
                    {a.videoUrl.length > 60 ? a.videoUrl.slice(0, 60) + "…" : a.videoUrl}
                  </a>
                </div>
              )}

              {/* Admin response (for resolved appeals) */}
              {a.adminResponse && (
                <div className="mb-3 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-800/60">
                  <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                    Response by {a.resolvedByName ?? "Admin"}
                    {a.resolvedAt && <> • {new Date(a.resolvedAt).toLocaleDateString()}</>}
                  </p>
                  <p className="text-sm text-zinc-800 dark:text-zinc-200">{a.adminResponse}</p>
                </div>
              )}

              {/* Resolution controls for pending appeals */}
              {a.status === "pending" && (
                <div className="mt-3 border-t border-zinc-200 dark:border-zinc-800 pt-3">
                  <textarea
                    placeholder="Response (optional)"
                    value={responseText[a.id] ?? ""}
                    onChange={(e) =>
                      setResponseText((prev) => ({ ...prev, [a.id]: e.target.value }))
                    }
                    className="mb-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-600"
                    rows={2}
                  />
                  <div className="flex gap-2">
                    <button
                      disabled={resolving === a.id}
                      onClick={() => handleResolve(a.id, "accepted")}
                      className="rounded bg-emerald-700 px-4 py-1.5 text-sm text-white hover:bg-emerald-600 disabled:opacity-50"
                    >
                      Accept
                    </button>
                    <button
                      disabled={resolving === a.id}
                      onClick={() => handleResolve(a.id, "rejected")}
                      className="rounded bg-red-700 px-4 py-1.5 text-sm text-white hover:bg-red-600 disabled:opacity-50"
                    >
                      Reject
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
