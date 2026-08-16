"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  fetchVerificationOverview,
  fetchVerificationHub,
  fetchAvailableJudges,
  assignJudge,
  unassignJudge,
  updateVideoRequired,
  publishRoundResults,
  type HubOverviewComp,
  type VerificationHubDto,
  type HubEvent,
  type HubRound,
  type AvailableJudgeDto,
} from "@/lib/api";
import { eventDisplayName } from "@/lib/eventNames";
import { EventIcon } from "@/components/EventIcon";
import { Skeleton } from "@/components/Skeleton";
import { StatusBadge } from "@/features/admin/StatusBadge";

/* ── Status helpers ──────────────────────────────────────────────────────── */

const VSTATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  complete:      { bg: "bg-emerald-100 dark:bg-emerald-900/30", text: "text-emerald-700 dark:text-emerald-400", label: "Complete" },
  needs_review:  { bg: "bg-amber-100 dark:bg-amber-900/30",    text: "text-amber-700 dark:text-amber-400",    label: "Needs Review" },
  in_progress:   { bg: "bg-blue-100 dark:bg-blue-900/30",      text: "text-blue-700 dark:text-blue-400",      label: "In Progress" },
  empty:         { bg: "bg-zinc-100 dark:bg-zinc-800",          text: "text-zinc-500 dark:text-zinc-400",      label: "No Results" },
};

function VerificationBadge({ status }: { status: string }) {
  const s = VSTATUS_STYLES[status] ?? VSTATUS_STYLES.empty;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${s.bg} ${s.text}`}>
      {s.label}
    </span>
  );
}

/* ── Filters ────────────────────────────────────────────────────────────── */

const STATUS_FILTERS = [
  { label: "All", value: "all" },
  { label: "Live", value: "live" },
  { label: "Results Pending", value: "results_pending" },
  { label: "Completed", value: "completed" },
] as const;

const VERIFICATION_FILTERS = [
  { label: "All", value: "all" },
  { label: "Needs Review", value: "needs_review" },
  { label: "In Progress", value: "in_progress" },
  { label: "Complete", value: "complete" },
] as const;

/* ── Main Page ───────────────────────────────────────────────────────────── */

export default function VerificationHubPage() {
  const [comps, setComps] = useState<HubOverviewComp[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Filters
  const [statusFilter, setStatusFilter] = useState("all");
  const [vFilter, setVFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [dateRange, setDateRange] = useState("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [page, setPage] = useState(1);

  // Expanded competition
  const [expandedCompId, setExpandedCompId] = useState<string | null>(null);
  const [hubData, setHubData] = useState<VerificationHubDto | null>(null);
  const [hubLoading, setHubLoading] = useState(false);

  // Judge assignment
  const [assigningRoundId, setAssigningRoundId] = useState<string | null>(null);
  const [availableJudges, setAvailableJudges] = useState<AvailableJudgeDto[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  /** Outcome of the last publish, so the organiser sees what it did. */
  const [published, setPublished] = useState<string | null>(null);

  const PER_PAGE = 10;

  const loadOverview = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchVerificationOverview()
      .then((d) => setComps(d.competitions))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { loadOverview(); }, [loadOverview]);

  const loadHub = useCallback(async (compId: string) => {
    setHubLoading(true);
    try {
      const data = await fetchVerificationHub(compId);
      setHubData(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setHubLoading(false);
    }
  }, []);

  const toggleExpand = (compId: string) => {
    if (expandedCompId === compId) {
      setExpandedCompId(null);
      setHubData(null);
      setAssigningRoundId(null);
    } else {
      setExpandedCompId(compId);
      setHubData(null);
      setAssigningRoundId(null);
      loadHub(compId);
    }
  };

  // Filtering
  const filtered = comps.filter((c) => {
    if (statusFilter !== "all" && c.status !== statusFilter) return false;
    if (vFilter !== "all" && c.verificationStatus !== vFilter) return false;
    if (search.trim()) {
      const q = search.toLowerCase();
      if (!c.title.toLowerCase().includes(q)) return false;
    }
    // Date range filter (based on startsAt)
    if (dateRange !== "all" && c.startsAt) {
      const starts = new Date(c.startsAt).getTime();
      const now = Date.now();
      if (dateRange === "this_month") {
        const d = new Date();
        const monthStart = new Date(d.getFullYear(), d.getMonth(), 1).getTime();
        if (starts < monthStart) return false;
      } else if (dateRange === "last_1_month") {
        if (starts < now - 30 * 86_400_000) return false;
      } else if (dateRange === "last_6_months") {
        if (starts < now - 180 * 86_400_000) return false;
      } else if (dateRange === "this_year") {
        const yearStart = new Date(new Date().getFullYear(), 0, 1).getTime();
        if (starts < yearStart) return false;
      } else if (dateRange === "last_1_year") {
        if (starts < now - 365 * 86_400_000) return false;
      } else if (dateRange === "custom") {
        const from = customFrom ? new Date(customFrom).getTime() : 0;
        const to = customTo ? new Date(customTo).getTime() + 86_400_000 : Infinity;
        if (starts < from || starts > to) return false;
      }
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(filtered.length / PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const paginated = filtered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);

  // Aggregate stats
  const totalResults = comps.reduce((s, c) => s + c.stats.total, 0);
  const totalVerified = comps.reduce((s, c) => s + c.stats.verified, 0);
  const totalFlagged = comps.reduce((s, c) => s + c.stats.flagged, 0);
  const totalPending = comps.reduce((s, c) => s + c.stats.clean, 0);

  // Judge actions
  const openAssignPanel = async (roundId: string) => {
    if (availableJudges.length === 0) {
      try {
        const j = await fetchAvailableJudges();
        setAvailableJudges(j);
      } catch { /* ignore */ }
    }
    setAssigningRoundId(assigningRoundId === roundId ? null : roundId);
  };

  const handleAssign = async (judgeId: string, roundId: string) => {
    if (!expandedCompId) return;
    setBusy(`assign-${roundId}`);
    try {
      await assignJudge(judgeId, roundId);
      await loadHub(expandedCompId);
      loadOverview(); // refresh stats
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleUnassign = async (assignmentRoundId: string, judgeId: string) => {
    if (!expandedCompId) return;
    setBusy(`unassign-${judgeId}`);
    try {
      const res = await fetch(`/api/v1/admin/verification/rounds/${assignmentRoundId}/judges`, {
        headers: { Authorization: `Bearer ${localStorage.getItem("token") ?? ""}` },
      });
      if (res.ok) {
        const judges = await res.json();
        const match = judges.find((j: { judgeId: string; id: string }) => j.judgeId === judgeId);
        if (match) {
          await unassignJudge(match.id);
          await loadHub(expandedCompId);
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleToggleVideo = async (roundId: string, current: boolean) => {
    if (!expandedCompId) return;
    setBusy(`video-${roundId}`);
    try {
      await updateVideoRequired(roundId, !current);
      await loadHub(expandedCompId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Publishing finalises the round: the standings freeze, the shortlist is
   * computed from them, and the shortlisted competitors are the ones admitted
   * to the next round. It cannot be undone, so it asks first.
   */
  const handlePublish = async (round: HubRound) => {
    if (!expandedCompId) return;
    const ok = window.confirm(
      `Publish Round ${round.roundNumber}?

` +
        `The results become final, the shortlist for the next round is computed ` +
        `from them, and every competitor is emailed. This cannot be undone.`,
    );
    if (!ok) return;

    setBusy(`publish-${round.id}`);
    setError(null);
    try {
      const res = await publishRoundResults(round.id);
      setPublished(
        `Round ${res.roundNumber} published — ${res.advancedCount} advanced` +
          (res.competitionCompleted ? ", competition complete" : "") +
          `. ${res.sentCount}/${res.recipientCount} emails sent.`,
      );
      await loadHub(expandedCompId);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto max-w-[1400px] px-8 py-10">
      <h1 className="mb-1 text-xl font-bold text-zinc-900 dark:text-zinc-100">
        Verification Hub
      </h1>
      <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
        Review verification progress across all competitions. Expand a row to see rounds, assign judges, and open workspaces.
      </p>

      {error && (
        <div className="mb-4 rounded-lg bg-red-100 px-4 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
          {error}
          <button onClick={() => setError(null)} className="ml-2 font-bold">×</button>
        </div>
      )}

      {published && (
        <div className="mb-4 rounded-lg bg-emerald-100 px-4 py-2 text-sm text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300">
          {published}
          <button onClick={() => setPublished(null)} className="ml-2 font-bold">×</button>
        </div>
      )}

      {/* Aggregate stats */}
      {!loading && comps.length > 0 && (
        <div className="mb-6 flex flex-wrap gap-3">
          <AggStat label="Competitions" value={comps.length} />
          <AggStat label="Total Results" value={totalResults} />
          <AggStat label="Verified" value={totalVerified} color="text-emerald-600 dark:text-emerald-400" />
          <AggStat label="Flagged" value={totalFlagged} color="text-amber-600 dark:text-amber-400" />
          <AggStat label="Pending" value={totalPending} color="text-blue-600 dark:text-blue-400" />
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      ) : (
        <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900/30">
          {/* Status filters */}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            <span className="mr-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Status</span>
            {STATUS_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => { setStatusFilter(f.value); setPage(1); }}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  statusFilter === f.value
                    ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100"
                    : "text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-300"
                }`}
              >
                {f.label}
              </button>
            ))}
            <div className="mx-2 h-4 w-px bg-zinc-200 dark:bg-zinc-700" />
            <span className="mr-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Verification</span>
            {VERIFICATION_FILTERS.map((f) => (
              <button
                key={f.value}
                onClick={() => { setVFilter(f.value); setPage(1); }}
                className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
                  vFilter === f.value
                    ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100"
                    : "text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-300"
                }`}
              >
                {f.label}
              </button>
            ))}
          </div>

          {/* Search + Date range */}
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <input
              type="text"
              placeholder="Search competitions..."
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
              className="w-64 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:placeholder:text-zinc-600"
            />
            <select
              value={dateRange}
              onChange={(e) => { setDateRange(e.target.value); setPage(1); }}
              className="rounded-lg border border-zinc-300 bg-white px-2.5 py-1.5 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
            >
              <option value="all">All time</option>
              <option value="this_month">This month</option>
              <option value="last_1_month">Last 1 month</option>
              <option value="last_6_months">Last 6 months</option>
              <option value="this_year">This year</option>
              <option value="last_1_year">Last 1 year</option>
              <option value="custom">Custom range</option>
            </select>
            {dateRange === "custom" && (
              <>
                <input
                  type="date"
                  value={customFrom}
                  onChange={(e) => { setCustomFrom(e.target.value); setPage(1); }}
                  className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                />
                <span className="text-xs text-zinc-500">to</span>
                <input
                  type="date"
                  value={customTo}
                  onChange={(e) => { setCustomTo(e.target.value); setPage(1); }}
                  className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-xs text-zinc-700 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300"
                />
              </>
            )}
            <span className="ml-auto text-xs text-zinc-500">
              {filtered.length} competition{filtered.length !== 1 ? "s" : ""}
            </span>
          </div>

          {/* Competition table */}
          <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
            <table className="w-full text-sm">
              <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wider text-zinc-500 dark:bg-zinc-900/60">
                <tr>
                  <th className="px-4 py-2 w-8"></th>
                  <th className="px-4 py-2">Title</th>
                  <th className="px-4 py-2">Status</th>
                  <th className="px-4 py-2">Verification</th>
                  <th className="px-4 py-2">Progress</th>
                  <th className="px-4 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {paginated.map((c) => (
                  <CompetitionRow
                    key={c.id}
                    comp={c}
                    isExpanded={expandedCompId === c.id}
                    onToggle={() => toggleExpand(c.id)}
                    hubData={expandedCompId === c.id ? hubData : null}
                    hubLoading={expandedCompId === c.id && hubLoading}
                    assigningRoundId={assigningRoundId}
                    availableJudges={availableJudges}
                    busy={busy}
                    onOpenAssign={openAssignPanel}
                    onAssign={handleAssign}
                    onUnassign={handleUnassign}
                    onToggleVideo={handleToggleVideo}
                    onPublish={handlePublish}
                  />
                ))}
                {paginated.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-zinc-500">
                      No competitions found.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="mt-3 flex items-center justify-between">
              <span className="text-xs text-zinc-500">
                {(safePage - 1) * PER_PAGE + 1}–{Math.min(safePage * PER_PAGE, filtered.length)} of {filtered.length}
              </span>
              <div className="flex items-center gap-1">
                <button
                  disabled={safePage <= 1}
                  onClick={() => setPage(safePage - 1)}
                  className="rounded px-2 py-1 text-xs text-zinc-500 transition hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800"
                >
                  «
                </button>
                {Array.from({ length: totalPages }, (_, i) => i + 1)
                  .filter((p) => p === 1 || p === totalPages || Math.abs(p - safePage) <= 2)
                  .reduce<(number | "...")[]>((acc, p, i, arr) => {
                    if (i > 0 && p - (arr[i - 1] as number) > 1) acc.push("...");
                    acc.push(p);
                    return acc;
                  }, [])
                  .map((p, i) =>
                    p === "..." ? (
                      <span key={`dot-${i}`} className="px-1 text-xs text-zinc-500">…</span>
                    ) : (
                      <button
                        key={p}
                        onClick={() => setPage(p as number)}
                        className={`rounded px-2.5 py-1 text-xs font-medium transition ${
                          p === safePage
                            ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-700 dark:text-zinc-100"
                            : "text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-800"
                        }`}
                      >
                        {p}
                      </button>
                    ),
                  )}
                <button
                  disabled={safePage >= totalPages}
                  onClick={() => setPage(safePage + 1)}
                  className="rounded px-2 py-1 text-xs text-zinc-500 transition hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800"
                >
                  »
                </button>
              </div>
            </div>
          )}
        </section>
      )}
    </div>
  );
}

/* ── Aggregate stat chip ─────────────────────────────────────────────────── */

function AggStat({ label, value, color }: { label: string; value: number; color?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-2 text-center dark:border-zinc-800 dark:bg-zinc-900/40">
      <div className="text-[10px] uppercase tracking-wider text-zinc-500 dark:text-zinc-400">{label}</div>
      <div className={`font-mono text-lg font-bold ${color ?? "text-zinc-800 dark:text-zinc-200"}`}>{value}</div>
    </div>
  );
}

/* ── Competition Row (with expandable detail) ────────────────────────────── */

function CompetitionRow({
  comp,
  isExpanded,
  onToggle,
  hubData,
  hubLoading,
  assigningRoundId,
  availableJudges,
  busy,
  onOpenAssign,
  onAssign,
  onUnassign,
  onToggleVideo,
  onPublish,
}: {
  comp: HubOverviewComp;
  isExpanded: boolean;
  onToggle: () => void;
  hubData: VerificationHubDto | null;
  hubLoading: boolean;
  assigningRoundId: string | null;
  availableJudges: AvailableJudgeDto[];
  busy: string | null;
  onOpenAssign: (roundId: string) => void;
  onAssign: (judgeId: string, roundId: string) => void;
  onUnassign: (roundId: string, judgeId: string) => void;
  onToggleVideo: (roundId: string, current: boolean) => void;
  onPublish: (round: HubRound) => void;
}) {
  const { stats } = comp;
  const pct = stats.total > 0 ? Math.round((stats.verified / stats.total) * 100) : 0;

  return (
    <>
      {/* Main row */}
      <tr
        onClick={onToggle}
        className={`cursor-pointer border-t border-zinc-100 transition dark:border-zinc-800 ${
          isExpanded
            ? "bg-zinc-50 dark:bg-zinc-900/60"
            : "hover:bg-zinc-50 dark:hover:bg-zinc-900/40"
        }`}
      >
        {/* Expand arrow */}
        <td className="px-4 py-2.5 text-zinc-400">
          <svg
            width="12"
            height="12"
            viewBox="0 0 12 12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={`transition-transform ${isExpanded ? "rotate-90" : ""}`}
          >
            <path d="M4 2l4 4-4 4" />
          </svg>
        </td>

        {/* Title */}
        <td className="px-4 py-2.5">
          <div className="font-medium text-zinc-800 dark:text-zinc-200">{comp.title}</div>
          <div className="text-[11px] text-zinc-400">
            {comp.roundCount} round{comp.roundCount !== 1 ? "s" : ""} · {comp.registrationCount} participant{comp.registrationCount !== 1 ? "s" : ""}
          </div>
        </td>

        {/* Comp status */}
        <td className="px-4 py-2.5">
          <StatusBadge status={comp.status} />
        </td>

        {/* Verification status */}
        <td className="px-4 py-2.5">
          <VerificationBadge status={comp.verificationStatus} />
        </td>

        {/* Progress */}
        <td className="px-4 py-2.5">
          {stats.total > 0 ? (
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="font-mono text-[11px] text-zinc-500">{stats.verified}/{stats.total}</span>
              {stats.flagged > 0 && (
                <span className="font-mono text-[11px] text-amber-500">⚑ {stats.flagged}</span>
              )}
            </div>
          ) : (
            <span className="text-xs text-zinc-400">—</span>
          )}
        </td>

        {/* Actions */}
        <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
          <Link
            href={`/competitions/${comp.id}`}
            className="text-xs text-zinc-400 hover:text-zinc-600 hover:underline dark:hover:text-zinc-300"
            target="_blank"
          >
            View ↗
          </Link>
        </td>
      </tr>

      {/* Expanded detail */}
      {isExpanded && (
        <tr>
          <td colSpan={6} className="border-t border-zinc-100 bg-zinc-50/50 p-0 dark:border-zinc-800 dark:bg-zinc-900/20">
            {hubLoading ? (
              <div className="p-5">
                <Skeleton className="h-32 w-full rounded-lg" />
              </div>
            ) : hubData ? (
              <div className="p-5 space-y-4">
                {hubData.events.length === 0 ? (
                  <p className="text-center text-sm text-zinc-500">No events configured.</p>
                ) : (
                  hubData.events.map((ev) => (
                    <EventSection
                      key={ev.competitionEventId}
                      event={ev}
                      compTitle={comp.title}
                      assigningRoundId={assigningRoundId}
                      availableJudges={availableJudges}
                      busy={busy}
                      onOpenAssign={onOpenAssign}
                      onAssign={onAssign}
                      onUnassign={onUnassign}
                      onToggleVideo={onToggleVideo}
                      onPublish={onPublish}
                    />
                  ))
                )}
              </div>
            ) : null}
          </td>
        </tr>
      )}
    </>
  );
}

/* ── Event section (inside expanded row) ─────────────────────────────────── */

function EventSection({
  event,
  compTitle,
  assigningRoundId,
  availableJudges,
  busy,
  onOpenAssign,
  onAssign,
  onUnassign,
  onToggleVideo,
  onPublish,
}: {
  event: HubEvent;
  compTitle: string;
  assigningRoundId: string | null;
  availableJudges: AvailableJudgeDto[];
  busy: string | null;
  onOpenAssign: (roundId: string) => void;
  onAssign: (judgeId: string, roundId: string) => void;
  onUnassign: (roundId: string, judgeId: string) => void;
  onToggleVideo: (roundId: string, current: boolean) => void;
  onPublish: (round: HubRound) => void;
}) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center gap-3 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <EventIcon eventId={event.eventType} size={20} />
        <h2 className="text-sm font-bold text-zinc-800 dark:text-zinc-200">
          {eventDisplayName(event.eventType)}
        </h2>
        <span className="text-xs text-zinc-400">
          {event.rounds.length} round{event.rounds.length !== 1 ? "s" : ""}
        </span>
      </div>

      <div className="divide-y divide-zinc-100 dark:divide-zinc-800/50">
        {event.rounds.map((round) => (
          <RoundRow
            key={round.id}
            round={round}
            compTitle={compTitle}
            isAssigning={assigningRoundId === round.id}
            availableJudges={availableJudges}
            busy={busy}
            onOpenAssign={() => onOpenAssign(round.id)}
            onAssign={(judgeId) => onAssign(judgeId, round.id)}
            onUnassign={(judgeId) => onUnassign(round.id, judgeId)}
            onToggleVideo={() => onToggleVideo(round.id, round.videoRequired)}
            onPublish={() => onPublish(round)}
          />
        ))}
      </div>
    </div>
  );
}

/* ── Round row ───────────────────────────────────────────────────────────── */

function RoundRow({
  round,
  compTitle,
  isAssigning,
  availableJudges,
  busy,
  onOpenAssign,
  onAssign,
  onUnassign,
  onToggleVideo,
  onPublish,
}: {
  round: HubRound;
  compTitle: string;
  isAssigning: boolean;
  availableJudges: AvailableJudgeDto[];
  busy: string | null;
  onOpenAssign: () => void;
  onAssign: (judgeId: string) => void;
  onUnassign: (judgeId: string) => void;
  onToggleVideo: () => void;
  onPublish: () => void;
}) {
  const { stats } = round;
  const pctVerified = stats.total > 0 ? Math.round((stats.verified / stats.total) * 100) : 0;
  const assignedJudgeIds = new Set(round.judges.map((j) => j.judgeId));

  // Mirrors the server's guards, so the button is only offered when it works.
  const publishBlockedReason =
    round.status !== "closed"
      ? "Round is still running"
      : stats.total === 0
        ? "No results to publish"
        : stats.flagged > 0
          ? `${stats.flagged} result${stats.flagged === 1 ? "" : "s"} still flagged`
          : null;
  const publishable = publishBlockedReason === null;

  return (
    <div className="px-5 py-4">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2.5 min-w-[140px]">
          <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
            Round {round.roundNumber}
          </span>
          <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
            {round.status}
          </span>
          <VerificationBadge status={round.verificationStatus} />
        </div>

        <div className="flex items-center gap-3 text-xs">
          <span className="font-mono text-zinc-600 dark:text-zinc-300">
            {stats.total} results
          </span>
          {stats.total > 0 && (
            <>
              <span className="font-mono text-emerald-600 dark:text-emerald-400">✓ {stats.verified}</span>
              <span className="font-mono text-amber-600 dark:text-amber-400">⚑ {stats.flagged}</span>
              <span className="font-mono text-zinc-400">○ {stats.clean}</span>
            </>
          )}
        </div>

        {stats.total > 0 && (
          <div className="flex items-center gap-2">
            <div className="h-1.5 w-24 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
              <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pctVerified}%` }} />
            </div>
            <span className="text-[11px] font-mono text-zinc-500">{pctVerified}%</span>
          </div>
        )}

        <button
          onClick={onToggleVideo}
          disabled={busy === `video-${round.id}`}
          className={`ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-medium transition ${
            round.videoRequired
              ? "bg-violet-100 text-violet-700 hover:bg-violet-200 dark:bg-violet-900/30 dark:text-violet-400"
              : "bg-zinc-100 text-zinc-400 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-500"
          }`}
        >
          📹 {round.videoRequired ? "Video Required" : "No Video"}
        </button>

        <div className="flex items-center gap-2">
          <button
            onClick={onOpenAssign}
            className="rounded-md bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-600 hover:bg-blue-100 dark:bg-blue-900/20 dark:text-blue-400 dark:hover:bg-blue-900/40"
          >
            {isAssigning ? "Close" : `Judges (${round.judges.length})`}
          </button>
          <Link
            href={`/admin/verification-hub/workspace?roundId=${round.id}&comp=${encodeURIComponent(compTitle)}`}
            className="rounded-md bg-emerald-50 px-2.5 py-1 text-[11px] font-semibold text-emerald-600 hover:bg-emerald-100 dark:bg-emerald-900/20 dark:text-emerald-400 dark:hover:bg-emerald-900/40"
          >
            Open Workspace →
          </Link>
        </div>
      </div>

      {/* Assigned judges */}
      {round.judges.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-2">
          {round.judges.map((j) => (
            <span
              key={j.judgeId}
              className="inline-flex items-center gap-1.5 rounded-full bg-zinc-100 px-2.5 py-1 text-[11px] dark:bg-zinc-800"
            >
              <span className="font-medium text-zinc-700 dark:text-zinc-300">{j.judgeName}</span>
              <span className="text-zinc-400">{j.judgeClId}</span>
              <button
                onClick={() => onUnassign(j.judgeId)}
                disabled={busy === `unassign-${j.judgeId}`}
                className="ml-0.5 text-zinc-400 hover:text-red-500"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {/* Judge assignment panel */}
      {isAssigning && (
        <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50/50 p-3 dark:border-blue-900 dark:bg-blue-950/30">
          <h4 className="mb-2 text-xs font-semibold uppercase tracking-wider text-blue-600 dark:text-blue-400">
            Assign Judge
          </h4>
          {availableJudges.length === 0 ? (
            <p className="text-xs text-zinc-500">No judges available.</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              {availableJudges
                .filter((j) => !assignedJudgeIds.has(j.id))
                .map((j) => (
                  <button
                    key={j.id}
                    onClick={() => onAssign(j.id)}
                    disabled={busy === `assign-${round.id}`}
                    className="flex items-center gap-1.5 rounded-md border border-zinc-200 bg-white px-3 py-1.5 text-xs hover:border-blue-400 hover:bg-blue-50 dark:border-zinc-700 dark:bg-zinc-900 dark:hover:border-blue-600 dark:hover:bg-blue-950/40"
                  >
                    <span className="font-medium text-zinc-800 dark:text-zinc-200">{j.name}</span>
                    <span className="text-[10px] uppercase text-zinc-400">{j.role}</span>
                  </button>
                ))}
              {availableJudges.filter((j) => !assignedJudgeIds.has(j.id)).length === 0 && (
                <p className="text-xs text-zinc-500">All judges already assigned.</p>
              )}
            </div>
          )}
        </div>
      )}

      {round.resultsPublishedAt ? (
        <div className="mt-2 inline-flex items-center gap-1 rounded-full bg-emerald-100 px-2.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><path d="M5 13l4 4L19 7" /></svg>
          Published {new Date(round.resultsPublishedAt).toLocaleDateString()}
        </div>
      ) : (
        // Publishing is what advances competitors, so the reason it is
        // unavailable has to be visible rather than a dead button.
        <div className="mt-2 flex items-center gap-2">
          <button
            type="button"
            disabled={!publishable || busy === `publish-${round.id}`}
            onClick={onPublish}
            className="rounded bg-emerald-700 px-3 py-1 text-xs font-semibold text-white transition hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy === `publish-${round.id}` ? "Publishing…" : "Publish Results"}
          </button>
          {!publishable && (
            <span className="text-[11px] text-zinc-500">{publishBlockedReason}</span>
          )}
        </div>
      )}
    </div>
  );
}
