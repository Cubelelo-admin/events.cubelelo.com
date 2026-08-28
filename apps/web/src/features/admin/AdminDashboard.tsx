"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  createPracticeEvent,
  deleteCompetition,
  duplicateCompetition,
  fetchCompetitions,
  fetchCompetitionScrambles,
  regenerateRoundScrambles,
  updateCompetition,
  type CompetitionScrambles,
  type CompetitionSummary,
} from "@/lib/api";
import { StatusBadge } from "./StatusBadge";
import { eventDisplayName } from "@/lib/eventNames";
import { EventIcon } from "@/components/EventIcon";

/* ── Main admin dashboard ── */
export function AdminDashboard() {
  const [comps, setComps] = useState<CompetitionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    fetchCompetitions()
      .then(setComps)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => { load(); }, [load]);

  const [scramblePanel, setScramblePanel] = useState<{ compId: string; title: string } | null>(null);

  return (
    <div className="flex h-full">
      <div
        className="min-w-0 transition-all duration-300"
        style={{ flex: scramblePanel ? "1 1 0%" : "1 1 100%" }}
      >
        <div className="mx-auto max-w-[1400px] px-8 py-10">
          {error && (
            <div className="mb-4 rounded bg-red-100 px-4 py-2 text-red-700 dark:bg-red-900/30 dark:text-red-300">
              {error}
            </div>
          )}
          <OldCompetitions
            comps={comps}
            onRefresh={load}
            onOpenScrambles={(id, title) => setScramblePanel((prev) => prev?.compId === id ? null : { compId: id, title })}
            activeScrambleId={scramblePanel?.compId ?? null}
          />
        </div>
      </div>

      {scramblePanel && (
        <ScramblePanel
          compId={scramblePanel.compId}
          title={scramblePanel.title}
          onClose={() => setScramblePanel(null)}
        />
      )}
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Competition History
   ════════════════════════════════════════════════════════════════════════════ */

function OldCompetitions({
  comps,
  onRefresh,
  onOpenScrambles,
  activeScrambleId,
}: {
  comps: CompetitionSummary[];
  onRefresh: () => void;
  onOpenScrambles: (id: string, title: string) => void;
  activeScrambleId: string | null;
}) {
  const [filter, setFilter] = useState<string>("all");
  const [dateRange, setDateRange] = useState<string>("all");
  const [customFrom, setCustomFrom] = useState("");
  const [customTo, setCustomTo] = useState("");
  const [page, setPage] = useState(1);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dupPopup, setDupPopup] = useState<CompetitionSummary | null>(null);
  const [cancelPopup, setCancelPopup] = useState<CompetitionSummary | null>(null);
  const [deletePopup, setDeletePopup] = useState<CompetitionSummary | null>(null);
  const [publishPopup, setPublishPopup] = useState<CompetitionSummary | null>(null);

  const PER_PAGE = 10;

  // "All" is every published/run competition — drafts are unfinished setups kept
  // out of the main list and reachable only through their own tab.
  const draftCount = comps.filter((c) => c.status === "draft").length;
  const statusFiltered =
    filter === "all"
      ? comps.filter((c) => c.status !== "draft")
      : comps.filter((c) => c.status === filter);

  const dateFiltered = statusFiltered.filter((c) => {
    if (dateRange === "all") return true;
    const created = c.createdAt ? new Date(c.createdAt).getTime() : 0;
    const now = Date.now();
    if (dateRange === "this_month") {
      const d = new Date(); d.setDate(1); d.setHours(0, 0, 0, 0);
      return created >= d.getTime();
    }
    if (dateRange === "last_1_month") return created >= now - 30 * 86_400_000;
    if (dateRange === "last_6_months") return created >= now - 180 * 86_400_000;
    if (dateRange === "this_year") {
      const d = new Date(); d.setMonth(0, 1); d.setHours(0, 0, 0, 0);
      return created >= d.getTime();
    }
    if (dateRange === "last_1_year") return created >= now - 365 * 86_400_000;
    if (dateRange === "custom") {
      const from = customFrom ? new Date(customFrom).getTime() : 0;
      const to = customTo ? new Date(customTo).getTime() + 86_400_000 : Infinity;
      return created >= from && created <= to;
    }
    return true;
  });

  const totalPages = Math.max(1, Math.ceil(dateFiltered.length / PER_PAGE));
  const safePage = Math.min(page, totalPages);
  const filtered = dateFiltered.slice((safePage - 1) * PER_PAGE, safePage * PER_PAGE);

  const handleDuplicate = async (id: string, mode: "practice" | "paid" | "free") => {
    setBusy(id);
    setError(null);
    setDupPopup(null);
    try {
      if (mode === "practice") {
        await createPracticeEvent(id, {});
      } else {
        await duplicateCompetition(id, {
          reuseScrambles: true,
          type: mode,
        });
      }
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleCancel = async (id: string, reason: string) => {
    setBusy(id);
    setError(null);
    setCancelPopup(null);
    try {
      await updateCompetition(id, { status: "cancelled", cancellationReason: reason });
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handleDelete = async (id: string) => {
    setBusy(id);
    setError(null);
    setDeletePopup(null);
    try {
      await deleteCompetition(id);
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const handlePublish = async (id: string) => {
    setBusy(id);
    setError(null);
    setPublishPopup(null);
    try {
      await updateCompetition(id, { status: "published" });
      onRefresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <section className="mb-8 rounded-xl border border-zinc-200 bg-white p-6 dark:border-zinc-800 dark:bg-zinc-900/30">
      <h2 className="mb-4 text-sm font-semibold uppercase tracking-wider text-zinc-400">
        Competition History
      </h2>

      {error && <div className="mb-3 rounded bg-red-100 px-4 py-2 text-sm text-red-700 dark:bg-red-900/30 dark:text-red-300">{error}</div>}

      {/* Status filters */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {["all", "draft", "live", "results_pending", "completed", "cancelled"].map((f) => (
          <button
            key={f}
            onClick={() => { setFilter(f); setPage(1); }}
            className={`rounded-lg px-3 py-1.5 text-xs font-medium transition ${
              filter === f
                ? "bg-white text-zinc-900 shadow-sm dark:bg-zinc-800 dark:text-zinc-100"
                : "text-zinc-500 hover:bg-zinc-200 hover:text-zinc-800 dark:hover:bg-zinc-800/50 dark:hover:text-zinc-300"
            }`}
          >
            {f === "results_pending" ? "Results Pending" : f.charAt(0).toUpperCase() + f.slice(1)}
            {f === "draft" && draftCount > 0 && (
              <span className="ml-1.5 rounded-full bg-amber-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:text-amber-400">
                {draftCount}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* Date range */}
      <div className="mb-4 flex flex-wrap items-center gap-2">
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
          {dateFiltered.length} competition{dateFiltered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {/* Competition list */}
      <div className="overflow-hidden rounded-xl border border-zinc-200 dark:border-zinc-800">
        <table className="w-full text-sm">
          <thead className="bg-zinc-50 text-left text-xs uppercase tracking-wider text-zinc-500 dark:bg-zinc-900/60">
            <tr>
              <th className="px-4 py-2">Title</th>
              <th className="px-4 py-2">Type</th>
              <th className="px-4 py-2">Events</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2 text-right">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => (
              <tr
                key={c.id}
                className="border-t border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800 dark:hover:bg-zinc-900/40"
              >
                <td className="px-4 py-2.5 font-medium text-zinc-800 dark:text-zinc-200">
                  {c.title}
                </td>
                <td className="px-4 py-2.5 text-zinc-400">{c.type}</td>
                <td className="px-4 py-2.5 text-zinc-400">
                  {c.eventTypes?.length ? (
                    <div className="flex flex-wrap items-center gap-1.5">
                      {c.eventTypes.map((et) => (
                        <span key={et} title={eventDisplayName(et)} className="inline-flex">
                          <EventIcon eventId={et} size={16} className="text-zinc-600 dark:text-zinc-300" />
                        </span>
                      ))}
                    </div>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <StatusBadge status={c.status} />
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="flex items-center justify-end gap-2">
                    <Link
                      href={`/admin/competitions/${c.id}`}
                      className="text-xs text-emerald-400 hover:underline"
                    >
                      Manage
                    </Link>

                    <button
                      disabled={busy === c.id}
                      onClick={() => setDupPopup((prev) => prev?.id === c.id ? null : c)}
                      className="rounded border border-zinc-300 px-2 py-1 text-xs text-zinc-600 transition hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200 disabled:opacity-40"
                    >
                      {busy === c.id ? "…" : "Duplicate"}
                    </button>

                    {/* Scrambles — toggle side panel */}
                    <button
                      onClick={() => onOpenScrambles(c.id, c.title)}
                      className={`rounded border px-2 py-1 text-xs transition ${
                        activeScrambleId === c.id
                          ? "border-blue-500 bg-blue-500/10 text-blue-400"
                          : "border-zinc-300 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
                      }`}
                    >
                      Scrambles
                    </button>

                    {c.status === "draft" && (
                      <button
                        disabled={busy === c.id}
                        onClick={() => setPublishPopup(c)}
                        className="rounded border border-emerald-600 bg-emerald-600 px-2 py-1 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
                      >
                        Publish
                      </button>
                    )}

                    {c.status !== "cancelled" ? (
                      <button
                        disabled={busy === c.id}
                        onClick={() => setCancelPopup(c)}
                        className="rounded border border-amber-800/50 px-2 py-1 text-xs text-amber-400 transition hover:bg-amber-900/30 disabled:opacity-40"
                      >
                        Cancel
                      </button>
                    ) : (
                      <button
                        disabled={busy === c.id}
                        onClick={() => setDeletePopup(c)}
                        className="rounded border border-red-800/50 px-2 py-1 text-xs text-red-400 transition hover:bg-red-900/30 disabled:opacity-40"
                      >
                        Delete
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-6 text-center text-zinc-600">
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
            {(safePage - 1) * PER_PAGE + 1}–{Math.min(safePage * PER_PAGE, dateFiltered.length)} of {dateFiltered.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              disabled={safePage <= 1}
              onClick={() => setPage(1)}
              className="rounded px-2 py-1 text-xs text-zinc-500 transition hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800"
            >
              ««
            </button>
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
            <button
              disabled={safePage >= totalPages}
              onClick={() => setPage(totalPages)}
              className="rounded px-2 py-1 text-xs text-zinc-500 transition hover:bg-zinc-100 disabled:opacity-30 dark:hover:bg-zinc-800"
            >
              »»
            </button>
          </div>
        </div>
      )}

      {dupPopup && (
        <DuplicatePopup
          comp={dupPopup}
          onSelect={(mode) => handleDuplicate(dupPopup.id, mode)}
          onClose={() => setDupPopup(null)}
        />
      )}
      {cancelPopup && (
        <CancelPopup
          comp={cancelPopup}
          onConfirm={(reason) => handleCancel(cancelPopup.id, reason)}
          onClose={() => setCancelPopup(null)}
        />
      )}
      {deletePopup && (
        <DeletePopup
          comp={deletePopup}
          onConfirm={() => handleDelete(deletePopup.id)}
          onClose={() => setDeletePopup(null)}
        />
      )}
      {publishPopup && (
        <PublishPopup
          comp={publishPopup}
          loading={busy === publishPopup.id}
          onConfirm={() => handlePublish(publishPopup.id)}
          onClose={() => setPublishPopup(null)}
        />
      )}
    </section>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Duplicate Popup
   ════════════════════════════════════════════════════════════════════════════ */

function DuplicatePopup({
  comp,
  onSelect,
  onClose,
}: {
  comp: CompetitionSummary;
  onSelect: (mode: "practice" | "paid" | "free") => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />

      {/* Card */}
      <div
        ref={ref}
        className="relative z-10 w-72 rounded-xl border border-zinc-200 bg-white p-4 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900"
      >
        <div className="mb-3 flex items-center justify-between">
          <p className="text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Duplicate &ldquo;{comp.title}&rdquo;
          </p>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-200">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        </div>

        <div className="space-y-1">
          <button
            onClick={() => onSelect("practice")}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-zinc-700 transition hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-violet-100 text-lg dark:bg-violet-900/40">🎯</span>
            <div>
              <div className="font-medium">Practice Event</div>
              <div className="text-[11px] text-zinc-500">Open practice session</div>
            </div>
          </button>
          <button
            onClick={() => onSelect("paid")}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-zinc-700 transition hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-100 text-lg dark:bg-amber-900/40">💰</span>
            <div>
              <div className="font-medium">Paid Competition</div>
              <div className="text-[11px] text-zinc-500">New paid comp with same setup</div>
            </div>
          </button>
          <button
            onClick={() => onSelect("free")}
            className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm text-zinc-700 transition hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-100 text-lg dark:bg-emerald-900/40">🆓</span>
            <div>
              <div className="font-medium">Free Competition</div>
              <div className="text-[11px] text-zinc-500">New free comp with same setup</div>
            </div>
          </button>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Cancel Popup
   ════════════════════════════════════════════════════════════════════════════ */

function getCancelConsequences(status: string): string[] {
  switch (status) {
    case "draft":
      return [
        "Competition will be marked as cancelled.",
        "No users are affected — it was never published.",
        "You can delete it afterwards if needed.",
      ];
    case "published":
    case "upcoming":
      return [
        "Competition will be removed from the public listing.",
        "No registrations have opened yet, so no users are directly affected.",
        "You can delete it afterwards if needed.",
      ];
    case "registration_open":
      return [
        "Registration will close immediately.",
        "All registered participants will see the competition as cancelled.",
        "Paid registrations may need manual refunds.",
        "Scrambles and rounds will remain but won't be accessible to participants.",
      ];
    case "registration_closed":
      return [
        "All registered participants will see the competition as cancelled.",
        "Paid registrations may need manual refunds.",
        "Scrambles and rounds will remain but won't be accessible to participants.",
      ];
    case "live":
      return [
        "The competition will stop immediately for all participants.",
        "Active rounds will be frozen — no more submissions accepted.",
        "Existing results will be preserved but the competition won't be finalized.",
        "Paid registrations may need manual refunds.",
        "This cannot be undone without admin intervention.",
      ];
    case "results_pending":
      return [
        "Results will not be finalized or published.",
        "Rankings will not be updated from this competition.",
        "Existing submissions are preserved but won't count.",
        "Paid registrations may need manual refunds.",
      ];
    case "completed":
      return [
        "Competition will be marked as cancelled retroactively.",
        "Published results and rankings from this competition may become invalid.",
        "Participants will see the competition as cancelled in their history.",
        "This is unusual — consider whether this is truly necessary.",
      ];
    default:
      return ["Competition will be marked as cancelled."];
  }
}

function CancelPopup({
  comp,
  onConfirm,
  onClose,
}: {
  comp: CompetitionSummary;
  onConfirm: (reason: string) => void;
  onClose: () => void;
}) {
  const [reason, setReason] = useState("");
  const consequences = getCancelConsequences(comp.status);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 w-[420px] rounded-xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-100 text-lg dark:bg-amber-900/40">⚠️</span>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Cancel Competition</h3>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-200">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        </div>

        <p className="mb-1 text-xs text-zinc-500">
          You are cancelling <span className="font-medium text-zinc-300">&ldquo;{comp.title}&rdquo;</span>
          {" "}(currently <span className="font-medium text-amber-400">{comp.status.replace(/_/g, " ")}</span>)
        </p>

        <div className="my-3 rounded-lg border border-amber-800/30 bg-amber-950/20 p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-amber-400">What will happen</p>
          <ul className="space-y-1">
            {consequences.map((c, i) => (
              <li key={i} className="flex gap-2 text-xs text-zinc-400">
                <span className="mt-0.5 text-amber-500">•</span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="mb-4">
          <label className="mb-1 block text-xs text-zinc-500">Reason for cancellation *</label>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="e.g., Insufficient registrations, scheduling conflict…"
            rows={2}
            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-xs text-zinc-500 transition hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            Go Back
          </button>
          <button
            disabled={!reason.trim()}
            onClick={() => onConfirm(reason.trim())}
            className="rounded-lg bg-amber-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-amber-500 disabled:opacity-40"
          >
            Cancel Competition
          </button>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Delete Popup
   ════════════════════════════════════════════════════════════════════════════ */

function DeletePopup({
  comp,
  onConfirm,
  onClose,
}: {
  comp: CompetitionSummary;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState("");
  const confirmWord = "DELETE";

  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const hasRegistrations = (comp.registrationCount ?? 0) > 0;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 w-[420px] rounded-xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-red-100 text-lg dark:bg-red-900/40">🗑️</span>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Delete Competition</h3>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-200">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        </div>

        <p className="mb-3 text-xs text-zinc-500">
          You are permanently deleting <span className="font-medium text-zinc-300">&ldquo;{comp.title}&rdquo;</span>
        </p>

        <div className="my-3 rounded-lg border border-red-800/30 bg-red-950/20 p-3">
          <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-red-400">This action is irreversible</p>
          <ul className="space-y-1">
            <li className="flex gap-2 text-xs text-zinc-400">
              <span className="mt-0.5 text-red-500">•</span>
              <span>The competition and all its events, rounds, and scrambles will be permanently removed.</span>
            </li>
            {hasRegistrations && (
              <li className="flex gap-2 text-xs text-zinc-400">
                <span className="mt-0.5 text-red-500">•</span>
                <span>All {comp.registrationCount} registration(s) will be deleted.</span>
              </li>
            )}
            <li className="flex gap-2 text-xs text-zinc-400">
              <span className="mt-0.5 text-red-500">•</span>
              <span>This data cannot be recovered after deletion.</span>
            </li>
            <li className="flex gap-2 text-xs text-zinc-400">
              <span className="mt-0.5 text-red-500">•</span>
              <span>Any results or submissions associated with this competition will be lost.</span>
            </li>
          </ul>
        </div>

        <div className="mb-4">
          <label className="mb-1 block text-xs text-zinc-500">
            Type <span className="font-mono font-semibold text-red-400">{confirmWord}</span> to confirm
          </label>
          <input
            type="text"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder={confirmWord}
            className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-red-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-800 dark:text-zinc-100"
          />
        </div>

        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-xs text-zinc-500 transition hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            Go Back
          </button>
          <button
            disabled={typed !== confirmWord}
            onClick={onConfirm}
            className="rounded-lg bg-red-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-red-500 disabled:opacity-40"
          >
            Delete Permanently
          </button>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Publish Popup
   ════════════════════════════════════════════════════════════════════════════ */

function PublishPopup({
  comp,
  loading,
  onConfirm,
  onClose,
}: {
  comp: CompetitionSummary;
  loading: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [onClose]);

  const hasEvents = (comp.eventTypes?.length ?? 0) > 0;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative z-10 w-[420px] rounded-xl border border-zinc-200 bg-white p-5 shadow-2xl dark:border-zinc-700 dark:bg-zinc-900">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-emerald-100 text-lg dark:bg-emerald-900/40">🚀</span>
            <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Publish Competition</h3>
          </div>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-200">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
          </button>
        </div>

        <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">
          Are you sure you want to publish <strong className="text-zinc-900 dark:text-zinc-100">&ldquo;{comp.title}&rdquo;</strong>? It will become visible to all users.
        </p>

        {!hasEvents && (
          <div className="my-3 rounded-lg border border-amber-800/30 bg-amber-950/20 p-3">
            <p className="text-xs font-semibold text-amber-400">Warning: This competition has no events added yet.</p>
          </div>
        )}

        <div className="flex items-center justify-end gap-2">
          <button
            onClick={onClose}
            className="rounded-lg px-4 py-2 text-xs text-zinc-500 transition hover:bg-zinc-100 dark:hover:bg-zinc-800"
          >
            Go Back
          </button>
          <button
            disabled={loading}
            onClick={onConfirm}
            className="rounded-lg bg-emerald-600 px-4 py-2 text-xs font-semibold text-white transition hover:bg-emerald-500 disabled:opacity-40"
          >
            {loading ? "Publishing…" : "Publish"}
          </button>
        </div>
      </div>
    </div>
  );
}

/* ════════════════════════════════════════════════════════════════════════════
   Scramble Side Panel (resizable)
   ════════════════════════════════════════════════════════════════════════════ */

function ScramblePanel({
  compId,
  title,
  onClose,
}: {
  compId: string;
  title: string;
  onClose: () => void;
}) {
  const [data, setData] = useState<CompetitionScrambles | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [regenerating, setRegenerating] = useState<string | null>(null);
  const [width, setWidth] = useState(480);
  const dragging = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchCompetitionScrambles(compId)
      .then(setData)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [compId]);

  useEffect(() => { load(); }, [load]);

  // Drag-to-resize
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    const startX = e.clientX;
    const startW = width;

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current) return;
      const delta = startX - ev.clientX;
      setWidth(Math.max(320, Math.min(900, startW + delta)));
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [width]);

  const handleRegenerate = async (roundId: string) => {
    setRegenerating(roundId);
    try {
      const res = await regenerateRoundScrambles(roundId);
      setData((prev) => {
        if (!prev) return prev;
        return {
          ...prev,
          events: prev.events.map((ev) => ({
            ...ev,
            rounds: ev.rounds.map((r) =>
              r.roundId === roundId
                ? { ...r, scrambles: res.scrambles, generatedAt: res.generatedAt, locked: true }
                : r,
            ),
          })),
        };
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRegenerating(null);
    }
  };

  return (
    <div
      ref={panelRef}
      className="relative flex-shrink-0 border-l border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-950"
      style={{ width }}
    >
      {/* Drag handle */}
      <div
        onMouseDown={onMouseDown}
        className="absolute -left-1 top-0 z-10 h-full w-2 cursor-col-resize hover:bg-blue-500/20"
      />

      {/* Header */}
      <div className="sticky top-0 z-10 flex items-center justify-between border-b border-zinc-200 bg-white px-4 py-3 dark:border-zinc-800 dark:bg-zinc-950">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Scrambles</h3>
          <p className="truncate text-xs text-zinc-500">{title}</p>
        </div>
        <button
          onClick={onClose}
          className="ml-2 rounded p-1 text-zinc-400 transition hover:bg-zinc-100 hover:text-zinc-700 dark:hover:bg-zinc-800 dark:hover:text-zinc-200"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" /></svg>
        </button>
      </div>

      {/* Content */}
      <div className="h-[calc(100vh-120px)] overflow-y-auto px-4 py-4">
        {loading && <p className="text-sm text-zinc-500">Loading scrambles…</p>}
        {error && <p className="mb-3 rounded bg-red-100 px-3 py-2 text-xs text-red-700 dark:bg-red-900/30 dark:text-red-300">{error}</p>}

        {data && data.events.length === 0 && (
          <p className="text-sm text-zinc-500">No events found.</p>
        )}

        {data?.events.map((ev) => (
          <div key={ev.eventType} className="mb-5">
            <div className="mb-2 flex items-center gap-2">
              <EventIcon eventId={ev.eventType} size={18} />
              <h4 className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
                {eventDisplayName(ev.eventType)}
              </h4>
            </div>

            {ev.rounds.map((r) => (
              <div
                key={r.roundId}
                className="mb-3 rounded-lg border border-zinc-100 bg-zinc-50 p-3 dark:border-zinc-800/60 dark:bg-zinc-900/50"
              >
                <div className="mb-2 flex items-center justify-between">
                  <span className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
                    Round {r.roundNumber}
                  </span>
                  <div className="flex items-center gap-2">
                    {r.generatedAt && (
                      <span className="text-[10px] text-zinc-500">
                        {new Date(r.generatedAt).toLocaleString()}
                      </span>
                    )}
                    {!r.hasResults
                      && r.status !== "closed" && r.status !== "advanced"
                      && (data.status === "draft" || data.status === "published"
                        || (data.status === "live" && r.scrambles.length === 0)) && (
                      <button
                        disabled={regenerating === r.roundId}
                        onClick={() => handleRegenerate(r.roundId)}
                        className="rounded border border-blue-800/40 px-2 py-0.5 text-[10px] font-medium text-blue-400 transition hover:bg-blue-900/20 disabled:opacity-40"
                      >
                        {regenerating === r.roundId ? "…" : r.scrambles.length > 0 ? "Regenerate" : "Generate"}
                      </button>
                    )}
                  </div>
                </div>

                {r.scrambles.length === 0 ? (
                  <p className="text-xs italic text-zinc-500">No scrambles generated yet</p>
                ) : (
                  <ol className="space-y-1">
                    {r.scrambles.map((s, i) => (
                      <li key={i} className="flex gap-2 text-xs">
                        <span className="w-5 flex-shrink-0 text-right font-mono text-zinc-500">
                          {i + 1}.
                        </span>
                        <code className="break-all font-mono text-zinc-700 dark:text-zinc-300">
                          {s}
                        </code>
                      </li>
                    ))}
                  </ol>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
