"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { Solve } from "@cubers/types";
import { formatTime, formatSolve } from "@cubers/timer-core";
import {
  fetchCompetitions,
  fetchCompetition,
  fetchRoundResults,
  fetchRoundJudges,
  fetchAvailableJudges,
  assignJudge,
  unassignJudge,
  verifyResult,
  publishRoundResults,
  type CompetitionSummary,
  type VerificationResultDto,
  type JudgeAssignmentDto,
  type AvailableJudgeDto,
} from "@/lib/api";
import { StatusBadge } from "@/components/ui/Badge";
import { eventDisplayName } from "@/lib/eventNames";
import { ConfirmModal } from "@/components/ui/Modal";

type EventRound = {
  eventType: string;
  rounds: { id: string; roundNumber: number; status: string; resultsPublishedAt?: string | null }[];
};

export default function AdminVerificationPage() {
  const [competitions, setCompetitions] = useState<CompetitionSummary[]>([]);
  const [selectedCompId, setSelectedCompId] = useState("");
  const [events, setEvents] = useState<EventRound[]>([]);
  const [selectedEventType, setSelectedEventType] = useState("");
  const [selectedRoundId, setSelectedRoundId] = useState("");

  const [results, setResults] = useState<VerificationResultDto[]>([]);
  const [judges, setJudges] = useState<JudgeAssignmentDto[]>([]);
  const [availableJudges, setAvailableJudges] = useState<AvailableJudgeDto[]>([]);
  const [showAssignDropdown, setShowAssignDropdown] = useState(false);

  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [publishMsg, setPublishMsg] = useState<string | null>(null);
  const [confirmPublish, setConfirmPublish] = useState(false);

  useEffect(() => {
    fetchCompetitions().then(setCompetitions).catch(() => {});
  }, []);

  useEffect(() => {
    if (!selectedCompId) {
      setEvents([]);
      setSelectedEventType("");
      setSelectedRoundId("");
      return;
    }
    fetchCompetition(selectedCompId)
      .then((comp) => {
        const evts: EventRound[] = comp.events.map((ev) => ({
          eventType: ev.eventType,
          rounds: ev.rounds.map((r) => ({
            id: r.id,
            roundNumber: r.roundNumber,
            status: r.status,
            resultsPublishedAt: r.resultsPublishedAt,
          })),
        }));
        setEvents(evts);
        setSelectedEventType("");
        setSelectedRoundId("");
      })
      .catch(() => {});
  }, [selectedCompId]);

  const filteredRounds =
    events.find((e) => e.eventType === selectedEventType)?.rounds ?? [];

  const loadRound = useCallback(
    async (roundId: string) => {
      if (!roundId) return;
      setLoading(true);
      setError(null);
      try {
        const [res, jdg] = await Promise.all([
          fetchRoundResults(roundId),
          fetchRoundJudges(roundId),
        ]);
        setResults(res);
        setJudges(jdg);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (selectedRoundId) loadRound(selectedRoundId);
    else {
      setResults([]);
      setJudges([]);
    }
  }, [selectedRoundId, loadRound]);

  const handleAssignJudge = async (judgeId: string) => {
    setBusy("assign");
    try {
      await assignJudge(judgeId, selectedRoundId);
      await loadRound(selectedRoundId);
      setShowAssignDropdown(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleUnassign = async (assignmentId: string) => {
    setBusy(`unassign-${assignmentId}`);
    try {
      await unassignJudge(assignmentId);
      await loadRound(selectedRoundId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleVerify = async (
    resultId: string,
    action: string,
    reason?: string,
    comment?: string,
  ) => {
    setBusy(`verify-${resultId}`);
    try {
      await verifyResult(resultId, action, reason, comment);
      await loadRound(selectedRoundId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handlePublish = async () => {
    setBusy("publish");
    setPublishMsg(null);
    try {
      const res = await publishRoundResults(selectedRoundId);
      let msg = `Results published! ${res.sentCount} notification${res.sentCount !== 1 ? "s" : ""} sent to ${res.recipientCount} participant${res.recipientCount !== 1 ? "s" : ""}.`;
      if (res.competitionCompleted) msg += " Competition marked as completed.";
      else if (res.eventCompleted) msg += " Event marked as completed.";
      setPublishMsg(msg);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const openAssignDropdown = async () => {
    if (availableJudges.length === 0) {
      try {
        const j = await fetchAvailableJudges();
        setAvailableJudges(j);
      } catch {}
    }
    setShowAssignDropdown(true);
  };

  const totalResults = results.length;
  const verifiedStatuses = ["verified", "plus2", "dnf", "disqualified"];
  const verifiedCount = results.filter(
    (r) => verifiedStatuses.includes(r.flagStatus),
  ).length;
  const flaggedCount = results.filter(
    (r) => r.flagStatus === "flagged",
  ).length;
  const allVerified = totalResults > 0 && verifiedCount === totalResults;

  return (
    <div className="mx-auto max-w-7xl px-6 py-8">
      <h1 className="mb-1 text-xl font-bold text-zinc-900 dark:text-zinc-100">
        Competition Verification
      </h1>
      <p className="mb-6 text-sm text-zinc-500">
        Select a competition, event, and round to review results. Assign judges
        and verify submissions.
      </p>

      {error && (
        <div className="mb-4 rounded bg-red-100 px-4 py-2 text-red-700 dark:bg-red-900/30 dark:text-red-300">
          {error}
        </div>
      )}

      {/* Filters row */}
      <div className="mb-6 flex flex-wrap items-end gap-4">
        <div>
          <label className="mb-1 block text-xs text-zinc-500">Competition</label>
          <select
            value={selectedCompId}
            onChange={(e) => setSelectedCompId(e.target.value)}
            className="w-[220px] rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          >
            <option value="">Select competition...</option>
            {competitions.map((c) => (
              <option key={c.id} value={c.id}>
                {c.title}
              </option>
            ))}
          </select>
        </div>

        {events.length > 0 && (
          <div>
            <label className="mb-1 block text-xs text-zinc-500">Event</label>
            <select
              value={selectedEventType}
              onChange={(e) => {
                setSelectedEventType(e.target.value);
                setSelectedRoundId("");
              }}
              className="w-[160px] rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            >
              <option value="">Select event...</option>
              {events.map((ev) => (
                <option key={ev.eventType} value={ev.eventType}>
                  {eventDisplayName(ev.eventType)}
                </option>
              ))}
            </select>
          </div>
        )}

        {filteredRounds.length > 0 && (
          <div>
            <label className="mb-1 block text-xs text-zinc-500">Round</label>
            <select
              value={selectedRoundId}
              onChange={(e) => setSelectedRoundId(e.target.value)}
              className="w-[180px] rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            >
              <option value="">Select round...</option>
              {filteredRounds.map((r) => (
                <option key={r.id} value={r.id}>
                  Round {r.roundNumber} ({r.status})
                </option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Round selected — show content */}
      {selectedRoundId && (
        <>
          {/* Stats + Judge Assignment header */}
          <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
            <div className="flex gap-4">
              <StatBadge label="Total" value={totalResults} />
              <StatBadge
                label="Verified"
                value={verifiedCount}
                color="text-emerald-500"
              />
              <StatBadge
                label="Flagged"
                value={flaggedCount}
                color="text-amber-500"
              />
              <StatBadge
                label="Pending"
                value={totalResults - verifiedCount}
                color="text-zinc-400"
              />
            </div>

            <div className="relative">
              <button
                onClick={openAssignDropdown}
                className="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500"
              >
                + Assign Judge
              </button>
              {showAssignDropdown && (
                <div className="absolute right-0 top-full z-10 mt-1 w-64 rounded-lg border border-zinc-200 bg-white shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
                  <div className="max-h-60 overflow-y-auto p-2">
                    {availableJudges.length === 0 ? (
                      <p className="p-2 text-xs text-zinc-500">
                        No judges available
                      </p>
                    ) : (
                      availableJudges
                        .filter(
                          (j) => !judges.some((a) => a.judgeId === j.id),
                        )
                        .map((j) => (
                          <button
                            key={j.id}
                            onClick={() => handleAssignJudge(j.id)}
                            disabled={busy === "assign"}
                            className="flex w-full items-center justify-between rounded px-3 py-2 text-sm hover:bg-zinc-100 dark:hover:bg-zinc-800"
                          >
                            <span className="text-zinc-800 dark:text-zinc-200">
                              {j.name}
                            </span>
                            <span className="text-[10px] uppercase text-zinc-400">
                              {j.role}
                            </span>
                          </button>
                        ))
                    )}
                  </div>
                  <div className="border-t border-zinc-200 p-2 dark:border-zinc-700">
                    <button
                      onClick={() => setShowAssignDropdown(false)}
                      className="w-full rounded px-3 py-1 text-xs text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                    >
                      Close
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Assigned judges */}
          {judges.length > 0 && (
            <div className="mb-6">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
                Assigned Judges
              </h3>
              <div className="flex flex-wrap gap-3">
                {judges.map((j) => (
                  <div
                    key={j.id}
                    className="flex items-center gap-3 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-2 dark:border-zinc-700 dark:bg-zinc-900/50"
                  >
                    <div>
                      <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                        {j.judgeName}
                      </span>
                      <span className="ml-2 font-mono text-[10px] text-zinc-400">
                        {j.judgeClId}
                      </span>
                    </div>
                    <div className="text-xs text-zinc-500">
                      {j.verifiedCount}/{j.totalResults} verified
                    </div>
                    <div className="h-1.5 w-20 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                      <div
                        className="h-full rounded-full bg-emerald-500 transition-all"
                        style={{
                          width: `${j.totalResults ? (j.verifiedCount / j.totalResults) * 100 : 0}%`,
                        }}
                      />
                    </div>
                    <button
                      onClick={() => handleUnassign(j.id)}
                      disabled={busy === `unassign-${j.id}`}
                      className="text-xs text-zinc-400 hover:text-red-500"
                      title="Remove assignment"
                    >
                      ×
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Results table */}
          {loading ? (
            <p className="text-zinc-500">Loading results...</p>
          ) : results.length === 0 ? (
            <div className="rounded-xl border border-zinc-200 bg-zinc-50 p-10 text-center text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900/30">
              No results submitted for this round yet.
            </div>
          ) : (
            <div className="space-y-4">
              {results
                .sort((a, b) => {
                  // Flagged first, then unverified, then verified
                  const order: Record<string, number> = {
                    flagged: 0,
                    clean: 1,
                    verified: 2,
                    plus2: 2,
                    dnf: 2,
                    disqualified: 2,
                  };
                  return (
                    (order[a.flagStatus] ?? 1) - (order[b.flagStatus] ?? 1)
                  );
                })
                .map((r) => (
                  <ResultVerificationCard
                    key={r.id}
                    result={r}
                    busy={busy}
                    onVerify={handleVerify}
                  />
                ))}
            </div>
          )}

          {/* Publish Results */}
          {selectedRoundId && (() => {
            const currentRound = filteredRounds.find((r) => r.id === selectedRoundId);
            const isPublished = !!currentRound?.resultsPublishedAt || !!publishMsg;
            return (
              <div className="mt-8 border-t border-zinc-200 pt-6 dark:border-zinc-700">
                {publishMsg && (
                  <div className="mb-4 rounded-lg bg-emerald-100 px-4 py-3 text-sm text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
                    {publishMsg}
                  </div>
                )}
                <div className="flex items-center justify-between">
                  <div>
                    <h3 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                      {isPublished ? "Results Published" : "Publish Results"}
                    </h3>
                    <p className="text-xs text-zinc-500">
                      {isPublished
                        ? "Results for this round have been published and participants notified."
                        : allVerified
                          ? "Notify all participants that results for this round are available."
                          : `All results must be verified before publishing. ${totalResults - verifiedCount} remaining.`}
                    </p>
                  </div>
                  {isPublished ? (
                    <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-4 py-2 text-sm font-semibold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
                      Published
                    </span>
                  ) : (
                    <button
                      onClick={() => setConfirmPublish(true)}
                      disabled={busy === "publish" || !allVerified}
                      className="rounded-lg bg-emerald-600 px-6 py-2.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                    >
                      {busy === "publish" ? "Publishing..." : "Publish Results"}
                    </button>
                  )}
                </div>
              </div>
            );
          })()}
        </>
      )}

      <ConfirmModal
        open={confirmPublish}
        onClose={() => setConfirmPublish(false)}
        onConfirm={() => {
          setConfirmPublish(false);
          handlePublish();
        }}
        destructive={false}
        title="Publish Results"
        description="Publish results and notify all participants? This cannot be undone."
        confirmLabel="Publish"
      />
    </div>
  );
}

function StatBadge({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color?: string;
}) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-2 text-center dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">
        {label}
      </div>
      <div className={`text-lg font-bold font-mono ${color ?? ""}`}>
        {value}
      </div>
    </div>
  );
}

function ResultVerificationCard({
  result,
  busy,
  onVerify,
}: {
  result: VerificationResultDto;
  busy: string | null;
  onVerify: (
    id: string,
    action: string,
    reason?: string,
    comment?: string,
  ) => void;
}) {
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");
  const [expanded, setExpanded] = useState(false);
  const isBusy = busy === `verify-${result.id}`;
  const isFlagged = result.flagStatus === "flagged";
  const isVerified =
    result.flagStatus === "verified" ||
    result.flagStatus === "plus2" ||
    result.flagStatus === "dnf" ||
    result.flagStatus === "disqualified";

  const handleAction = (action: string) => {
    onVerify(result.id, action, reason.trim() || undefined, comment.trim() || undefined);
    setReason("");
    setComment("");
  };

  const borderColor = isFlagged
    ? "border-amber-400 dark:border-amber-800"
    : isVerified
      ? "border-emerald-300 dark:border-emerald-900"
      : "border-zinc-200 dark:border-zinc-800";

  return (
    <div
      className={`rounded-xl border ${borderColor} bg-zinc-50 p-5 dark:bg-zinc-900/40`}
    >
      {/* Header */}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-3">
          <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
            {result.userName}
          </span>
          <span className="font-mono text-[11px] text-zinc-500">
            {result.userClId}
          </span>
          <StatusBadge domain="verification" status={result.flagStatus} />
          {result.rank && (
            <span className="text-xs text-zinc-500">#{result.rank}</span>
          )}
        </div>
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      </div>

      {/* Stats row */}
      <div className="mb-3 flex flex-wrap gap-6 text-sm">
        <div>
          <span className="text-zinc-500">ao5: </span>
          <span className="font-mono text-zinc-800 dark:text-zinc-200">
            {result.ao5Ms !== null ? formatTime(result.ao5Ms) : "DNF"}
          </span>
        </div>
        <div>
          <span className="text-zinc-500">Best: </span>
          <span className="font-mono text-zinc-800 dark:text-zinc-200">
            {result.bestSingleMs !== null
              ? formatTime(result.bestSingleMs)
              : "DNF"}
          </span>
        </div>
        {result.videoUrl && (
          <a
            href={result.videoUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-blue-500 underline hover:text-blue-400"
          >
            Watch Video
          </a>
        )}
        {!result.videoUrl && (
          <span className="text-xs text-zinc-400">No video</span>
        )}
      </div>

      {/* Solves */}
      <div className="mb-3">
        <span className="text-xs text-zinc-500">Solves: </span>
        <span className="font-mono text-xs text-zinc-700 dark:text-zinc-300">
          {result.solves.map((s: Solve, i: number) => (
            <span key={i}>
              {i > 0 && ", "}
              {formatSolve(s)}
            </span>
          ))}
        </span>
      </div>

      {/* Verification info */}
      {isVerified && result.verifiedAt && (
        <div className="mb-3 rounded-lg bg-emerald-50 px-3 py-2 text-xs dark:bg-emerald-900/20">
          <span className="text-emerald-700 dark:text-emerald-400">
            Verified as {result.flagStatus}
          </span>
          {result.verifiedAt && (
            <span className="ml-2 text-zinc-500">
              {new Date(result.verifiedAt).toLocaleString()}
            </span>
          )}
          {result.verificationComment && (
            <p className="mt-1 text-zinc-600 dark:text-zinc-400">
              &quot;{result.verificationComment}&quot;
            </p>
          )}
        </div>
      )}

      {/* Expanded: action area */}
      {expanded && (
        <div className="mt-4 space-y-3 border-t border-zinc-200 pt-4 dark:border-zinc-700">
          <div>
            <label className="mb-1 block text-xs text-zinc-500">
              Reason (required for +2/DNF/DQ)
            </label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Enter reason..."
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs text-zinc-500">
              Comment (optional)
            </label>
            <input
              type="text"
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              placeholder="Add a comment..."
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              onClick={() => handleAction("verified")}
              disabled={isBusy}
              className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
            >
              Verify
            </button>
            <button
              onClick={() => handleAction("plus2")}
              disabled={isBusy || !reason.trim()}
              className="rounded-lg bg-amber-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-amber-500 disabled:opacity-50"
            >
              +2
            </button>
            <button
              onClick={() => handleAction("dnf")}
              disabled={isBusy || !reason.trim()}
              className="rounded-lg bg-orange-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-orange-500 disabled:opacity-50"
            >
              DNF
            </button>
            <button
              onClick={() => handleAction("disqualified")}
              disabled={isBusy || !reason.trim()}
              className="rounded-lg bg-red-600 px-4 py-1.5 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50"
            >
              Disqualify
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
