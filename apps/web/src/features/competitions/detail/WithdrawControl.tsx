"use client";

import { useEffect, useState } from "react";
import {
  fetchMyWithdrawalRequests,
  requestWithdrawal,
  withdrawRegistration,
  type WithdrawalRequestDto,
} from "@/lib/api";

export interface WithdrawControlProps {
  registrationId: string;
  competitionId: string;
  /** Free competitions leave outright; paid ones have to ask the organiser. */
  isPaid: boolean;
  /** Withdrawal is only offered while registration is still open. */
  canWithdraw: boolean;
  onWithdrawn: () => void;
}

/**
 * Leaving a competition.
 *
 * There was no way to do this at all: the endpoint existed but refused every
 * registration, and nothing in the UI called it. Free competitions withdraw on
 * the spot. Paid ones open a request the organiser reviews — the same shape as
 * an appeal — because money has to be settled by a human.
 */
export function WithdrawControl({
  registrationId,
  competitionId,
  isPaid,
  canWithdraw,
  onWithdrawn,
}: WithdrawControlProps) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [request, setRequest] = useState<WithdrawalRequestDto | null>(null);

  // An existing request is the whole state of the paid flow, so it decides what
  // this renders — a form, or the organiser's answer.
  useEffect(() => {
    if (!isPaid) return;
    let cancelled = false;
    fetchMyWithdrawalRequests()
      .then((all) => {
        if (cancelled) return;
        const mine = all
          .filter((w) => w.registrationId === registrationId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        setRequest(mine[0] ?? null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [isPaid, registrationId]);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      if (isPaid) {
        setRequest(await requestWithdrawal(registrationId, reason.trim()));
        setOpen(false);
      } else {
        await withdrawRegistration(registrationId);
        onWithdrawn();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (request && request.status === "pending") {
    return (
      <p className="text-sm text-amber-600 dark:text-amber-400">
        Withdrawal requested — waiting for the organiser.
      </p>
    );
  }

  if (request && request.status === "rejected") {
    return (
      <p className="text-sm text-zinc-500">
        Withdrawal request declined
        {request.adminResponse ? `: ${request.adminResponse}` : "."}
      </p>
    );
  }

  if (request && request.status === "approved") {
    return (
      <p className="text-sm text-zinc-500">
        Withdrawn
        {request.adminResponse ? ` — ${request.adminResponse}` : "."}
      </p>
    );
  }

  if (!canWithdraw) return null;

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-sm text-zinc-500 underline transition hover:text-red-500"
      >
        {isPaid ? "Request withdrawal" : "Withdraw"}
      </button>
    );
  }

  return (
    <div className="w-full rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
      <p className="mb-2 text-sm text-zinc-600 dark:text-zinc-400">
        {isPaid
          ? "This competition was paid for, so the organiser reviews the request and settles any refund."
          : "You'll be removed from this competition. You can register again while registration is open."}
      </p>

      {isPaid && (
        <textarea
          rows={2}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why are you withdrawing?"
          className="mb-2 w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100"
        />
      )}

      {error && <p className="mb-2 text-sm text-red-500">{error}</p>}

      <div className="flex gap-2">
        <button
          type="button"
          disabled={busy || (isPaid && !reason.trim())}
          onClick={submit}
          className="rounded bg-red-700 px-4 py-1.5 text-sm text-white transition hover:bg-red-600 disabled:opacity-50"
        >
          {busy ? "Sending…" : isPaid ? "Send request" : "Confirm withdrawal"}
        </button>
        <button
          type="button"
          onClick={() => { setOpen(false); setError(null); }}
          className="rounded border border-zinc-300 px-4 py-1.5 text-sm text-zinc-600 transition hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-400 dark:hover:bg-zinc-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}
