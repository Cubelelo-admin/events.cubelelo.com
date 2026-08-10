"use client";

import { useParams, useRouter } from "next/navigation";
import { useEffect, useState, useMemo } from "react";
import Link from "next/link";
import {
  fetchPracticeSession,
  updatePracticeSession,
  deletePracticeSession,
  deletePracticeSolve,
  type PracticeSessionDto,
  type PracticeSolveDto,
} from "@/lib/api";
import { formatTime, ao5, ao12, bestSingle, effectiveTime, formatSolve } from "@cubers/timer-core";
import { eventDisplayName } from "@/lib/eventNames";
import { EventIcon } from "@/components/EventIcon";
import type { Solve } from "@cubers/types";
import { Skeleton } from "@/components/Skeleton";
import { Button } from "@/components/ui/Button";
import { ConfirmModal } from "@/components/ui/Modal";
import { useToast } from "@/components/ui/Toast";

export default function SessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const toast = useToast();
  const [session, setSession] = useState<PracticeSessionDto | null>(null);
  const [solves, setSolves] = useState<PracticeSolveDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [editName, setEditName] = useState("");
  const [confirmingDeleteSession, setConfirmingDeleteSession] = useState(false);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    fetchPracticeSession(id)
      .then(({ session: s, solves: sv }) => { setSession(s); setSolves(sv); })
      .catch(() => router.push("/practice"))
      .finally(() => setLoading(false));
  }, [id, router]);

  const solvesAsTimerFormat: Solve[] = useMemo(
    () => solves.map((s) => ({ time_ms: s.timeMs, inspectionPenalty: (s as any).inspectionPenalty ?? "none", penalty: s.penalty })),
    [solves],
  );

  const best = bestSingle(solvesAsTimerFormat);
  const currentAo5 = ao5(solvesAsTimerFormat);
  const currentAo12 = ao12(solvesAsTimerFormat);
  const validSolves = solves.filter((s) => s.penalty !== "dnf");
  const avgMs = validSolves.length > 0
    ? validSolves.reduce((sum, s) => sum + (s.penalty === "plus2" ? s.timeMs + 2000 : s.timeMs), 0) / validSolves.length
    : null;

  const handleRename = async () => {
    if (!editName.trim()) return;
    const updated = await updatePracticeSession(id, editName.trim());
    setSession(updated);
    setEditing(false);
  };

  const confirmDeleteSession = async () => {
    setDeleting(true);
    try {
      await deletePracticeSession(id);
      router.push("/practice");
    } catch (e) {
      toast.show(e instanceof Error ? e.message : String(e), "error");
      setDeleting(false);
    }
  };

  const handleDeleteSolve = async (solveId: string) => {
    await deletePracticeSolve(solveId);
    setSolves((prev) => prev.filter((s) => s.id !== solveId));
  };

  if (loading) {
    return (
      <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
        <Skeleton className="mb-3 h-4 w-32" />
        <Skeleton className="mb-6 h-8 w-64" />
        <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
          <Skeleton className="h-16 rounded-lg" />
          <Skeleton className="h-16 rounded-lg" />
          <Skeleton className="h-16 rounded-lg" />
          <Skeleton className="h-16 rounded-lg" />
          <Skeleton className="h-16 rounded-lg" />
        </div>
        <Skeleton className="h-64 w-full rounded-xl" />
      </main>
    );
  }

  if (!session) {
    return <main className="mx-auto max-w-4xl px-4 py-16 text-center text-zinc-500">Session not found</main>;
  }

  return (
    <main className="mx-auto max-w-4xl px-4 py-10 sm:px-6">
      {/* Header */}
      <div className="mb-6">
        <button onClick={() => router.push("/practice")} className="mb-3 text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
          &larr; Back to Practice
        </button>
        <div className="flex flex-wrap items-center gap-3">
          {editing ? (
            <form onSubmit={(e) => { e.preventDefault(); handleRename(); }} className="flex gap-2">
              <input
                value={editName}
                onChange={(e) => setEditName(e.target.value)}
                className="rounded border border-zinc-300 bg-white px-3 py-1 text-lg font-bold dark:border-zinc-700 dark:bg-zinc-900"
                autoFocus
              />
              <button type="submit" className="text-sm text-emerald-600 hover:text-emerald-500">Save</button>
              <button type="button" onClick={() => setEditing(false)} className="text-sm text-zinc-500">Cancel</button>
            </form>
          ) : (
            <>
              <h1 className="text-2xl font-bold">
                <EventIcon eventId={session.eventType} size={22} className="mr-1" /> {session.name || "Untitled Session"}
              </h1>
              <button onClick={() => { setEditName(session.name || ""); setEditing(true); }} className="text-sm text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300">
                Rename
              </button>
            </>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-3 text-sm text-zinc-500">
          <span>{eventDisplayName(session.eventType)}</span>
          <span>{new Date(session.createdAt).toLocaleString()}</span>
          {session.endedAt && <span className="text-zinc-400">Ended {new Date(session.endedAt).toLocaleString()}</span>}
        </div>
        {!session.endedAt && (
          <Link href={`/terminal?session=${session.id}`} className="mt-3 inline-block">
            <Button>Continue in Terminal</Button>
          </Link>
        )}
      </div>

      {/* Stats */}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-5">
        <StatCard label="Solves" value={String(solves.length)} />
        <StatCard label="Best" value={best !== null ? formatTime(best) : "—"} />
        <StatCard label="Avg" value={avgMs !== null ? formatTime(Math.round(avgMs)) : "—"} />
        <StatCard label="ao5" value={currentAo5 !== null ? formatTime(currentAo5) : solves.length >= 5 ? "DNF" : "—"} />
        <StatCard label="ao12" value={currentAo12 !== null ? formatTime(currentAo12) : solves.length >= 12 ? "DNF" : "—"} />
      </div>

      {/* Solve Table */}
      <div className="rounded-xl border border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/40">
        <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
          <span className="text-sm font-medium">{solves.length} solve{solves.length !== 1 ? "s" : ""}</span>
          <button onClick={() => setConfirmingDeleteSession(true)} className="text-xs text-red-500 hover:text-red-400">
            Delete Session
          </button>
        </div>
        {solves.length === 0 ? (
          <p className="py-8 text-center text-sm text-zinc-500">No solves in this session.</p>
        ) : (
          <div className="max-h-[60vh] overflow-y-auto">
            <table className="w-full text-sm">
              <thead className="sticky top-0 border-b border-zinc-200 bg-zinc-100 text-xs text-zinc-500 dark:border-zinc-700 dark:bg-zinc-800/60">
                <tr>
                  <th className="px-4 py-2 text-left">#</th>
                  <th className="px-4 py-2 text-left">Time</th>
                  <th className="hidden px-4 py-2 text-left sm:table-cell">Scramble</th>
                  <th className="hidden px-4 py-2 text-left md:table-cell">Note</th>
                  <th className="px-4 py-2 text-right">Action</th>
                </tr>
              </thead>
              <tbody>
                {solves.map((s, i) => (
                  <tr key={s.id} className="border-b border-zinc-100 hover:bg-zinc-100/50 dark:border-zinc-800 dark:hover:bg-zinc-800/30">
                    <td className="px-4 py-2 text-zinc-500">{i + 1}</td>
                    <td className={`px-4 py-2 font-mono font-medium ${s.penalty === "dnf" ? "text-red-500" : s.penalty === "plus2" ? "text-orange-400" : ""}`}>
                      {formatSolve({ time_ms: s.timeMs, inspectionPenalty: (s as any).inspectionPenalty ?? "none", penalty: s.penalty })}
                    </td>
                    <td className="hidden max-w-[200px] truncate px-4 py-2 font-mono text-xs text-zinc-500 sm:table-cell">
                      {s.scramble}
                    </td>
                    <td className="hidden px-4 py-2 text-xs text-zinc-500 md:table-cell">
                      {s.note || "—"}
                    </td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => handleDeleteSolve(s.id)}
                        className="text-xs text-zinc-400 hover:text-red-500"
                      >
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <ConfirmModal
        open={confirmingDeleteSession}
        onClose={() => setConfirmingDeleteSession(false)}
        onConfirm={confirmDeleteSession}
        loading={deleting}
        title="Delete session?"
        description="This permanently deletes this session and all of its solves. This cannot be undone."
        confirmLabel="Delete session"
      />
    </main>
  );
}

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-center dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="text-[11px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className="font-mono text-lg font-bold">{value}</div>
    </div>
  );
}
