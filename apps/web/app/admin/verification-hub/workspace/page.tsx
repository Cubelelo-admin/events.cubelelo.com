"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import Link from "next/link";
import type { Solve } from "@cubers/types";
import { formatTime, formatSolve, ao5, bestSingle } from "@cubers/timer-core";
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
  type VerificationResultDto,
  type JudgeAssignmentDto,
} from "@/lib/api";
import { useAuth } from "@/features/auth/AuthProvider";
import { eventDisplayName } from "@/lib/eventNames";
import { EventIcon } from "@/components/EventIcon";
import { StatusBadge } from "@/components/ui/Badge";
import { Skeleton } from "@/components/Skeleton";
import { useBodyClass } from "@/hooks/useBodyClass";
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
    if (u.hostname.includes("youtube.com")) {
      if (u.searchParams.get("v")) return u.searchParams.get("v");
      // /embed/<id> and /shorts/<id>
      const m = u.pathname.match(/\/(?:embed|shorts)\/([^/?]+)/);
      if (m) return m[1] ?? null;
    }
  } catch { /* not a URL */ }
  return null;
}

/** A Google Drive file id from a share link, if the url is one. */
function extractDriveId(url: string): string | null {
  try {
    const u = new URL(url);
    if (!u.hostname.includes("drive.google.com")) return null;
    // .../file/d/<ID>/view  or  ...?id=<ID>
    const m = u.pathname.match(/\/file\/d\/([^/]+)/);
    if (m) return m[1] ?? null;
    return u.searchParams.get("id");
  } catch { /* not a URL */ }
  return null;
}

/**
 * An embeddable player src for a competitor's video, or null if the host is not
 * one we can embed (the caller then shows an "open in new tab" link). Verifiers
 * need to watch the evidence in place; Drive is as common as YouTube here.
 */
function videoEmbedSrc(url: string): string | null {
  const yt = extractYoutubeId(url);
  if (yt) return `https://www.youtube-nocookie.com/embed/${yt}?rel=0`;
  const drive = extractDriveId(url);
  if (drive) return `https://drive.google.com/file/d/${drive}/preview`;
  return null;
}

/* ── Main Page ───────────────────────────────────────────────────────────── */

export default function VerificationWorkspacePage() {
  const searchParams = useSearchParams();
  const roundId = searchParams.get("roundId") ?? "";
  const compName = searchParams.get("comp") ?? "";
  const { user } = useAuth();
  const isJudgeOnly = user?.role === "judge";

  // Focused mode — hide navbar, footer, sidebar for maximum working space
  useBodyClass("focused-workspace");

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
  const [comment, setComment] = useState("");

  // §8 — Bulk selection (admin/mod only)
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [bulkReason, setBulkReason] = useState("");
  const [undoStack, setUndoStack] = useState<{ id: string; flagStatus: string }[][]>([]);

  // Per-solve penalty overrides (local state, sent on verify)
  const [solveOverrides, setSolveOverrides] = useState<Map<string, (Solve["penalty"] | null)[]>>(new Map());

  const loadData = useCallback(async () => {
    if (!roundId) return;
    setLoading(true);
    setError(null);
    try {
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
  }, [roundId, isJudgeOnly]);

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
    setSelectedIds(new Set());
  }, [activeTab, tabResults.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const selected = results.find((r) => r.id === selectedId) ?? null;

  // Get solves with local overrides applied
  const getOverriddenSolves = useCallback((result: VerificationResultDto): Solve[] => {
    // Local edits win; otherwise fall back to penalties a judge already applied
    // (stored in judgeOverrides, since the raw solves are never rewritten) so a
    // verified result shows its +2/DNF instead of reverting to raw times.
    const overrides = solveOverrides.get(result.id) ?? result.judgeOverrides ?? undefined;
    if (!overrides) return result.solves;
    return result.solves.map((s, i) => {
      const override = overrides[i];
      if (override === undefined || override === null) return s;
      return { ...s, penalty: override };
    });
  }, [solveOverrides]);

  const toggleSolvePenalty = useCallback((resultId: string, solveIndex: number, penalty: "plus2" | "dnf") => {
    setSolveOverrides((prev) => {
      const next = new Map(prev);
      const result = results.find((r) => r.id === resultId);
      if (!result) return prev;
      // Start from any already-applied penalties so editing one attempt does not
      // wipe the others the judge set on a previous pass.
      const current = next.get(resultId) ?? result.judgeOverrides ?? result.solves.map(() => null);
      const arr = [...current];
      const currentPenalty = arr[solveIndex] ?? result.solves[solveIndex]?.penalty ?? null;
      // Toggle: if already this penalty, remove it; otherwise set it
      arr[solveIndex] = currentPenalty === penalty ? null : penalty;
      next.set(resultId, arr);
      return next;
    });
  }, [results]);

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

    // The per-attempt toggles ARE the verdict. The single Verify button used to
    // always send "verified", but the server only keeps per-attempt penalties for
    // a `plus2`/`dnf` action (overridesForAction) — so a judge who toggled a +2
    // and clicked Verify had it silently discarded and the result verified with
    // raw times. Derive the action from the penalties: a clean verify when none
    // are set, otherwise the penalty verdict that makes the server keep them.
    const penalties = solveOverrides.get(selected.id);
    const hasPenalty = penalties?.some((p) => p === "plus2" || p === "dnf") ?? false;
    const effectiveAction = hasPenalty
      ? (penalties!.some((p) => p === "dnf") ? "dnf" : "plus2")
      : action;

    // The backend requires a stated reason for every destructive verdict, and it
    // is the remark box the verifier already types into.
    const remark = comment.trim();
    const isDestructive = ["plus2", "dnf", "disqualified"].includes(effectiveAction);
    if (isDestructive && !remark) {
      setError("Add a remark — a reason is required to +2, DNF, or disqualify a result.");
      return;
    }

    setBusy(`verify-${selected.id}`);
    setError(null);
    try {
      const verifyFn = isJudgeOnly ? judgeVerifyResult : verifyResult;
      await verifyFn(
        selected.id,
        effectiveAction,
        remark || undefined,
        remark || undefined,
        penalties ?? undefined,
      );
      setComment("");
      // Clear overrides for this result
      setSolveOverrides((prev) => { const n = new Map(prev); n.delete(selected.id); return n; });
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
    <div className="flex h-screen flex-col">
      {error && (
        <div className="bg-red-100 px-5 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
          {error}
          <button onClick={() => setError(null)} className="ml-2 font-bold">×</button>
        </div>
      )}

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
        <ResizableSplitPane
          leftPanel={
            <div className="flex h-full flex-col">
              {/* Compact toolbar — back link, round info, reflag */}
              <div className="flex items-center gap-2 border-b border-zinc-200 bg-white px-3 py-1.5 dark:border-zinc-800 dark:bg-zinc-950">
                <Link
                  href={isJudgeOnly ? "/judge/verifications" : "/admin/verification-hub"}
                  className="text-[11px] text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-300"
                >
                  ← Hub
                </Link>
                {roundInfo && (
                  <>
                    <EventIcon eventId={roundInfo.eventType} size={14} />
                    <span className="text-[11px] font-bold text-zinc-700 dark:text-zinc-300">
                      {eventDisplayName(roundInfo.eventType)} R{roundInfo.roundNumber}
                    </span>
                  </>
                )}
                <span className="font-mono text-[10px] text-zinc-400">{results.length}</span>
                <div className="ml-auto flex items-center gap-1">
                  {!isJudgeOnly && (
                    <button
                      onClick={handleReflag}
                      disabled={busy === "reflag"}
                      className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 hover:bg-amber-50 disabled:opacity-50 dark:text-amber-400 dark:hover:bg-amber-950/30"
                      title="Re-run flag rules on all unverified results"
                    >
                      ⚑
                    </button>
                  )}
                  {!isJudgeOnly && undoStack.length > 0 && (
                    <button
                      onClick={handleUndo}
                      disabled={busy === "undo"}
                      className="rounded px-1.5 py-0.5 text-[10px] font-semibold text-zinc-500 hover:bg-zinc-100 disabled:opacity-50 dark:hover:bg-zinc-800"
                    >
                      ↩
                    </button>
                  )}
                </div>
              </div>

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
                      onClick={() => { setSelectedId(r.id); setComment(""); }}
                    />
                  ))
                )}
              </div>
            </div>
          }
          rightPanel={
            selected ? (
              <ResultDetail
                result={selected}
                scrambles={scrambles}
                isJudgeOnly={isJudgeOnly}
                comment={comment}
                busy={busy}
                onCommentChange={setComment}
                onVerify={handleVerify}
                overriddenSolves={getOverriddenSolves(selected)}
                onTogglePenalty={(idx, pen) => toggleSolvePenalty(selected.id, idx, pen)}
              />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-zinc-400">
                Select a result from the list.
              </div>
            )
          }
        />
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

/* ── Resizable split pane ───────────────────────────────────────────────── */

function ResizableSplitPane({
  leftPanel,
  rightPanel,
}: {
  leftPanel: React.ReactNode;
  rightPanel: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [leftWidth, setLeftWidth] = useState(380);
  const dragging = useRef(false);

  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;

    const onMouseMove = (ev: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const newLeft = ev.clientX - rect.left;
      setLeftWidth(Math.max(240, Math.min(newLeft, rect.width * 0.6)));
    };

    const onMouseUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };

    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";
    document.addEventListener("mousemove", onMouseMove);
    document.addEventListener("mouseup", onMouseUp);
  }, []);

  return (
    <div ref={containerRef} className="flex flex-1 overflow-hidden">
      <div
        className="flex flex-shrink-0 flex-col border-r border-zinc-200 dark:border-zinc-800"
        style={{ width: leftWidth }}
      >
        {leftPanel}
      </div>

      {/* Drag handle */}
      <div
        onMouseDown={onMouseDown}
        className="group flex w-1.5 flex-shrink-0 cursor-col-resize items-center justify-center bg-zinc-100 transition-colors hover:bg-zinc-200 active:bg-blue-200 dark:bg-zinc-800 dark:hover:bg-zinc-700 dark:active:bg-blue-900"
      >
        <div className="h-8 w-0.5 rounded-full bg-zinc-300 transition-colors group-hover:bg-zinc-400 dark:bg-zinc-600 dark:group-hover:bg-zinc-500" />
      </div>

      <div className="flex min-w-0 flex-1 flex-col bg-zinc-50 dark:bg-zinc-900/30">
        {rightPanel}
      </div>
    </div>
  );
}

/* ── Result detail (right panel) ─────────────────────────────────────────── */

function ResultDetail({
  result,
  scrambles,
  isJudgeOnly,
  comment,
  busy,
  onCommentChange,
  onVerify,
  overriddenSolves,
  onTogglePenalty,
}: {
  result: VerificationResultDto;
  scrambles: string[];
  isJudgeOnly: boolean;
  comment: string;
  busy: string | null;
  onCommentChange: (v: string) => void;
  onVerify: (action: string) => void;
  overriddenSolves: Solve[];
  onTogglePenalty: (solveIndex: number, penalty: "plus2" | "dnf") => void;
}) {
  const isBusy = busy === `verify-${result.id}`;
  const isVerified =
    result.flagStatus === "verified" ||
    result.flagStatus === "plus2" ||
    result.flagStatus === "dnf" ||
    result.flagStatus === "disqualified";

  const embedSrc = result.videoUrl ? videoEmbedSrc(result.videoUrl) : null;

  // Recalculated scores based on overridden penalties
  // Use the canonical WCA stats (inspection + manual penalties, centisecond
  // rounding) so this preview matches what the server stores exactly — a local
  // copy that ms-rounded and ignored inspection made every result read as
  // "changed" against its own stored value.
  const recalcAo5 = useMemo(() => ao5(overriddenSolves), [overriddenSolves]);
  const recalcBest = useMemo(() => bestSingle(overriddenSolves), [overriddenSolves]);

  // Check if scores changed from original
  const ao5Changed = recalcAo5 !== result.ao5Ms;
  const bestChanged = recalcBest !== result.bestSingleMs;

  return (
    <div className="flex h-full flex-col">
      {/* ── Compact header ── */}
      <div className="flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-2 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center gap-2">
          <span className="text-sm font-bold text-zinc-800 dark:text-zinc-100">{result.userName}</span>
          <span className="font-mono text-[10px] text-zinc-400">{result.userClId}</span>
          {result.rank && (
            <span className="rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-mono font-bold text-zinc-700 dark:bg-zinc-700 dark:text-zinc-200">
              #{result.rank}
            </span>
          )}
        </div>
        <StatusBadge domain="verification" status={result.flagStatus} />
      </div>

      {/* ── Scrollable content ── */}
      <div className="flex-1 overflow-y-auto">
        {/* 1 + 2. Scramble & Video — side by side */}
        <div className="flex border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          {/* Scramble (left half) */}
          {scrambles.length > 0 && (
            <ScrambleViewer
              scrambles={scrambles}
              solveCount={result.solves.length}
              eventType={result.eventType}
            />
          )}

          {/* Video (right half) */}
          <div className="flex flex-1 flex-col border-l border-zinc-200 px-3 py-3 dark:border-zinc-800">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Video</span>
              {result.videoUrl && (
                <a href={result.videoUrl} target="_blank" rel="noopener noreferrer" className="text-[10px] text-blue-500 hover:underline">
                  Open ↗
                </a>
              )}
            </div>
            <div className="flex-1">
              {result.videoUrl ? (
                embedSrc ? (
                  <div className="h-full min-h-[160px] w-full overflow-hidden rounded-lg bg-black">
                    <iframe
                      src={embedSrc}
                      className="h-full w-full"
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      allowFullScreen
                      title="Solve video"
                    />
                  </div>
                ) : (
                  <div className="flex h-full items-center justify-center">
                    <a href={result.videoUrl} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-blue-100 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-200 dark:bg-blue-900/30 dark:text-blue-400">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                      Open Video
                    </a>
                  </div>
                )
              ) : (
                <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700">
                  <p className="text-[10px] text-zinc-400">No video submitted</p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* 3. Solves + Score — side by side */}
        <div className="flex border-b border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
          {/* Solves — horizontal row */}
          <div className="flex-1 border-r border-zinc-200 px-4 py-3 dark:border-zinc-800">
            <div className="mb-2">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Solves</span>
            </div>
            <div className="flex gap-1.5 overflow-x-auto">
              {overriddenSolves.map((s: Solve, i: number) => (
                <div
                  key={i}
                  className={`flex flex-shrink-0 flex-col items-center rounded-lg border px-2.5 py-1.5 ${
                    s.penalty === "dnf"
                      ? "border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/30"
                      : s.penalty === "plus2"
                        ? "border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/30"
                        : "border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900"
                  }`}
                >
                  <span className="text-[8px] font-semibold text-zinc-400">S{i + 1}</span>
                  <span className={`font-mono text-sm font-medium leading-tight ${
                    s.penalty === "dnf"
                      ? "text-red-600 dark:text-red-400"
                      : s.penalty === "plus2"
                        ? "text-amber-600 dark:text-amber-400"
                        : "text-zinc-800 dark:text-zinc-200"
                  }`}>
                    {formatSolve(s)}
                  </span>
                  <div className="mt-1 flex gap-0.5">
                    <button
                      onClick={() => onTogglePenalty(i, "plus2")}
                      className={`rounded px-1.5 py-0.5 text-[9px] font-bold transition ${
                        s.penalty === "plus2"
                          ? "bg-amber-500 text-white"
                          : "bg-zinc-100 text-zinc-500 hover:bg-amber-100 hover:text-amber-600 dark:bg-zinc-800 dark:text-zinc-400"
                      }`}
                    >
                      +2
                    </button>
                    <button
                      onClick={() => onTogglePenalty(i, "dnf")}
                      className={`rounded px-1.5 py-0.5 text-[9px] font-bold transition ${
                        s.penalty === "dnf"
                          ? "bg-red-500 text-white"
                          : "bg-zinc-100 text-zinc-500 hover:bg-red-100 hover:text-red-600 dark:bg-zinc-800 dark:text-zinc-400"
                      }`}
                    >
                      DNF
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Score column */}
          <div className="w-[360px] flex-shrink-0 px-5 py-3">
            <div className="mb-3">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Score</span>
            </div>
            <div className="flex items-start gap-6">
              <div>
                <span className="text-xs text-zinc-400">ao5</span>
                <div className={`font-mono text-2xl font-bold ${ao5Changed ? "text-amber-600 dark:text-amber-400" : "text-zinc-800 dark:text-zinc-200"}`}>
                  {recalcAo5 !== null ? formatTime(recalcAo5) : "DNF"}
                </div>
                {ao5Changed && result.ao5Ms !== null && (
                  <span className="font-mono text-[10px] text-zinc-400 line-through">{formatTime(result.ao5Ms)}</span>
                )}
              </div>
              <div>
                <span className="text-xs text-zinc-400">Best</span>
                <div className={`font-mono text-2xl font-bold ${bestChanged ? "text-amber-600 dark:text-amber-400" : "text-zinc-800 dark:text-zinc-200"}`}>
                  {recalcBest !== null ? formatTime(recalcBest) : "DNF"}
                </div>
                {bestChanged && result.bestSingleMs !== null && (
                  <span className="font-mono text-[10px] text-zinc-400 line-through">{formatTime(result.bestSingleMs)}</span>
                )}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* ── Pinned bottom: remark + verify ── */}
      <div className="border-t border-zinc-200 bg-white px-4 py-2.5 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={comment}
            onChange={(e) => onCommentChange(e.target.value)}
            placeholder="Add a remark..."
            className="min-w-0 flex-[3] rounded-lg border border-zinc-300 bg-zinc-50 px-3 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
          />
          <button
            onClick={() => onVerify("verified")}
            disabled={isBusy}
            className="flex-shrink-0 rounded-lg bg-emerald-600 px-5 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
          >
            ✓ Verify
          </button>
        </div>
      </div>
    </div>
  );
}

/* ── Scramble viewer — full-width image only ─────────────────────────────── */

function ScrambleViewer({ scrambles, solveCount, eventType }: { scrambles: string[]; solveCount: number; eventType: string }) {
  const [index, setIndex] = useState(0);
  const total = Math.min(scrambles.length, solveCount);

  useEffect(() => { setIndex(0); }, [scrambles]);

  if (total === 0) return null;

  const safeIndex = Math.min(index, total - 1);
  const puzzle = (eventType in EVENTS) ? EVENTS[eventType as EventId].puzzle : "3x3x3";

  return (
    <div className="relative flex w-1/2 flex-col items-center justify-center px-3 py-3">
      {/* Left/Right nav buttons */}
      {total > 1 && (
        <>
          <button
            onClick={() => setIndex((safeIndex - 1 + total) % total)}
            className="absolute left-1 top-1/2 z-10 -translate-y-1/2 rounded-full bg-zinc-200/80 p-1 text-zinc-600 transition hover:bg-zinc-300 dark:bg-zinc-700/80 dark:text-zinc-300 dark:hover:bg-zinc-600"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M8.5 3L4.5 7l4 4" />
            </svg>
          </button>
          <button
            onClick={() => setIndex((safeIndex + 1) % total)}
            className="absolute right-1 top-1/2 z-10 -translate-y-1/2 rounded-full bg-zinc-200/80 p-1 text-zinc-600 transition hover:bg-zinc-300 dark:bg-zinc-700/80 dark:text-zinc-300 dark:hover:bg-zinc-600"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M5.5 3l4 4-4 4" />
            </svg>
          </button>
        </>
      )}

      {/* Scramble image */}
      <div className="flex h-[160px] w-full items-center justify-center">
        <TwistyPlayer
          puzzle={puzzle}
          scramble={scrambles[safeIndex]}
          className="h-[150px] w-[200px]"
        />
      </div>

      {/* S1/S2 label at the bottom */}
      <span className="mt-1 font-mono text-[10px] font-semibold text-zinc-400">
        S{safeIndex + 1}
      </span>
    </div>
  );
}

