"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getEvent, isEventId, type EventId } from "@cubers/scramble-core";
import { ao5, effectiveTime, formatSolve, formatTime } from "@cubers/timer-core";
import type { Solve, SolvePenalty } from "@cubers/types";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useTimer } from "@/features/timer/useTimer";
import { TimerDisplay } from "@/features/timer/TimerDisplay";
import { TwistyPlayer } from "@/features/scramble/TwistyPlayer";
import { useLeaderboard } from "@/features/realtime/useLeaderboard";
import { ErrorCard } from "@/components/ui/ErrorCard";
import { useAuth } from "@/features/auth/AuthProvider";
import {
  fetchCompetition,
  fetchMyProgress,
  fetchScramble,
  submitResult,
  type ResultDto,
} from "@/lib/api";

const SOLVES_PER_ROUND = 5;

interface CompetitionTerminalProps {
  competitionId: string;
  round: string;
  eventId: EventId;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; roundId: string; eventType: EventId; scrambles: string[]; cutoffMs?: number; timeLimitMs?: number; closesAt?: string | null };

export function CompetitionTerminal({
  competitionId,
  round,
  eventId,
}: CompetitionTerminalProps) {
  const { snapshot, down, up, reset } = useTimer({ useInspection: true });

  const [load, setLoad] = useState<LoadState>({ kind: "loading" });
  const [index, setIndex] = useState(() => {
    if (typeof window === "undefined") return 0;
    const saved = sessionStorage.getItem(`comp_solves_${competitionId}_${eventId}_${round}`);
    return saved ? (JSON.parse(saved) as Solve[]).length : 0;
  });
  const [solves, setSolves] = useState<Solve[]>(() => {
    if (typeof window === "undefined") return [];
    const saved = sessionStorage.getItem(`comp_solves_${competitionId}_${eventId}_${round}`);
    return saved ? JSON.parse(saved) : [];
  });
  const [pendingPenalty, setPendingPenalty] = useState<SolvePenalty>("none");
  const [scrambleStep, setScrambleStep] = useState(0);

  const router = useRouter();
  const { user } = useAuth();
  const currentUserId = user?.id ?? "guest";
  const [showExitConfirm, setShowExitConfirm] = useState(false);
  const [submit, setSubmit] = useState<
    | { kind: "idle" }
    | { kind: "submitting" }
    | { kind: "done"; rank: number | null }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  useEffect(() => {
    const key = `comp_solves_${competitionId}_${eventId}_${round}`;
    if (solves.length > 0) {
      sessionStorage.setItem(key, JSON.stringify(solves));
    } else {
      sessionStorage.removeItem(key);
    }
  }, [solves, competitionId, eventId, round]);

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        const comp = await fetchCompetition(competitionId);
        const ev =
          comp.events.find((e) => e.eventType === eventId) ?? comp.events[0];
        const rnd =
          ev?.rounds.find((r) => r.roundNumber === Number(round)) ?? ev?.rounds[0];
        if (!ev || !rnd) throw new Error("Round not found");

        try {
          const progress = await fetchMyProgress(competitionId);
          const myRound = progress.rounds.find(
            (r) => r.roundNumber === Number(round) && r.eventType === eventId,
          );
          if (myRound?.userStatus === "submitted") {
            router.push(`/competitions/${competitionId}`);
            return;
          }
        } catch {}

        const sc = await fetchScramble(rnd.id);
        if (!active) return;
        setLoad({
          kind: "ready",
          roundId: rnd.id,
          eventType: isEventId(ev.eventType) ? ev.eventType : "333",
          scrambles: sc.scrambles,
          cutoffMs: ev.cutoffMs,
          timeLimitMs: ev.timeLimitMs,
          closesAt: rnd.closesAt ?? null,
        });
      } catch (e) {
        if (active) {
          const raw = e instanceof Error ? e.message : String(e);
          setLoad({ kind: "error", message: raw });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [competitionId, round, eventId]);

  const [cutoffFailed, setCutoffFailed] = useState(false);
  const [timeLimitHit, setTimeLimitHit] = useState(false);
  const stoppedRef = useRef(false);

  useEffect(() => {
    if (snapshot.phase === "stopped" && !stoppedRef.current) {
      stoppedRef.current = true;
      setPendingPenalty("none");
      setTimeLimitHit(false);

      // Inspection auto-DNF (>17 s, solve never started): skip review and
      // auto-confirm immediately so the user goes straight to the next solve
      // or the final results screen.
      if (
        snapshot.result?.inspectionPenalty === "dnf" &&
        snapshot.result?.time_ms === 0
      ) {
        const inspectionDnfSolve: Solve = {
          time_ms: 0,
          inspectionPenalty: "dnf",
          penalty: "none",
        };
        setSolves((prev) => {
          const next = [...prev, inspectionDnfSolve];
          // WCA cutoff: inspection DNF counts as exceeding cutoff (Infinity effective time)
          if (
            load.kind === "ready" &&
            load.cutoffMs &&
            next.length === 2
          ) {
            const allAboveCutoff = next.every(
              (s) => effectiveTime(s) > (load as { cutoffMs: number }).cutoffMs,
            );
            if (allAboveCutoff) {
              setCutoffFailed(true);
            }
          }
          return next;
        });
        setIndex((i) => Math.min(i + 1, SOLVES_PER_ROUND - 1));
        reset();
      }
    } else if (snapshot.phase !== "stopped") {
      stoppedRef.current = false;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.phase, snapshot.result]);

  // WCA time limit enforcement: auto-DNF if solve exceeds time limit
  useEffect(() => {
    if (
      snapshot.phase === "solving" &&
      load.kind === "ready" &&
      load.timeLimitMs &&
      snapshot.timeMs >= load.timeLimitMs &&
      !timeLimitHit
    ) {
      setTimeLimitHit(true);
      down(); // stop the timer
    }
  }, [snapshot.phase, snapshot.timeMs, load, timeLimitHit, down]);


  // Track round close time — warn user and block new solves once closesAt passes
  const closesAtMs = load.kind === "ready" && load.closesAt ? new Date(load.closesAt).getTime() : null;
  const [roundTimeLeft, setRoundTimeLeft] = useState<number | null>(null);
  const [roundExpired, setRoundExpired] = useState(false);

  useEffect(() => {
    if (!closesAtMs) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const now = Date.now();
      const left = closesAtMs - now;
      setRoundTimeLeft(Math.max(0, left));
      if (left <= 0) { setRoundExpired(true); return; }
      // Align to second boundary so the display flips crisply
      timer = setTimeout(tick, 1000 - (now % 1000) || 1000);
    };
    tick();
    return () => clearTimeout(timer);
  }, [closesAtMs]);

  const roundComplete = cutoffFailed || solves.length >= SOLVES_PER_ROUND || roundExpired;

  const currentScramble = load.kind === "ready" ? (load.scrambles[index] ?? "") : "";
  const scrambleMoves = useMemo(() => currentScramble.trim().split(/\s+/).filter(Boolean), [currentScramble]);
  const totalSteps = scrambleMoves.length;

  useEffect(() => {
    setScrambleStep(totalSteps);
  }, [totalSteps]);

  const visibleScrambleAlg = useMemo(
    () => scrambleMoves.slice(0, scrambleStep).join(" "),
    [scrambleMoves, scrambleStep],
  );

  useEffect(() => {
    if (load.kind !== "ready" || roundComplete) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (snapshot.phase === "solving") {
        e.preventDefault();
        down();
        return;
      }
      if (e.code === "Space") {
        e.preventDefault();
        down();
      } else if (e.key === "Escape") {
        reset();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === "Space") {
        e.preventDefault();
        up();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, [load.kind, roundComplete, snapshot.phase, down, up, reset]);

  const confirmSolve = useCallback(() => {
    if (!snapshot.result) return;
    const inspPenalty = timeLimitHit ? "dnf" as const : (snapshot.result!.inspectionPenalty ?? "none" as const);
    const newSolve: Solve = {
      time_ms: snapshot.result!.time_ms,
      inspectionPenalty: inspPenalty,
      penalty: pendingPenalty,
    };
    const newSolves = [...solves, newSolve];
    setSolves(newSolves);

    // WCA cutoff enforcement: after solve 2, check if both solves exceed cutoff
    if (
      load.kind === "ready" &&
      load.cutoffMs &&
      newSolves.length === 2
    ) {
      const allAboveCutoff = newSolves.every(
        (s) => effectiveTime(s) > load.cutoffMs!,
      );
      if (allAboveCutoff) {
        setCutoffFailed(true);
        reset();
        return;
      }
    }

    setIndex((i) => Math.min(i + 1, SOLVES_PER_ROUND - 1));
    reset();
  }, [snapshot.result, pendingPenalty, timeLimitHit, reset, solves, load]);

  const handleSubmit = useCallback(async () => {
    if (load.kind !== "ready") return;
    setSubmit({ kind: "submitting" });
    try {
      const result = await submitResult(load.roundId, { solves });
      sessionStorage.removeItem(`comp_solves_${competitionId}_${eventId}_${round}`);
      setSubmit({ kind: "done", rank: result.rank });
    } catch (e) {
      setSubmit({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }, [load, solves]);

  // Auto-submit when round expires and user has completed all solves
  const autoSubmitDone = useRef(false);
  useEffect(() => {
    if (!roundExpired || autoSubmitDone.current) return;
    if (solves.length >= SOLVES_PER_ROUND && submit.kind === "idle") {
      autoSubmitDone.current = true;
      handleSubmit();
    }
  }, [roundExpired, solves.length, submit.kind, handleSubmit]);

  // Auto-redirect to competition page after successful submission
  useEffect(() => {
    if (submit.kind === "done") {
      router.push(`/competitions/${competitionId}`);
    }
  }, [submit.kind, router, competitionId]);

  const onPointerDown = useCallback(() => {
    if (snapshot.phase === "stopped" || roundComplete) return;
    down();
  }, [snapshot.phase, roundComplete, down]);
  const onPointerUp = useCallback(() => {
    if (snapshot.phase === "stopped" || roundComplete) return;
    up();
  }, [snapshot.phase, roundComplete, up]);

  const runningAo5 = ao5(solves);
  const focusMode = snapshot.phase === "inspection" || snapshot.phase === "ready" || snapshot.phase === "solving";

  const event = useMemo(
    () => getEvent(load.kind === "ready" ? load.eventType : eventId),
    [load, eventId],
  );

  const liveBoard = useLeaderboard(load.kind === "ready" ? load.roundId : null);

  if (load.kind === "loading") {
    return <CenterMessage>Loading round…</CenterMessage>;
  }
  if (load.kind === "error") {
    return (
      <CenterMessage>
        <ErrorCard error={load.message} />
      </CenterMessage>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-white text-zinc-900 select-none dark:bg-zinc-950 dark:text-zinc-100">
      {/* ── Header ── */}
      <header className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-2 text-sm dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setShowExitConfirm(true)}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-500 transition hover:bg-zinc-100 hover:text-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
            title="Leave competition"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <span className="font-semibold">{event.name}</span>
          <span className="text-zinc-500">Round {round}</span>
        </div>
        <div className="flex items-center gap-4">
          {load.kind === "ready" && load.cutoffMs && (
            <span className="text-xs text-amber-600 dark:text-amber-400">
              Cutoff: {formatTime(load.cutoffMs)}
            </span>
          )}
          {load.kind === "ready" && load.timeLimitMs && (
            <span className="text-xs text-red-600 dark:text-red-400">
              Limit: {formatTime(load.timeLimitMs)}
            </span>
          )}
          {roundTimeLeft !== null && !roundExpired && (
            <span className={`font-mono text-xs font-semibold ${roundTimeLeft < 60_000 ? "text-red-500 animate-pulse" : roundTimeLeft < 300_000 ? "text-amber-500" : "text-zinc-500"}`}>
              ⏱ {Math.floor(roundTimeLeft / 60_000)}:{String(Math.floor((roundTimeLeft % 60_000) / 1000)).padStart(2, "0")}
            </span>
          )}
          {roundExpired && (
            <span className="text-xs font-semibold text-red-500">⏱ Round closed</span>
          )}
          <span className="text-zinc-500">Solve</span>
          <span className="font-mono font-semibold">
            {Math.min(index + 1, SOLVES_PER_ROUND)} / {SOLVES_PER_ROUND}
          </span>
        </div>
      </header>

      {/* ── Exit confirmation dialog ── */}
      {showExitConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70">
          <div className="mx-4 w-full max-w-sm rounded-xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">
            <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
              <svg className="h-6 w-6 text-red-500" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            </div>
            <h3 className="mb-2 text-lg font-bold text-zinc-900 dark:text-white">Leave Competition?</h3>
            <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
              Your progress in this round will be lost. Any unsubmitted solves will not be saved.
            </p>
            <div className="flex gap-3">
              <button
                onClick={() => setShowExitConfirm(false)}
                className="flex-1 rounded-lg border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
              >
                Stay
              </button>
              <button
                onClick={() => router.push(`/competitions/${competitionId}`)}
                className="flex-1 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white transition hover:bg-red-500"
              >
                Leave
              </button>
            </div>
          </div>
        </div>
      )}

      {roundComplete ? (
        <RoundComplete
          finalAo5={runningAo5}
          solves={solves}
          submit={submit}
          onSubmit={handleSubmit}
          userId={currentUserId}
          board={liveBoard}
          signedIn={Boolean(user)}
          cutoffFailed={cutoffFailed}
        />
      ) : focusMode ? (
        /* ── Full-screen timer (inspection / ready / solving) ── */
        <div
          className="flex flex-1 flex-col items-center justify-center gap-4 px-6"
          onPointerDown={onPointerDown}
          onPointerUp={onPointerUp}
        >
          <TimerDisplay snapshot={snapshot} pendingPenalty={pendingPenalty} size="xl" theme="auto" />
          <p className="text-sm text-zinc-500">{instruction(snapshot.phase)}</p>
        </div>
      ) : (
        <>
          {/* ══════ TOP: info panel ══════ */}
          <div className="flex-shrink-0">
            {/* Scramble text — locked, no select/copy */}
            <div className="flex items-start gap-2 border-b border-zinc-200 px-4 py-3 dark:border-zinc-800">
              <div className="min-w-0 flex-1">
                <div
                  className="font-mono text-sm leading-relaxed text-zinc-800 dark:text-zinc-200"
                  style={{ userSelect: "none", WebkitUserSelect: "none" }}
                  onCopy={(e) => e.preventDefault()}
                  onCut={(e) => e.preventDefault()}
                >
                  {scrambleMoves.map((move, i) => (
                    <span
                      key={i}
                      className={
                        i < scrambleStep
                          ? "text-zinc-800 dark:text-zinc-200"
                          : "text-zinc-400 dark:text-zinc-600"
                      }
                    >
                      {move}
                      {i < scrambleMoves.length - 1 ? " " : ""}
                    </span>
                  ))}
                </div>
              </div>
              {/* Prev / Next step controls */}
              <div className="flex gap-1">
                <button
                  onClick={() => setScrambleStep((s) => Math.max(0, s - 1))}
                  disabled={scrambleStep <= 0}
                  className="rounded border border-zinc-300 px-3 py-1 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-100 disabled:opacity-30 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  prev
                </button>
                <button
                  onClick={() => setScrambleStep((s) => Math.min(totalSteps, s + 1))}
                  disabled={scrambleStep >= totalSteps}
                  className="rounded border border-zinc-300 px-3 py-1 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-100 disabled:opacity-30 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
                >
                  next
                </button>
              </div>
            </div>

            {/* 2D visualizer + solve status grid */}
            <div className="grid grid-cols-1 gap-3 px-4 pb-2 pt-2 md:grid-cols-2">
              {/* 2D scramble visualizer — shows state at current step */}
              <div className="flex items-center justify-center rounded-xl border border-zinc-200 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-900/40">
                <TwistyPlayer
                  puzzle={event.puzzle}
                  scramble={visibleScrambleAlg}
                  className="h-48 w-full"
                />
              </div>

              {/* Solve status for this round */}
              <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-3 dark:border-zinc-800 dark:bg-zinc-900/40">
                {/* Progress bar — scoped to solves panel */}
                <div className="mb-2">
                  <ProgressBar current={solves.length} total={SOLVES_PER_ROUND} />
                </div>
                <div className="mb-2 flex items-center justify-between text-sm">
                  <span className="text-zinc-500 dark:text-zinc-400">This round</span>
                  <span className="text-zinc-500 dark:text-zinc-400">
                    ao5:{" "}
                    <span className="font-mono text-zinc-900 dark:text-zinc-100">
                      {runningAo5 === null ? "—" : formatTime(runningAo5)}
                    </span>
                  </span>
                </div>
                <ol className="space-y-1 font-mono text-sm">
                  {Array.from({ length: SOLVES_PER_ROUND }).map((_, i) => (
                    <li
                      key={i}
                      className={`flex justify-between rounded px-2 py-1 ${i === index ? "bg-zinc-200/60 dark:bg-zinc-800/60" : ""
                        }`}
                    >
                      <span className="text-zinc-500">Solve {i + 1}</span>
                      <span className={solves[i] ? "text-zinc-900 dark:text-zinc-100" : "text-zinc-400 dark:text-zinc-700"}>
                        {solves[i] ? formatSolve(solves[i]!) : "—"}
                      </span>
                    </li>
                  ))}
                </ol>
              </div>
            </div>
          </div>

          {/* ══════ DIVIDER ══════ */}
          <div className="border-t border-zinc-200 dark:border-zinc-800" />

          {/* ══════ BOTTOM: timer area ══════ */}
          <div
            className="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-4"
            onPointerDown={onPointerDown}
            onPointerUp={onPointerUp}
          >
            <TimerDisplay snapshot={snapshot} pendingPenalty={pendingPenalty} size="xl" theme="auto" />
            {snapshot.phase === "stopped" ? (
              <div className="flex items-center gap-3">
                <PenaltyButtons value={pendingPenalty} onChange={setPendingPenalty} />
                <button
                  onClick={confirmSolve}
                  className="rounded-lg bg-emerald-600 px-5 py-2 font-semibold text-white transition hover:bg-emerald-500"
                >
                  {index + 1 >= SOLVES_PER_ROUND ? "Confirm & Finish" : "Confirm & Next"}
                </button>
              </div>
            ) : (
              <p className="h-10 text-center text-sm text-zinc-500">
                {instruction(snapshot.phase)}
              </p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

/* ── Progress bar ── */
function ProgressBar({ current, total }: { current: number; total: number }) {
  const pct = (current / total) * 100;
  return (
    <div className="flex items-center gap-3">
      <div className="h-2 flex-1 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-800">
        <div
          className="h-full rounded-full bg-emerald-500 transition-all duration-300"
          style={{ width: `${pct}%` }}
        />
      </div>
      <span className="font-mono text-xs text-zinc-500">
        {current}/{total}
      </span>
    </div>
  );
}

/* ── Instruction text ── */
function instruction(phase: string): string {
  switch (phase) {
    case "idle":
      return "click space to begin inspection";
    case "inspection":
      return "Hold Space to arm — release to start";
    case "ready":
      return "Release Space bar to start solving";
    case "solving":
      return "Press any key to stop";
    default:
      return "";
  }
}

function CenterMessage({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-white text-zinc-500 dark:bg-zinc-950 dark:text-zinc-400">
      {children}
    </div>
  );
}

function RoundComplete({
  finalAo5,
  solves,
  submit,
  onSubmit,
  userId,
  board,
  signedIn,
  cutoffFailed,
}: {
  finalAo5: number | null;
  solves: Solve[];
  submit:
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "done"; rank: number | null }
  | { kind: "error"; message: string };
  onSubmit: () => void;
  userId: string;
  board: ResultDto[];
  signedIn: boolean;
  cutoffFailed?: boolean;
}) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-6 px-6 py-10">
      {cutoffFailed ? (
        <div className="text-center">
          <div className="text-sm uppercase tracking-wider text-red-600 dark:text-red-400">Did not make cutoff</div>
          <div className="mt-2 font-mono text-5xl font-bold text-red-500">DNF</div>
          <div className="mt-2 font-mono text-sm text-zinc-500">
            {solves.map((s) => formatSolve(s)).join("   ")}
          </div>
          <p className="mt-4 max-w-sm text-sm text-zinc-500">
            Both solves exceeded the cutoff time. Your round has ended.
          </p>
        </div>
      ) : (
        <div className="text-center">
          <div className="text-sm uppercase tracking-wider text-zinc-500">Final ao5</div>
          <div className="font-mono text-7xl font-bold text-emerald-600 dark:text-emerald-400">
            {finalAo5 === null ? "DNF" : formatTime(finalAo5)}
          </div>
          <div className="mt-2 font-mono text-sm text-zinc-500">
            {solves.map((s) => formatSolve(s)).join("   ")}
          </div>
        </div>
      )}

      {submit.kind === "done" ? (
        <div className="text-center text-sm text-zinc-500 dark:text-zinc-400">
          Submitted! Redirecting…
        </div>
      ) : !signedIn ? (
        <Link
          href="/login"
          className="rounded-lg bg-emerald-600 px-6 py-2 font-semibold text-white transition hover:bg-emerald-500"
        >
          Sign in to submit results
        </Link>
      ) : (
        <div className="flex w-full max-w-md flex-col items-center gap-3">
          <button
            onClick={onSubmit}
            disabled={submit.kind === "submitting"}
            className="rounded-lg bg-emerald-600 px-6 py-2 font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-50"
          >
            {submit.kind === "submitting" ? "Submitting…" : "Submit results"}
          </button>
          <p className="text-xs text-zinc-500">You can upload your video from the event page after submitting.</p>
          {submit.kind === "error" && (
            <p className="text-sm text-red-600 dark:text-red-400">{submit.message}</p>
          )}
        </div>
      )}

      <div className="w-full max-w-md">
        <LeaderboardCard board={board} userId={userId} />
      </div>
    </div>
  );
}

function LeaderboardCard({
  board,
  userId,
}: {
  board: ResultDto[];
  userId: string;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="mb-3 flex items-center justify-between text-sm">
        <span className="text-zinc-500 dark:text-zinc-400">Live leaderboard</span>
        <span className="text-zinc-500">
          {board.length} competitor{board.length === 1 ? "" : "s"}
        </span>
      </div>
      {board.length === 0 ? (
        <p className="text-sm text-zinc-500 dark:text-zinc-600">No submissions yet.</p>
      ) : (
        <ol className="space-y-1 font-mono text-sm">
          {board.map((r) => (
            <li
              key={r.id}
              className={`flex justify-between rounded px-2 py-1 ${r.userId === userId ? "bg-emerald-100 dark:bg-emerald-900/30" : ""
                }`}
            >
              <span className="text-zinc-500 dark:text-zinc-400">
                #{r.rank} {r.userId === userId ? "(you)" : r.userId.slice(0, 8)}
              </span>
              <span className="text-zinc-900 dark:text-zinc-100">
                {r.ao5Ms === null ? "DNF" : formatTime(r.ao5Ms)}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}


function PenaltyButtons({
  value,
  onChange,
}: {
  value: SolvePenalty;
  onChange: (p: SolvePenalty) => void;
}) {
  const opts: { key: SolvePenalty; label: string }[] = [
    { key: "none", label: "OK" },
    { key: "plus2", label: "+2" },
    { key: "dnf", label: "DNF" },
  ];
  return (
    <div className="flex overflow-hidden rounded-lg border border-zinc-300 dark:border-zinc-700">
      {opts.map((o) => (
        <button
          key={o.key}
          type="button"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => onChange(o.key)}
          className={`px-4 py-2 text-sm font-semibold transition ${value === o.key
              ? "bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900"
              : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            }`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
