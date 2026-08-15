"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import {
  fetchAllWithdrawalRequests,
  resolveWithdrawalRequest,
  type WithdrawalRequestDto,
} from "@/lib/api";
import { EmptyState } from "@/components/EmptyState";
import { eventDisplayName } from "@/lib/eventNames";

const STATUS_COLOR: Record<string, string> = {
  pending: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400",
  approved: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-400",
  rejected: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400",
};

const rupees = (paise?: number) =>
  paise ? `₹${(paise / 100).toFixed(2)}` : "—";

/**
 * Withdrawal requests from paid competitions.
 *
 * The competitor cannot leave a paid competition on their own, so this is where
 * an organiser decides. Approving marks the registration withdrawn and frees the
 * slot; the refund itself is issued by hand in Razorpay, which is why every
 * payment identifier is on the card.
 */
export default function AdminWithdrawalRequestsPage() {
  const [requests, setRequests] = useState<WithdrawalRequestDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [resolving, setResolving] = useState<string | null>(null);
  const [responseText, setResponseText] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState<"all" | "pending" | "approved" | "rejected">("pending");

  const load = useCallback(() => {
    setLoading(true);
    fetchAllWithdrawalRequests()
      .then(setRequests)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => { load(); }, [load]);

  async function handleResolve(id: string, action: "approved" | "rejected") {
    setResolving(id);
    setError(null);
    try {
      await resolveWithdrawalRequest(id, action, responseText[id]);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setResolving(null);
    }
  }

  const filtered = filter === "all" ? requests : requests.filter((w) => w.status === filter);

  return (
    <div className="mx-auto max-w-[1400px] px-8 py-10">
      <h1 className="mb-1 text-xl font-bold text-zinc-900 dark:text-zinc-100">
        Withdrawal Requests
      </h1>
      <p className="mb-4 text-sm text-zinc-500">
        Competitors asking to leave a paid competition. Approving frees their slot — issue any
        refund in Razorpay yourself, then note it in the response.
      </p>

      {error && (
        <div className="mb-4 rounded bg-red-100 px-4 py-2 text-red-700 dark:bg-red-900/30 dark:text-red-300">
          {error}
        </div>
      )}

      <div className="mb-4 flex gap-2">
        {(["pending", "approved", "rejected", "all"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`rounded px-3 py-1 text-sm capitalize ${
              filter === f
                ? "bg-emerald-600 text-white"
                : "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      {loading ? (
        <p className="text-zinc-500">Loading…</p>
      ) : filtered.length === 0 ? (
        <EmptyState
          icon="🚪"
          title="No withdrawal requests"
          description="Requests to leave a paid competition will show up here."
        />
      ) : (
        <div className="space-y-4">
          {filtered.map((w) => (
            <div
              key={w.id}
              className="rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900"
            >
              <div className="mb-3 flex items-start justify-between gap-4">
                <div className="flex-1">
                  <div className="mb-1 flex flex-wrap items-center gap-2">
                    <span className="font-medium text-zinc-900 dark:text-white">
                      {w.userName ?? "Unknown"}
                    </span>
                    <span className="text-sm text-zinc-500">{w.userClId}</span>
                    <span className={`rounded px-2 py-0.5 text-xs ${STATUS_COLOR[w.status] ?? ""}`}>
                      {w.status}
                    </span>
                    {w.registrationStatus && w.registrationStatus !== "active" && (
                      <span className="rounded bg-zinc-200 px-2 py-0.5 text-xs text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400">
                        registration {w.registrationStatus}
                      </span>
                    )}
                  </div>

                  <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-zinc-600 dark:text-zinc-400">
                    {w.competitionId ? (
                      <Link
                        href={`/competitions/${w.competitionId}`}
                        className="font-medium text-emerald-700 hover:underline dark:text-emerald-400"
                      >
                        {w.competitionTitle}
                      </Link>
                    ) : (
                      <span>{w.competitionTitle}</span>
                    )}
                    {(w.eventTypes ?? []).map((et) => (
                      <span
                        key={et}
                        className="rounded bg-zinc-100 px-2 py-0.5 text-xs font-medium dark:bg-zinc-800"
                      >
                        {eventDisplayName(et)}
                      </span>
                    ))}
                    {w.userEmail && (
                      <>
                        <span className="text-zinc-400">•</span>
                        <span>{w.userEmail}</span>
                      </>
                    )}
                  </div>
                </div>
                <span className="shrink-0 text-xs text-zinc-500">
                  {new Date(w.createdAt).toLocaleDateString()}
                </span>
              </div>

              <div className="mb-3 rounded-lg bg-zinc-50 px-3 py-2 dark:bg-zinc-800/60">
                <p className="text-sm font-medium text-zinc-500 dark:text-zinc-400">Reason</p>
                <p className="text-sm text-zinc-800 dark:text-zinc-200">{w.reason}</p>
              </div>

              {/* Everything needed to find and refund the payment by hand. */}
              <div className="mb-3 grid gap-x-6 gap-y-1 rounded-lg border border-zinc-200 px-3 py-2 text-xs sm:grid-cols-2 dark:border-zinc-700">
                <div className="flex justify-between">
                  <span className="text-zinc-500">Amount paid</span>
                  <span className="font-mono text-zinc-800 dark:text-zinc-200">
                    {rupees(w.paymentAmount)} {w.paymentCurrency ?? ""}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Payment status</span>
                  <span className="text-zinc-800 dark:text-zinc-200">{w.paymentStatus ?? "—"}</span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="shrink-0 text-zinc-500">Razorpay order</span>
                  <span className="truncate font-mono text-zinc-800 dark:text-zinc-200">
                    {w.razorpayOrderId ?? "—"}
                  </span>
                </div>
                <div className="flex justify-between gap-2">
                  <span className="shrink-0 text-zinc-500">Razorpay payment</span>
                  <span className="truncate font-mono text-zinc-800 dark:text-zinc-200">
                    {w.razorpayPaymentId ?? "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Registered</span>
                  <span className="text-zinc-800 dark:text-zinc-200">
                    {w.registeredAt ? new Date(w.registeredAt).toLocaleDateString() : "—"}
                  </span>
                </div>
                <div className="flex justify-between">
                  <span className="text-zinc-500">Paid</span>
                  <span className="text-zinc-800 dark:text-zinc-200">
                    {w.paymentCreatedAt ? new Date(w.paymentCreatedAt).toLocaleDateString() : "—"}
                  </span>
                </div>
              </div>

              {w.adminResponse && (
                <div className="mb-3 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 dark:border-zinc-700 dark:bg-zinc-800/60">
                  <p className="text-xs font-medium text-zinc-500 dark:text-zinc-400">
                    Response by {w.resolvedByName ?? "Admin"}
                    {w.resolvedAt && <> • {new Date(w.resolvedAt).toLocaleDateString()}</>}
                  </p>
                  <p className="text-sm text-zinc-800 dark:text-zinc-200">{w.adminResponse}</p>
                </div>
              )}

              {w.status === "pending" && (
                <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
                  <textarea
                    placeholder="Response — e.g. refund reference (optional)"
                    value={responseText[w.id] ?? ""}
                    onChange={(e) =>
                      setResponseText((prev) => ({ ...prev, [w.id]: e.target.value }))
                    }
                    className="mb-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100 dark:placeholder:text-zinc-600"
                    rows={2}
                  />
                  <div className="flex gap-2">
                    <button
                      disabled={resolving === w.id}
                      onClick={() => handleResolve(w.id, "approved")}
                      className="rounded bg-emerald-700 px-4 py-1.5 text-sm text-white hover:bg-emerald-600 disabled:opacity-50"
                    >
                      Approve &amp; withdraw
                    </button>
                    <button
                      disabled={resolving === w.id}
                      onClick={() => handleResolve(w.id, "rejected")}
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
