"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { fetchAdminPayments, fetchCompetitions, downloadInvoice, confirmPayment, type AdminPaymentDto, type CompetitionSummary } from "@/lib/api";
import { EmptyState } from "@/components/EmptyState";
import { ConfirmModal } from "@/components/ui/Modal";
import { DateRangeFilter, useDateRange } from "@/components/ui/DateRangeFilter";


const STATUSES = ["pending", "paid", "failed", "refunded", "refund_pending"];

const STATUS_COLOR: Record<string, string> = {
  paid: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
  pending: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  failed: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
  refunded: "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400",
  refund_pending: "bg-orange-100 text-orange-700 dark:bg-orange-900/30 dark:text-orange-400",
};

function fmt(paise: number) {
  return `₹${(paise / 100).toFixed(2)}`;
}

function statusLabel(s: string) {
  return s.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

const inputClass = "rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100";

export default function AdminPaymentsPage() {
  const [payments, setPayments] = useState<AdminPaymentDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState("");
  const dateRange = useDateRange();
  const [compFilter, setCompFilter] = useState("");
  const [competitions, setCompetitions] = useState<CompetitionSummary[]>([]);
  const [allCompetitions, setAllCompetitions] = useState<CompetitionSummary[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    fetchAdminPayments({
      status: statusFilter || undefined,
      competitionId: compFilter || undefined,
    })
      .then(setPayments)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [statusFilter, compFilter]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    fetchCompetitions().then((c) => { setAllCompetitions(c); setCompetitions(c); }).catch(() => {});
  }, []);

  // Filter competitions dropdown by date range
  useEffect(() => {
    const { from, to } = dateRange.getRange();
    if (!from && !to) {
      setCompetitions(allCompetitions);
      return;
    }
    const fromMs = from ? new Date(from).getTime() : 0;
    const toMs = to ? new Date(to).getTime() : Infinity;
    setCompetitions(allCompetitions.filter((c) => {
      const t = new Date(c.startsAt ?? c.createdAt ?? "").getTime();
      return t >= fromMs && t <= toMs;
    }));
    setCompFilter((prev) => {
      if (!prev) return prev;
      const still = allCompetitions.find((c) => c.id === prev);
      if (!still) return "";
      const t = new Date(still.startsAt ?? still.createdAt ?? "").getTime();
      return (t >= fromMs && t <= toMs) ? prev : "";
    });
  }, [dateRange.getRange, allCompetitions]);

  const total = payments.filter((p) => p.status === "paid").reduce((s, p) => s + p.amount, 0);

  const handleExport = async () => {
    setExporting(true);
    try {
      const allPayments = await fetchAdminPayments({
        status: statusFilter || undefined,
        competitionId: compFilter || undefined,
      });
      const header = "User,CL ID,Email,Competition,Amount,Status,Razorpay Order,Razorpay Payment,Date";
      const rows = allPayments.map((p) =>
        [
          `"${p.userName}"`,
          p.userClId,
          p.userEmail,
          `"${p.competitionTitle}"`,
          (p.amount / 100).toFixed(2),
          p.status,
          p.razorpayOrderId ?? "",
          p.razorpayPaymentId ?? "",
          new Date(p.createdAt).toLocaleDateString(),
        ].join(",")
      );
      const csv = [header, ...rows].join("\n");
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `payments-export-${new Date().toISOString().slice(0, 10)}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  };

  const handleConfirm = async () => {
    if (!confirmingId) return;
    setConfirming(true);
    try {
      await confirmPayment(confirmingId, "Manual confirmation by admin");
      setConfirmingId(null);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setConfirming(false);
    }
  };

  return (
    <div className="mx-auto max-w-[1400px] px-8 py-10">
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">Payments</h1>
        <span className="font-mono text-sm text-emerald-400">
          Total collected: {fmt(total)}
        </span>
      </div>

      {/* Filters */}
      <div className="mb-5 space-y-3">
        {/* Status chips */}
        <div className="flex flex-wrap gap-2">
          {["", ...STATUSES].map((s) => (
            <button key={s} onClick={() => setStatusFilter(s)}
              className={`rounded-full border px-3 py-1 text-xs font-semibold transition ${
                statusFilter === s
                  ? "border-zinc-400 bg-zinc-800 text-white dark:border-zinc-500 dark:bg-zinc-700 dark:text-zinc-100"
                  : "border-zinc-300 text-zinc-500 hover:border-zinc-400 hover:text-zinc-700 dark:border-zinc-800 dark:hover:border-zinc-600 dark:hover:text-zinc-300"
              }`}>
              {s ? statusLabel(s) : "All"}
            </button>
          ))}
        </div>
        {/* Date + competition + export */}
        <div className="flex flex-wrap items-center gap-3">
          <DateRangeFilter
            preset={dateRange.preset}
            setPreset={dateRange.setPreset}
            customFrom={dateRange.customFrom}
            setCustomFrom={dateRange.setCustomFrom}
            customTo={dateRange.customTo}
            setCustomTo={dateRange.setCustomTo}
          />
          <select value={compFilter} onChange={(e) => setCompFilter(e.target.value)} className={`${inputClass} w-[220px] flex-shrink-0 truncate`}>
            <option value="">All competitions</option>
            {competitions.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
          </select>
          <button
            onClick={handleExport}
            disabled={exporting || payments.length === 0}
            className="flex-shrink-0 rounded-lg border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 hover:bg-zinc-100 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            {exporting ? "Exporting…" : "↓ Export CSV"}
          </button>
        </div>
      </div>

      {error && <div className="mb-4 rounded bg-red-100 px-4 py-2 text-red-700 dark:bg-red-900/30 dark:text-red-300">{error}</div>}

      {loading ? (
        <p className="text-zinc-500">Loading…</p>
      ) : payments.length === 0 ? (
        <EmptyState icon="💳" title="No payments found" description="Payment records will appear here once competitors start registering." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 dark:border-zinc-800">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900/60 text-left text-[11px] uppercase tracking-wider text-zinc-500">
                <th className="px-4 py-3">User</th>
                <th className="px-4 py-3">Competition</th>
                <th className="px-4 py-3 text-right">Amount</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Razorpay Order</th>
                <th className="px-4 py-3">Razorpay Payment</th>
                <th className="px-4 py-3">Date</th>
                <th className="px-4 py-3">Invoice</th>
              </tr>
            </thead>
            <tbody>
              {payments.map((p) => (
                <tr key={p.id} className="border-b border-zinc-100 hover:bg-zinc-50 dark:border-zinc-800/50 dark:hover:bg-zinc-900/40">
                  <td className="px-4 py-3">
                    <div className="font-medium text-zinc-800 dark:text-zinc-200">{p.userName}</div>
                    <div className="font-mono text-xs text-zinc-500">{p.userClId}</div>
                  </td>
                  <td className="px-4 py-3 text-zinc-600 dark:text-zinc-400">{p.competitionTitle}</td>
                  <td className="px-4 py-3 text-right font-mono font-semibold text-zinc-800 dark:text-zinc-200">
                    {fmt(p.amount)}
                  </td>
                  <td className="px-4 py-3">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${STATUS_COLOR[p.status] ?? "bg-zinc-200 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"}`}>
                      {statusLabel(p.status)}
                    </span>
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-zinc-500 max-w-[140px] truncate">
                    {p.razorpayOrderId ?? "—"}
                  </td>
                  <td className="px-4 py-3 font-mono text-xs text-zinc-500 max-w-[140px] truncate">
                    {p.razorpayPaymentId ?? "—"}
                  </td>
                  <td className="px-4 py-3 text-xs text-zinc-500">
                    {new Date(p.createdAt).toLocaleDateString()}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-2">
                      {p.status === "pending" && (
                        <button
                          onClick={() => setConfirmingId(p.id)}
                          className="rounded bg-emerald-600 px-2 py-1 text-xs font-semibold text-white hover:bg-emerald-500"
                        >
                          Confirm
                        </button>
                      )}
                      {p.status === "paid" && (
                        <button
                          onClick={() => downloadInvoice(p.id)}
                          className="rounded bg-zinc-200 px-2 py-1 text-xs text-zinc-700 hover:bg-zinc-300 dark:bg-zinc-800 dark:text-zinc-300 dark:hover:bg-zinc-700"
                        >
                          Invoice
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmModal
        open={!!confirmingId}
        onClose={() => setConfirmingId(null)}
        onConfirm={handleConfirm}
        loading={confirming}
        title="Confirm payment?"
        description="This marks the payment as paid and completes the registration. Use this for offline/cash payments. This action is logged."
        confirmLabel="Confirm Payment"
      />
    </div>
  );
}
