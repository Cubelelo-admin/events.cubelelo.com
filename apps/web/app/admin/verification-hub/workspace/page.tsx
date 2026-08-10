"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import type { Solve } from "@cubers/types";
import { formatTime, formatSolve } from "@cubers/timer-core";
import {
  fetchRoundResults,
  fetchRoundJudges,
  fetchRoundScrambles,
  fetchJudgeRoundResults,
  fetchJudgeRoundScrambles,
  judgeVerifyResult,
  verifyResult,
  reflagRound,
  bulkVerify,
  bulkUndo,
  fetchResultAudit,
  type VerificationResultDto,
  type JudgeAssignmentDto,
  type AuditTrailEntry,
} from "@/lib/api";
import { useAuth } from "@/features/auth/AuthProvider";
import { eventDisplayName } from "@/lib/eventNames";
import { EventIcon } from "@/components/EventIcon";
import { StatusBadge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/Skeleton";
import { useSidebar } from "@/features/admin/SidebarContext";
import { TwistyPlayer } from "@/features/scramble/TwistyPlayer";
import { EVENTS, type EventId } from "@cubers/scramble-core";

/* ── Tab definitions ─────────────────────────────────────────────────────── */

type TabId = "unflagged" | "flagged" | "verified";

const TABS: { id: TabId; label: string; filter: (r: VerificationResultDto) => boolean }[] = [
  { id: "unflagged", label: "Unflagged", filter: (r) => r.flagStatus === "clean" },
  { id: "flagged",   label: "Flagged",   filter: (r) => r.flagStatus === "flagged" },
  {
    id: "verified",
    label: "Verified",
    filter: (r) =>
      r.flagStatus === "verified" ||
      r.flagStatus === "plus2" ||
      r.flagStatus === "dnf" ||
      r.flagStatus === "disqualified",
  },
];

/* ── Video embed helper ──────────────────────────────────────────────────── */

function extractYoutubeId(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.hostname.includes("youtu.be")) return u.pathname.slice(1).split("/")[0];
    if (u.hostname.includes("youtube.com")) return u.searchParams.get("v");
  } catch { /* not a URL */ }
  return null;
}

/* ── Main Page ───────────────────────────────────────────────────────────── */

export default function VerificationWorkspacePage() {
  const searchParams = useSearchParams();
  const roundId = searchParams.get("roundId") ?? "";
  const { setCollapsed } = useSidebar();
  const { user } = useAuth();
  const isJudgeOnly = user?.role === "judge";

  // Auto-hide sidebar in workspace for maximum working space
  useEffect(() => {
    setCollapsed(true);
    return () => setCollapsed(false);
  }, [setCollapsed]);

  const [results, setResults] = useState<VerificationResultDto[]>([]);
  const [judges, setJudges] = useState<JudgeAssignmentDto[]>([]);
  const [scrambles, setScrambles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const [activeTab, setActiveTab] = useState<TabId>("unflagged");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  // Verification form state
  const [reason, setReason] = useState("");
  const [comment, setComment] = useState("");

  // §8 — Bulk selection (admin/mod only)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkReason, setBulkReason] = useState("");
  const [undoStack, setUndoStack] = useState<{ id: string; flagStatus: string }[][]>([]);

  const loadData = useCallback(async () => {
    if (!roundId) return;
    setLoading(true);
    setError(null);
    try {
      // Judges use judge-scoped endpoints; admins/mods use admin endpoints
      const resultsPromise = isJudgeOnly
        ? fetchJudgeRoundResults(roundId)
        : fetchRoundResults(roundId);
      const judgesPromise = isJudgeOnly
        ? Promise.resolve([] as JudgeAssignmentDto[])
        : fetchRoundJudges(roundId);
      const scramblesPromise = (isJudgeOnly
        ? fetchJudgeRoundScrambles(roundId)
        : fetchRoundScrambles(roundId)
      ).catch(() => ({ scrambles: [] as string[] }));

      const [res, jdg, scr] = await Promise.all([resultsPromise, judgesPromise, scramblesPromise]);
      setResults(res);
      setJudges(jdg);
      setScrambles(scr.scrambles);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [roundId]);

  useEffect(() => { loadData(); }, [loadData]);

  // Filtered & sorted results for active tab
  const filteredResults = TABS.find((t) => t.id === activeTab)!.filter;
  const tabResults = results.filter(filteredResults).sort((a, b) => {
    if (activeTab === "flagged") {
      if (a.priority !== b.priority) return b.priority - a.priority;
    }
    return (a.rank ?? 9999) - (b.rank ?? 9999);
  });

  // Auto-select first result when tab changes
  useEffect(() => {
    if (tabResults.length > 0 && (!selectedId || !tabResults.find((r) => r.id === selectedId))) {
      setSelectedId(tabResults[0].id);
    }
    setSelectedIds(new Set()); // clear bulk selection on tab change
  }, [activeTab, tabResults.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = results.find((r) => r.id === selectedId) ?? null;

  // Keyboard navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "TEXTAREA") return;
      if (e.key === "ArrowDown" || e.key === "j") {
        e.preventDefault();
        const idx = tabResults.findIndex((r) => r.id === selectedId);
        if (idx < tabResults.length - 1) setSelectedId(tabResults[idx + 1].id);
      } else if (e.key === "ArrowUp" || e.key === "k") {
        e.preventDefault();
        const idx = tabResults.findIndex((r) => r.id === selectedId);
        if (idx > 0) setSelectedId(tabResults[idx - 1].id);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedId, tabResults]);

  const handleVerify = async (action: string) => {
    if (!selected) return;
    setBusy(`verify-${selected.id}`);
    try {
      const verifyFn = isJudgeOnly ? judgeVerifyResult : verifyResult;
      await verifyFn(selected.id, action, reason.trim() || undefined, comment.trim() || undefined);
      setReason("");
      setComment("");
      await loadData();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleReflag = async () => {
    setBusy("reflag");
    try {
      const res = await reflagRound(roundId);
      await loadData();
      if (res.updated > 0) showToast(`Re-flagged: ${res.updated} of ${res.totalResults} results updated.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  // §8 — Bulk actions
  const toggleSelect = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === tabResults.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(tabResults.map((r) => r.id)));
    }
  };

  const handleBulkVerify = async (action: string) => {
    if (selectedIds.size === 0) return;
    setBusy("bulk");
    try {
      const res = await bulkVerify([...selectedIds], action, bulkReason.trim() || undefined);
      setUndoStack((prev) => [...prev, res.previousStates]);
      setSelectedIds(new Set());
      setBulkReason("");
      await loadData();
      showToast(`Bulk ${action}: ${res.updated} results updated.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleUndo = async () => {
    if (undoStack.length === 0) return;
    setBusy("undo");
    try {
      const last = undoStack[undoStack.length - 1];
      const res = await bulkUndo(last);
      setUndoStack((prev) => prev.slice(0, -1));
      await loadData();
      showToast(`Undo: ${res.restored} results restored.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 4000);
  };

  // Tab counts
  const counts: Record<TabId, number> = {
    unflagged: results.filter(TABS[0].filter).length,
    flagged: results.filter(TABS[1].filter).length,
    verified: results.filter(TABS[2].filter).length,
  };

  const roundInfo = results[0]
    ? { eventType: results[0].eventType, roundNumber: results[0].roundNumber }
    : null;

  if (!roundId) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center">
        <div className="text-center">
          <p className="text-zinc-500 dark:text-zinc-400">No round selected.</p>
          <Link
            href={isJudgeOnly ? "/judge/verifications" : "/admin/verification-hub"}
            className="mt-2 text-sm text-blue-500 hover:underline"
          >
            ← {isJudgeOnly ? "Back to My Verifications" : "Back to Hub"}
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100vh-56px)] flex-col">
      {/* Header bar */}
      <div className="flex items-center justify-between border-b border-zinc-200 bg-white px-5 py-3 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center gap-3">
          <SidebarToggle />
          <Link
            href={isJudgeOnly ? "/judge/verifications" : "/admin/verification-hub"}
            className="text-xs text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
          >
            ← {isJudgeOnly ? "My Verifications" : "Hub"}
          </Link>
          {roundInfo && (
            <>
              <EventIcon eventId={roundInfo.eventType} size={18} />
              <span className="text-sm font-bold text-zinc-800 dark:text-zinc-200">
                {eventDisplayName(roundInfo.eventType)} — Round {roundInfo.roundNumber}
              </span>
            </>
          )}
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-mono text-zinc-500 dark:bg-zinc-800">
            {results.length} results
          </span>
        </div>
        <div className="flex items-center gap-2">
          {!isJudgeOnly && (
            <button
              onClick={handleReflag}
              disabled={busy === "reflag"}
              className="rounded-md border border-amber-300 bg-amber-50 px-3 py-1 text-[11px] font-semibold text-amber-700 hover:bg-amber-100 disabled:opacity-50 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-400"
              title="Re-run flag rules on all unverified results"
            >
              {busy === "reflag" ? "Re-flagging..." : "⚑ Re-flag"}
            </button>
          )}
          {!isJudgeOnly && undoStack.length > 0 && (
            <button
              onClick={handleUndo}
              disabled={busy === "undo"}
              className="rounded-md border border-zinc-300 bg-white px-3 py-1 text-[11px] font-semibold text-zinc-600 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-400"
            >
              ↩ Undo
            </button>
          )}
          {judges.map((j) => (
            <span
              key={j.id}
              className="rounded-full bg-blue-50 px-2.5 py-0.5 text-[10px] font-medium text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
            >
              {j.judgeName}
            </span>
          ))}
        </div>
      </div>

      {error && (
        <div className="bg-red-100 px-5 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
          {error}
          <button onClick={() => setError(null)} className="ml-2 font-bold">×</button>
        </div>
      )}

      {/* §8 toast */}
      {toast && (
        <div className="bg-emerald-100 px-5 py-2 text-sm text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
          {toast}
        </div>
      )}

      {loading ? (
        <div className="flex-1 p-6">
          <Skeleton className="mb-4 h-10 w-full rounded-lg" />
          <div className="grid grid-cols-2 gap-4">
            <Skeleton className="h-64 rounded-xl" />
            <Skeleton className="h-64 rounded-xl" />
          </div>
        </div>
      ) : (
        <div className="flex flex-1 overflow-hidden">
          {/* ── Left panel: tabs + result list ── */}
          <div className="flex w-[380px] flex-shrink-0 flex-col border-r border-zinc-200 dark:border-zinc-800">
            {/* Tabs */}
            <div className="flex border-b border-zinc-200 dark:border-zinc-800">
              {TABS.map((tab) => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`flex-1 px-3 py-2.5 text-xs font-semibold transition ${
                    activeTab === tab.id
                      ? "border-b-2 border-emerald-500 text-emerald-600 dark:text-emerald-400"
                      : "text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                  }`}
                >
                  {tab.label}
                  <span className={`ml-1.5 rounded-full px-1.5 py-0.5 text-[10px] font-bold ${
                    activeTab === tab.id
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300"
                      : "bg-zinc-100 text-zinc-500 dark:bg-zinc-800"
                  }`}>
                    {counts[tab.id]}
                  </span>
                </button>
              ))}
            </div>

            {/* §8 — Bulk action bar (admin/mod only) */}
            {!isJudgeOnly && tabResults.length > 0 && (
              <div className="flex items-center gap-2 border-b border-zinc-200 px-3 py-2 dark:border-zinc-800">
                <label className="flex items-center gap-1.5 text-[11px] text-zinc-500">
                  <input
                    type="checkbox"
                    checked={selectedIds.size === tabResults.length && tabResults.length > 0}
                    onChange={toggleSelectAll}
                    className="accent-emerald-500"
                  />
                  All
                </label>
                {selectedIds.size > 0 && (
                  <>
                    <span className="text-[10px] font-mono text-zinc-400">{selectedIds.size} selected</span>
                    <div className="ml-auto flex items-center gap-1">
                      {activeTab !== "verified" && (
                        <>
                          <input
                            type="text"
                            value={bulkReason}
                            onChange={(e) => setBulkReason(e.target.value)}
                            placeholder="Reason..."
                            className="w-24 rounded border border-zinc-300 px-1.5 py-0.5 text-[10px] dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-200"
                          />
                          <button
                            onClick={() => handleBulkVerify("verified")}
                            disabled={busy === "bulk"}
                            className="rounded bg-emerald-600 px-2 py-0.5 text-[10px] font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                          >
                            ✓ Bulk Verify
                          </button>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
            )}

            {/* Result list */}
            <div className="flex-1 overflow-y-auto">
              {tabResults.length === 0 ? (
                <div className="flex h-full items-center justify-center p-4 text-center text-xs text-zinc-400">
                  No results in this tab.
                </div>
              ) : (
                tabResults.map((r) => (
                  <ResultListItem
                    key={r.id}
                    result={r}
                    isSelected={selectedId === r.id}
                    isChecked={selectedIds.has(r.id)}
                    showCheckbox={!isJudgeOnly}
                    onCheck={() => toggleSelect(r.id)}
                    onClick={() => { setSelectedId(r.id); setReason(""); setComment(""); }}
                  />
                ))
              )}
            </div>
          </div>

          {/* ── Right panel: detail + actions ── */}
          <div className="flex-1 overflow-y-auto bg-zinc-50 dark:bg-zinc-900/30">
            {selected ? (
              <ResultDetail
                result={selected}
                scrambles={scrambles}
                isJudgeOnly={isJudgeOnly}
                reason={reason}
                comment={comment}
                busy={busy}
                onReasonChange={setReason}
                onCommentChange={setComment}
                onVerify={handleVerify}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-zinc-400">
                Select a result from the list.
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Result list item (left panel) ───────────────────────────────────────── */

function ResultListItem({
  result,
  isSelected,
  isChecked,
  showCheckbox = true,
  onCheck,
  onClick,
}: {
  result: VerificationResultDto;
  isSelected: boolean;
  isChecked: boolean;
  showCheckbox?: boolean;
  onCheck: () => void;
  onClick: () => void;
}) {
  return (
    <div
      className={`flex border-b border-zinc-100 transition dark:border-zinc-800/50 ${
        isSelected
          ? "bg-emerald-50 dark:bg-emerald-950/20"
          : "hover:bg-zinc-50 dark:hover:bg-zinc-900/40"
      }`}
    >
      {/* §8 checkbox */}
      {showCheckbox && <div className="flex items-start px-2 pt-3.5">
        <input
          type="checkbox"
          checked={isChecked}
          onChange={onCheck}
          className="accent-emerald-500"
          onClick={(e) => e.stopPropagation()}
        />
      </div>}
      <button onClick={onClick} className="flex-1 px-2 py-3 text-left">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
              {result.userName}
            </span>
            <span className="font-mono text-[10px] text-zinc-400">{result.userClId}</span>
          </div>
          <StatusBadge domain="verification" status={result.flagStatus} />
        </div>
        <div className="mt-1 flex items-center gap-3 text-xs text-zinc-500">
          <span className="font-mono">
            ao5: {result.ao5Ms !== null ? formatTime(result.ao5Ms) : "DNF"}
          </span>
          <span className="font-mono">
            best: {result.bestSingleMs !== null ? formatTime(result.bestSingleMs) : "DNF"}
          </span>
          {result.rank && <span>#{result.rank}</span>}
          {!result.videoUrl && <span className="text-amber-500">⚠ No video</span>}
        </div>
        {result.flagReasons.length > 0 && (
          <div className="mt-1 flex items-center gap-1">
            {result.priority > 0 && (
              <span
                className={`rounded px-1 py-0.5 text-[9px] font-bold ${
                  result.priority >= 16
                    ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                    : result.priority >= 8
                      ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                      : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
                }`}
                title="Priority score"
              >
                P{result.priority}
              </span>
            )}
            {result.flagReasons.slice(0, 2).map((fr, i) => (
              <span
                key={i}
                className="rounded bg-amber-100 px-1.5 py-0.5 text-[9px] text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
              >
                {fr.type.replace(/_/g, " ")}
              </span>
            ))}
            {result.flagReasons.length > 2 && (
              <span className="text-[9px] text-zinc-400">+{result.flagReasons.length - 2}</span>
            )}
          </div>
        )}
      </button>
    </div>
  );
}

/* ── Result detail (right panel) ─────────────────────────────────────────── */

function ResultDetail({
  result,
  scrambles,
  isJudgeOnly,
  reason,
  comment,
  busy,
  onReasonChange,
  onCommentChange,
  onVerify,
}: {
  result: VerificationResultDto;
  scrambles: string[];
  isJudgeOnly: boolean;
  reason: string;
  comment: string;
  busy: string | null;
  onReasonChange: (v: string) => void;
  onCommentChange: (v: string) => void;
  onVerify: (action: string) => void;
}) {
  const isBusy = busy === `verify-${result.id}`;
  const isVerified =
    result.flagStatus === "verified" ||
    result.flagStatus === "plus2" ||
    result.flagStatus === "dnf" ||
    result.flagStatus === "disqualified";

  const ytId = result.videoUrl ? extractYoutubeId(result.videoUrl) : null;

  // §10 — Audit trail (use ref to track result ID changes instead of useEffect
  // to avoid StrictMode double-mount resetting showAudit after async fetch)
  const [auditTrail, setAuditTrail] = useState<AuditTrailEntry[]>([]);
  const [showAudit, setShowAudit] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  const prevResultId = useRef(result.id);

  if (prevResultId.current !== result.id) {
    prevResultId.current = result.id;
    if (showAudit) setShowAudit(false);
    if (auditTrail.length > 0) setAuditTrail([]);
  }

  const loadAudit = async () => {
    if (showAudit) { setShowAudit(false); return; }
    setAuditLoading(true);
    try {
      const trail = await fetchResultAudit(result.id);
      setAuditTrail(trail);
      setShowAudit(true);
    } catch { /* ignore */ }
    finally { setAuditLoading(false); }
  };

  return (
    <div className="p-6">
      {/* Header */}
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-zinc-800 dark:text-zinc-100">
            {result.userName}
          </h2>
          <span className="font-mono text-xs text-zinc-400">{result.userClId}</span>
        </div>
        <div className="flex items-center gap-2">
          <StatusBadge domain="verification" status={result.flagStatus} />
          {result.rank && (
            <span className="rounded bg-zinc-200 px-2 py-0.5 text-xs font-mono font-bold text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">
              #{result.rank}
            </span>
          )}
        </div>
      </div>

      {/* Stats cards */}
      <div className="mb-5 grid grid-cols-3 gap-3">
        <StatCard label="Average (ao5)" value={result.ao5Ms !== null ? formatTime(result.ao5Ms) : "DNF"} />
        <StatCard label="Best Single" value={result.bestSingleMs !== null ? formatTime(result.bestSingleMs) : "DNF"} />
        <StatCard label="Submitted" value={new Date(result.submittedAt).toLocaleString()} small />
      </div>

      {/* Solves */}
      <div className="mb-5 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Individual Solves
        </h3>
        <div className="flex flex-wrap gap-2">
          {result.solves.map((s: Solve, i: number) => (
            <span
              key={i}
              className={`rounded-md border px-3 py-1.5 font-mono text-sm ${
                s.penalty === "dnf"
                  ? "border-red-200 bg-red-50 text-red-600 dark:border-red-900 dark:bg-red-950/30 dark:text-red-400"
                  : s.penalty === "plus2"
                    ? "border-amber-200 bg-amber-50 text-amber-600 dark:border-amber-900 dark:bg-amber-950/30 dark:text-amber-400"
                    : "border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
              }`}
            >
              {formatSolve(s)}
            </span>
          ))}
        </div>
      </div>

      {/* Scrambles */}
      {scrambles.length > 0 && <ScrambleViewer scrambles={scrambles} solveCount={result.solves.length} eventType={result.eventType} />}

      {/* Flag reasons */}
      {result.flagReasons.length > 0 && (
        <div className="mb-5 rounded-lg border border-amber-200 bg-amber-50/50 p-4 dark:border-amber-900 dark:bg-amber-950/20">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
            Flag Reasons
          </h3>
          <div className="space-y-2">
            {result.flagReasons.map((fr, i) => (
              <div key={i} className="flex items-start gap-2 text-sm">
                <span className="mt-0.5 rounded bg-amber-200 px-1.5 py-0.5 text-[10px] font-bold uppercase text-amber-800 dark:bg-amber-800 dark:text-amber-200">
                  {fr.severity}
                </span>
                <div>
                  <span className="font-medium text-amber-800 dark:text-amber-300">
                    {fr.type.replace(/_/g, " ")}
                  </span>
                  <p className="text-xs text-amber-700/80 dark:text-amber-400/70">{fr.message}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* §9 — Video review panel */}
      <div className="mb-5 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Video Review
          </h3>
          {result.videoUrl && (
            <a
              href={result.videoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-[10px] text-blue-500 hover:underline"
            >
              Open in new tab ↗
            </a>
          )}
        </div>
        {result.videoUrl ? (
          <>
            {ytId ? (
              <div className="aspect-video w-full overflow-hidden rounded-lg bg-black">
                <iframe
                  src={`https://www.youtube-nocookie.com/embed/${ytId}?rel=0`}
                  className="h-full w-full"
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                  title="Solve video"
                />
              </div>
            ) : (
              <div className="rounded-lg border border-blue-200 bg-blue-50/50 p-4 dark:border-blue-900 dark:bg-blue-950/20">
                <p className="mb-2 text-xs text-zinc-500">Non-YouTube video link:</p>
                <a
                  href={result.videoUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-1.5 rounded-lg bg-blue-100 px-4 py-2 text-sm font-medium text-blue-700 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-400"
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                  Open Video
                </a>
                <p className="mt-2 break-all font-mono text-[10px] text-zinc-400">{result.videoUrl}</p>
              </div>
            )}
          </>
        ) : (
          <div className="rounded-lg border border-dashed border-zinc-300 p-6 text-center dark:border-zinc-700">
            <span className="text-2xl">📹</span>
            <p className="mt-1 text-xs text-zinc-400">No video submitted</p>
          </div>
        )}
      </div>

      {/* Verification info (if already verified) */}
      {isVerified && result.verifiedAt && (
        <div className="mb-5 rounded-lg border border-emerald-200 bg-emerald-50/50 p-4 dark:border-emerald-900 dark:bg-emerald-950/20">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wider text-emerald-600 dark:text-emerald-400">
            Verification Record
          </h3>
          <p className="text-sm text-emerald-700 dark:text-emerald-300">
            Verified as <strong>{result.flagStatus}</strong>
            {result.verifiedByName && <> by {result.verifiedByName}</>}
            <span className="ml-2 text-xs text-zinc-500">
              {new Date(result.verifiedAt).toLocaleString()}
            </span>
          </p>
          {result.verificationComment && (
            <p className="mt-1 text-xs italic text-zinc-600 dark:text-zinc-400">
              &ldquo;{result.verificationComment}&rdquo;
            </p>
          )}
        </div>
      )}

      {/* Action area */}
      <div className="mb-5 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-zinc-500">
          {isVerified ? "Re-verify" : "Verify Result"}
        </h3>

        <div className="mb-3 grid grid-cols-2 gap-3">
          <div>
            <label className="mb-1 block text-[11px] font-medium text-zinc-500">
              Reason <span className="text-zinc-400">(required for +2/DNF/DQ)</span>
            </label>
            <input
              type="text"
              value={reason}
              onChange={(e) => onReasonChange(e.target.value)}
              placeholder="Enter reason..."
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </div>
          <div>
            <label className="mb-1 block text-[11px] font-medium text-zinc-500">
              Comment <span className="text-zinc-400">(optional)</span>
            </label>
            <input
              type="text"
              value={comment}
              onChange={(e) => onCommentChange(e.target.value)}
              placeholder="Add a comment..."
              className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
            />
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => onVerify("verified")}
            disabled={isBusy}
            className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            ✓ Verify Clean
          </button>
          <button
            onClick={() => onVerify("plus2")}
            disabled={isBusy || !reason.trim()}
            className="rounded-lg bg-amber-600 px-5 py-2 text-sm font-semibold text-white hover:bg-amber-500 disabled:opacity-50"
          >
            +2 Penalty
          </button>
          <button
            onClick={() => onVerify("dnf")}
            disabled={isBusy || !reason.trim()}
            className="rounded-lg bg-orange-600 px-5 py-2 text-sm font-semibold text-white hover:bg-orange-500 disabled:opacity-50"
          >
            DNF
          </button>
          <button
            onClick={() => onVerify("disqualified")}
            disabled={isBusy || !reason.trim()}
            className="rounded-lg bg-red-600 px-5 py-2 text-sm font-semibold text-white hover:bg-red-500 disabled:opacity-50"
          >
            Disqualify
          </button>
        </div>
      </div>

      {/* §10 — Audit trail (admin/mod only) */}
      {!isJudgeOnly && <div className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <button
          onClick={loadAudit}
          className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          {auditLoading ? "Loading..." : showAudit ? "▾ Audit Trail" : "▸ Audit Trail"}
        </button>
        {showAudit && auditTrail.length > 0 && (
          <div className="mt-3 space-y-2">
            {auditTrail.map((e) => (
              <div key={e.id} className="flex items-start gap-3 border-l-2 border-zinc-200 pl-3 dark:border-zinc-700">
                <div className="flex-1">
                  <div className="flex items-center gap-2 text-xs">
                    <span className="font-semibold text-zinc-700 dark:text-zinc-300">{e.adminName}</span>
                    <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-mono text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                      {e.action}
                    </span>
                    <span className="text-zinc-400">{new Date(e.createdAt).toLocaleString()}</span>
                  </div>
                  {e.reason && (
                    <p className="mt-0.5 text-[11px] text-zinc-500">Reason: {e.reason}</p>
                  )}
                  {e.oldValue && e.newValue && (
                    <div className="mt-1 flex items-center gap-2 text-[10px] font-mono">
                      <span className="rounded bg-red-50 px-1.5 py-0.5 text-red-600 dark:bg-red-900/20 dark:text-red-400">
                        {(e.oldValue as Record<string, unknown>).flagStatus as string ?? "—"}
                      </span>
                      <span className="text-zinc-400">→</span>
                      <span className="rounded bg-emerald-50 px-1.5 py-0.5 text-emerald-600 dark:bg-emerald-900/20 dark:text-emerald-400">
                        {(e.newValue as Record<string, unknown>).flagStatus as string ?? "—"}
                      </span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
        {showAudit && auditTrail.length === 0 && (
          <p className="mt-2 text-xs text-zinc-400">No audit history for this result.</p>
        )}
      </div>}
    </div>
  );
}

/* ── Scramble viewer ────────────────────────────────────────────────────── */

function ScrambleViewer({ scrambles, solveCount, eventType }: { scrambles: string[]; solveCount: number; eventType: string }) {
  const [index, setIndex] = useState(0);
  const total = Math.min(scrambles.length, solveCount);

  // Reset to 0 when scrambles change (different round)
  useEffect(() => { setIndex(0); }, [scrambles]);

  if (total === 0) return null;

  const safeIndex = Math.min(index, total - 1);
  const puzzle = (eventType in EVENTS) ? EVENTS[eventType as EventId].puzzle : "3x3x3";

  return (
    <div className="mb-5 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
          Scramble
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setIndex(Math.max(0, safeIndex - 1))}
            disabled={safeIndex === 0}
            className="rounded px-2 py-0.5 text-xs font-semibold text-zinc-500 transition hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800"
          >
            ‹ Prev
          </button>
          <span className="font-mono text-xs text-zinc-600 dark:text-zinc-400">
            {safeIndex + 1} / {total}
          </span>
          <button
            onClick={() => setIndex(Math.min(total - 1, safeIndex + 1))}
            disabled={safeIndex >= total - 1}
            className="rounded px-2 py-0.5 text-xs font-semibold text-zinc-500 transition hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800"
          >
            Next ›
          </button>
        </div>
      </div>

      {/* Scramble diagram + notation side by side */}
      <div className="flex gap-4">
        {/* 2D cube state diagram */}
        <div className="flex-shrink-0 rounded-lg border border-zinc-100 bg-zinc-50 p-2 dark:border-zinc-800 dark:bg-zinc-900">
          <TwistyPlayer
            puzzle={puzzle}
            scramble={scrambles[safeIndex]}
            className="h-36 w-36"
          />
        </div>

        {/* Text notation */}
        <div className="flex min-w-0 flex-1 flex-col justify-between">
          <div className="rounded-md border border-zinc-100 bg-zinc-50 px-4 py-3 dark:border-zinc-800 dark:bg-zinc-900">
            <p className="font-mono text-sm leading-relaxed text-zinc-800 dark:text-zinc-200" style={{ wordBreak: "break-word" }}>
              {scrambles[safeIndex]}
            </p>
          </div>

          {/* Quick-select pills */}
          {total > 1 && (
            <div className="mt-2 flex gap-1">
              {Array.from({ length: total }, (_, i) => (
                <button
                  key={i}
                  onClick={() => setIndex(i)}
                  className={`rounded px-2 py-0.5 font-mono text-[10px] font-semibold transition ${
                    i === safeIndex
                      ? "bg-zinc-800 text-white dark:bg-zinc-200 dark:text-zinc-900"
                      : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
                  }`}
                >
                  S{i + 1}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ── Sidebar toggle (workspace header) ──────────────────────────────────── */

function SidebarToggle() {
  const { collapsed, toggle } = useSidebar();
  return (
    <button
      onClick={toggle}
      className="hidden rounded-md p-1 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-600 dark:hover:bg-zinc-800 dark:hover:text-zinc-300 md:block"
      title={collapsed ? "Show sidebar" : "Hide sidebar"}
    >
      <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        {collapsed ? (
          /* panel-left-open icon */
          <>
            <rect x="1" y="2" width="14" height="12" rx="1.5" />
            <line x1="5.5" y1="2" x2="5.5" y2="14" />
            <path d="M8.5 6.5L11 8l-2.5 1.5" />
          </>
        ) : (
          /* panel-left-close icon */
          <>
            <rect x="1" y="2" width="14" height="12" rx="1.5" />
            <line x1="5.5" y1="2" x2="5.5" y2="14" />
            <path d="M11 6.5L8.5 8 11 9.5" />
          </>
        )}
      </svg>
    </button>
  );
}

/* ── Stat card ───────────────────────────────────────────────────────────── */

function StatCard({ label, value, small }: { label: string; value: string; small?: boolean }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500">{label}</div>
      <div className={`font-mono font-bold text-zinc-800 dark:text-zinc-200 ${small ? "text-xs" : "text-base"}`}>
        {value}
      </div>
    </div>
  );
}
