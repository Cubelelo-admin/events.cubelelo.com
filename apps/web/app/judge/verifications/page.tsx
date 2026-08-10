"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  fetchJudgeAssignments,
  type JudgeRoundDto,
} from "@/lib/api";
import { eventDisplayName } from "@/lib/eventNames";
import { EventIcon } from "@/components/EventIcon";
import { EmptyState } from "@/components/EmptyState";
import { Skeleton } from "@/components/Skeleton";

/* ── Status helpers ──────────────────────────────────────────────────────── */

const VSTATUS_STYLES: Record<string, { bg: string; text: string; label: string }> = {
  complete:     { bg: "bg-emerald-100 dark:bg-emerald-900/30", text: "text-emerald-700 dark:text-emerald-400", label: "Complete" },
  needs_review: { bg: "bg-amber-100 dark:bg-amber-900/30",    text: "text-amber-700 dark:text-amber-400",    label: "Needs Review" },
  in_progress:  { bg: "bg-blue-100 dark:bg-blue-900/30",      text: "text-blue-700 dark:text-blue-400",      label: "In Progress" },
  not_started:  { bg: "bg-zinc-100 dark:bg-zinc-800",          text: "text-zinc-500 dark:text-zinc-400",      label: "Not Started" },
};

function VerificationBadge({ status }: { status: string }) {
  const s = VSTATUS_STYLES[status] ?? VSTATUS_STYLES.not_started;
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${s.bg} ${s.text}`}>
      {s.label}
    </span>
  );
}

/* ── Grouped assignment type ─────────────────────────────────────────────── */

interface CompGroup {
  competitionId: string;
  competitionTitle: string;
  rounds: JudgeRoundDto[];
  totalResults: number;
  verifiedCount: number;
}

function groupByCompetition(assignments: JudgeRoundDto[]): CompGroup[] {
  const map = new Map<string, CompGroup>();
  for (const a of assignments) {
    const key = a.competitionId ?? a.competitionTitle;
    let group = map.get(key);
    if (!group) {
      group = {
        competitionId: key,
        competitionTitle: a.competitionTitle,
        rounds: [],
        totalResults: 0,
        verifiedCount: 0,
      };
      map.set(key, group);
    }
    group.rounds.push(a);
    group.totalResults += a.totalResults;
    group.verifiedCount += a.verifiedCount;
  }
  return [...map.values()];
}

function getVerificationStatus(total: number, verified: number): string {
  if (total === 0) return "not_started";
  if (verified === total) return "complete";
  if (verified > 0) return "in_progress";
  return "needs_review";
}

/* ── Filters ─────────────────────────────────────────────────────────────── */

const VERIFICATION_FILTERS = [
  { label: "All", value: "all" },
  { label: "Needs Review", value: "needs_review" },
  { label: "In Progress", value: "in_progress" },
  { label: "Complete", value: "complete" },
] as const;

/* ── Main Page ───────────────────────────────────────────────────────────── */

export default function JudgeVerificationsPage() {
  const [assignments, setAssignments] = useState<JudgeRoundDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [vFilter, setVFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [expandedCompId, setExpandedCompId] = useState<string | null>(null);

  useEffect(() => {
    fetchJudgeAssignments()
      .then(setAssignments)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  const groups = groupByCompetition(assignments);

  const filtered = groups.filter((g) => {
    if (vFilter !== "all") {
      const status = getVerificationStatus(g.totalResults, g.verifiedCount);
      if (status !== vFilter) return false;
    }
    if (search.trim()) {
      const q = search.toLowerCase();
      if (!g.competitionTitle.toLowerCase().includes(q)) return false;
    }
    return true;
  });

  // Aggregate stats
  const totalRounds = assignments.length;
  const totalResults = assignments.reduce((s, a) => s + a.totalResults, 0);
  const totalVerified = assignments.reduce((s, a) => s + a.verifiedCount, 0);
  const totalPending = totalResults - totalVerified;

  return (
    <div className="mx-auto max-w-[1200px] px-6 py-8">
      <h1 className="mb-1 text-xl font-bold text-zinc-900 dark:text-zinc-100">
        My Verifications
      </h1>
      <p className="mb-6 text-sm text-zinc-500 dark:text-zinc-400">
        Rounds assigned to you for verification. Expand a competition to see rounds, then open the workspace to review results.
      </p>

      {error && (
        <div className="mb-4 rounded-lg bg-red-100 px-4 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">
          {error}
          <button onClick={() => setError(null)} className="ml-2 font-bold">×</button>
        </div>
      )}

      {loading ? (
        <div className="space-y-3">
          <Skeleton className="h-10 w-full rounded-lg" />
          <Skeleton className="h-64 w-full rounded-xl" />
        </div>
      ) : assignments.length === 0 ? (
        <EmptyState
          icon="🧑‍⚖️"
          title="No rounds assigned yet"
          description="Check back once an admin assigns you to a round for verification."
        />
      ) : (
        <>
          {/* Aggregate stats */}
          <div className="mb-6 flex flex-wrap gap-3">
            <AggStat label="Assigned Rounds" value={totalRounds} />
            <AggStat label="Total Results" value={totalResults} />
            <AggStat label="Verified" value={totalVerified} color="text-emerald-600 dark:text-emerald-400" />
            <AggStat label="Pending" value={totalPending} color="text-blue-600 dark:text-blue-400" />
          </div>

          <section className="rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900/30">
            {/* Verification filters */}
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="mr-1 text-[10px] font-semibold uppercase tracking-wider text-zinc-400">Verification</span>
              {VERIFICATION_FILTERS.map((f) => (
                <button
                  key={f.value}
                  onClick={() => setVFilter(f.value)}
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

            {/* Search */}
            <div className="mb-4 flex items-center gap-3">
              <input
                type="text"
                placeholder="Search competitions..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                className="w-64 rounded-lg border border-zinc-300 bg-white px-3 py-1.5 text-sm text-zinc-700 placeholder:text-zinc-400 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-300 dark:placeholder:text-zinc-600"
              />
              <span className="ml-auto text-xs text-zinc-500">
                {filtered.length} competition{filtered.length !== 1 ? "s" : ""}
              </span>
            </div>

            {/* Competition table */}
            <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
              <table className="w-full text-sm">
                <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wider text-zinc-500 dark:bg-zinc-900/60">
                  <tr>
                    <th className="w-8 px-4 py-2"></th>
                    <th className="px-4 py-2">Competition</th>
                    <th className="px-4 py-2">Assigned Rounds</th>
                    <th className="px-4 py-2">Status</th>
                    <th className="px-4 py-2">Progress</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((g) => {
                    const isExpanded = expandedCompId === g.competitionId;
                    const status = getVerificationStatus(g.totalResults, g.verifiedCount);
                    const pct = g.totalResults > 0 ? Math.round((g.verifiedCount / g.totalResults) * 100) : 0;

                    return (
                      <CompetitionGroup
                        key={g.competitionId}
                        group={g}
                        isExpanded={isExpanded}
                        status={status}
                        pct={pct}
                        onToggle={() => setExpandedCompId(isExpanded ? null : g.competitionId)}
                      />
                    );
                  })}
                  {filtered.length === 0 && (
                    <tr>
                      <td colSpan={5} className="px-4 py-8 text-center text-zinc-500">
                        No competitions match the current filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </>
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

/* ── Competition group row ───────────────────────────────────────────────── */

function CompetitionGroup({
  group,
  isExpanded,
  status,
  pct,
  onToggle,
}: {
  group: CompGroup;
  isExpanded: boolean;
  status: string;
  pct: number;
  onToggle: () => void;
}) {
  return (
    <>
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
            width="12" height="12" viewBox="0 0 12 12" fill="none"
            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"
            className={`transition-transform ${isExpanded ? "rotate-90" : ""}`}
          >
            <path d="M4 2l4 4-4 4" />
          </svg>
        </td>

        {/* Title */}
        <td className="px-4 py-2.5">
          <div className="font-medium text-zinc-800 dark:text-zinc-200">{group.competitionTitle}</div>
        </td>

        {/* Round count */}
        <td className="px-4 py-2.5">
          <span className="font-mono text-xs text-zinc-500">
            {group.rounds.length} round{group.rounds.length !== 1 ? "s" : ""}
          </span>
        </td>

        {/* Verification status */}
        <td className="px-4 py-2.5">
          <VerificationBadge status={status} />
        </td>

        {/* Progress */}
        <td className="px-4 py-2.5">
          {group.totalResults > 0 ? (
            <div className="flex items-center gap-2">
              <div className="h-1.5 w-24 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
                <div
                  className="h-full rounded-full bg-emerald-500 transition-all"
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span className="font-mono text-[11px] text-zinc-500">{group.verifiedCount}/{group.totalResults}</span>
            </div>
          ) : (
            <span className="text-xs text-zinc-400">—</span>
          )}
        </td>
      </tr>

      {/* Expanded: show individual rounds */}
      {isExpanded && (
        <tr>
          <td colSpan={5} className="border-t border-zinc-100 bg-zinc-50/50 p-0 dark:border-zinc-800 dark:bg-zinc-900/20">
            <div className="divide-y divide-zinc-100 dark:divide-zinc-800/50">
              {group.rounds.map((round) => (
                <RoundRow key={round.id} round={round} />
              ))}
            </div>
          </td>
        </tr>
      )}
    </>
  );
}

/* ── Round row (inside expanded competition) ─────────────────────────────── */

function RoundRow({ round }: { round: JudgeRoundDto }) {
  const pct = round.totalResults > 0
    ? Math.round((round.verifiedCount / round.totalResults) * 100)
    : 0;
  const status = getVerificationStatus(round.totalResults, round.verifiedCount);

  return (
    <div className="flex flex-wrap items-center gap-4 px-8 py-3.5">
      <div className="flex items-center gap-2.5 min-w-[180px]">
        <EventIcon eventId={round.eventType} size={18} />
        <span className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
          {eventDisplayName(round.eventType)} — Round {round.roundNumber}
        </span>
      </div>

      <span className="rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] uppercase text-zinc-500 dark:bg-zinc-800 dark:text-zinc-400">
        {round.roundStatus}
      </span>

      <VerificationBadge status={status} />

      <div className="flex items-center gap-3 text-xs">
        <span className="font-mono text-zinc-600 dark:text-zinc-300">
          {round.totalResults} results
        </span>
        {round.totalResults > 0 && (
          <>
            <span className="font-mono text-emerald-600 dark:text-emerald-400">✓ {round.verifiedCount}</span>
            <span className="font-mono text-zinc-400">○ {round.totalResults - round.verifiedCount}</span>
          </>
        )}
      </div>

      {round.totalResults > 0 && (
        <div className="flex items-center gap-2">
          <div className="h-1.5 w-24 overflow-hidden rounded-full bg-zinc-200 dark:bg-zinc-700">
            <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${pct}%` }} />
          </div>
          <span className="font-mono text-[11px] text-zinc-500">{pct}%</span>
        </div>
      )}

      <Link
        href={`/admin/verification-hub/workspace?roundId=${round.roundId}`}
        className="ml-auto rounded-md bg-emerald-50 px-3 py-1.5 text-[11px] font-semibold text-emerald-600 hover:bg-emerald-100 dark:bg-emerald-900/20 dark:text-emerald-400 dark:hover:bg-emerald-900/40"
      >
        Open Workspace →
      </Link>
    </div>
  );
}
