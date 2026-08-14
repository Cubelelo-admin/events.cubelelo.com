"use client";

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import { eventDisplayName } from "@/lib/eventNames";
import { EventIcon } from "@/components/EventIcon";
import {
  fetchCompetition,
  registerForCompetition,
  createPaymentOrder,
  verifyPayment,
  validatePromoCode,
  type CompetitionDetail,
} from "@/lib/api";
import { RouteGuard } from "@/features/auth/RouteGuard";
import { useAuth } from "@/features/auth/AuthProvider";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/Modal";
import { Skeleton } from "@/components/Skeleton";

function RegisterContent() {
  const params = useParams<{ id: string }>();
  const router = useRouter();
  const { user } = useAuth();
  const [comp, setComp] = useState<CompetitionDetail | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [pendingFallback, setPendingFallback] = useState<{ orderId: string; amount: number } | null>(null);
  const [showVerifyPopup, setShowVerifyPopup] = useState(false);
  const [promoInput, setPromoInput] = useState("");
  const [promoApplied, setPromoApplied] = useState<{
    code: string;
    discountType: string;
    discountValue: number;
    competitionEventId?: string;
  } | null>(null);
  const [promoError, setPromoError] = useState<string | null>(null);
  const [promoChecking, setPromoChecking] = useState(false);

  useEffect(() => {
    if (params.id) {
      fetchCompetition(params.id).then(setComp).catch(() => { });
    }
  }, [params.id]);

  if (!comp) {
    return (
      <main className="mx-auto max-w-lg px-6 py-10">
        <Skeleton className="mb-2 h-8 w-2/3" />
        <Skeleton className="mb-6 h-4 w-1/2" />
        <div className="space-y-2">
          <Skeleton className="h-14 rounded-lg" />
          <Skeleton className="h-14 rounded-lg" />
        </div>
      </main>
    );
  }

  const regCount = comp.registrationCount ?? 0;
  const regLimit = comp.registrationLimit;
  const isFull = regLimit != null && regLimit > 0 && regCount >= regLimit;

  const baseFee = comp.baseFee ?? 0;
  const defaultPerEventFee = comp.perEventFee ?? 0;
  const eventFeeSum = [...selected].reduce((sum, eid) => {
    const ev = comp.events.find((e) => e.id === eid);
    return sum + (ev?.fee ?? defaultPerEventFee);
  }, 0);
  const subtotal = baseFee + eventFeeSum;
  const discount = promoApplied
    ? promoApplied.competitionEventId
      ? (() => {
        const ev = comp.events.find((e) => e.id === promoApplied.competitionEventId);
        const evFee = ev?.fee ?? defaultPerEventFee;
        return promoApplied.discountType === "percentage"
          ? Math.round(evFee * promoApplied.discountValue / 100)
          : Math.min(promoApplied.discountValue, evFee);
      })()
      : promoApplied.discountType === "percentage"
        ? Math.round(subtotal * promoApplied.discountValue / 100)
        : Math.min(promoApplied.discountValue, subtotal)
    : 0;
  const totalFee = Math.max(0, subtotal - discount);
  const isFree = comp.type === "free" || totalFee === 0;

  const applyPromo = async () => {
    if (!promoInput.trim()) return;
    setPromoChecking(true);
    setPromoError(null);
    try {
      const res = await validatePromoCode(promoInput.trim(), comp.id, [...selected]);
      setPromoApplied(res);
    } catch (e) {
      setPromoError(e instanceof Error ? e.message : "Invalid code");
      setPromoApplied(null);
    } finally {
      setPromoChecking(false);
    }
  };

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const loadRazorpayScript = (): Promise<void> => {
    if (document.querySelector('script[src="https://checkout.razorpay.com/v1/checkout.js"]'))
      return Promise.resolve();
    return new Promise((resolve, reject) => {
      const s = document.createElement("script");
      s.src = "https://checkout.razorpay.com/v1/checkout.js";
      s.onload = () => resolve();
      s.onerror = () => reject(new Error("Failed to load payment gateway"));
      document.head.appendChild(s);
    });
  };

  const openRazorpayCheckout = (order: {
    orderId: string;
    amount: number;
    keyId: string;
  }): Promise<{ razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }> =>
    new Promise((resolve, reject) => {
      const options = {
        key: order.keyId,
        amount: order.amount,
        currency: "INR",
        name: "Cubelelo Events",
        description: `Registration for ${comp.title}`,
        order_id: order.orderId,
        handler: (response: { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string }) =>
          resolve(response),
        modal: { ondismiss: () => reject(new Error("Payment cancelled")) },
        prefill: {
          email: user?.email ?? "",
          name: user?.name ?? "",
        },
        theme: { color: "#10b981" },
      };
      const rzp = new (window as any).Razorpay(options);
      rzp.on("payment.failed", (resp: any) =>
        reject(new Error(resp.error?.description ?? "Payment failed")),
      );
      rzp.open();
    });

  const handleRegister = async () => {
    if (selected.size === 0) return;
    if (user && !user.emailVerified) {
      setShowVerifyPopup(true);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      if (isFree) {
        // Free: register directly
        await registerForCompetition(comp.id, [...selected]);
        setSuccess(true);
      } else {
        // Paid: create payment order first (no registration yet)
        const order = await createPaymentOrder(comp.id, [...selected], promoApplied?.code);

        // If promo brought amount to 0, backend already registered
        if (order.status === "paid") {
          setSuccess(true);
          return;
        }

        if (order.keyId) {
          await loadRazorpayScript();
          const checkout = await openRazorpayCheckout({
            orderId: order.orderId,
            amount: order.amount,
            keyId: order.keyId,
          });
          // Verify payment — this creates the registration
          await verifyPayment(
            checkout.razorpay_order_id,
            checkout.razorpay_payment_id,
            checkout.razorpay_signature,
          );
          setSuccess(true);
        } else {
          setPendingFallback({ orderId: order.orderId, amount: order.amount });
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  if (pendingFallback) {
    return (
      <main className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30">
          <svg className="h-7 w-7 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <div className="text-xl font-bold text-amber-500">Payment Pending</div>
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          Your spot is being held. Online payment is temporarily unavailable — please contact the organiser
          with order ID{" "}
          <span className="font-mono text-zinc-700 dark:text-zinc-300">{pendingFallback.orderId}</span>{" "}
          to complete payment of ₹{(pendingFallback.amount / 100).toFixed(2)}.
        </p>
        <Button variant="secondary" onClick={() => router.push(`/competitions/${comp.id}`)}>
          Back to Competition
        </Button>
      </main>
    );
  }

  if (success) {
    return (
      <main className="fade-slide-in mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center gap-4 px-6 text-center">
        <div className="flex h-14 w-14 items-center justify-center rounded-full bg-emerald-100 dark:bg-emerald-900/30">
          <svg className="h-7 w-7 text-emerald-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <div className="text-2xl font-bold text-accent-primary">
          {isFree ? "Registered!" : "Payment Successful!"}
        </div>
        <p className="text-zinc-500 dark:text-zinc-400">
          You&apos;re registered for {comp.title}. Head to the lobby when the round opens.
        </p>
        <Button onClick={() => router.push(`/competitions/${comp.id}`)}>Back to Competition</Button>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-lg px-6 py-10">
      <h1 className="mb-2 text-2xl font-bold text-zinc-900 dark:text-zinc-100">
        Register for {comp.title}
      </h1>
      <p className="mb-4 text-sm text-zinc-500 dark:text-zinc-400">
        Select the events you want to compete in.
      </p>

      {regLimit != null && regLimit > 0 && (
        <div className={`mb-6 flex items-center gap-2 rounded-lg border px-4 py-2.5 text-sm ${
          isFull
            ? "border-red-200 bg-red-50 text-red-700 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-400"
            : "border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900/40 dark:text-zinc-400"
        }`}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0">
            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
            <circle cx="9" cy="7" r="4" />
            <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
            <path d="M16 3.13a4 4 0 0 1 0 7.75" />
          </svg>
          <span className="tabular-nums font-medium">{regCount}/{regLimit}</span>
          <span>{isFull ? "— Registration full" : "spots taken"}</span>
        </div>
      )}

      <div className="mb-6 space-y-2">
        {comp.events.map((ev) => (
          <label
            key={ev.id}
            className={`flex cursor-pointer items-center justify-between rounded-lg border px-4 py-3 transition ${selected.has(ev.id)
                ? "border-accent-primary/60 bg-accent-primary/10"
                : "border-zinc-200 bg-white hover:border-zinc-300 dark:border-zinc-800 dark:bg-zinc-900/40 dark:hover:border-zinc-700"
              }`}
          >
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={selected.has(ev.id)}
                onChange={() => toggle(ev.id)}
                className="h-4 w-4 rounded border-zinc-300 accent-emerald-600 dark:border-zinc-700"
              />
              <span className="font-semibold text-zinc-800 dark:text-zinc-200">
                <EventIcon eventId={ev.eventType} size={16} className="mr-1" /> {eventDisplayName(ev.eventType)}
              </span>
              <span className="text-xs text-zinc-500">
                {ev.roundCount} round{ev.roundCount > 1 ? "s" : ""}
              </span>
            </div>
            {(ev.fee ?? defaultPerEventFee) > 0 && (
              <span className="text-xs text-zinc-500">
                +₹{((ev.fee ?? defaultPerEventFee) / 100).toFixed(2)}
              </span>
            )}
          </label>
        ))}
      </div>

      <div className="mb-6 rounded-lg border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-900/40">
        <div className="flex justify-between text-sm">
          <span className="text-zinc-500 dark:text-zinc-400">Base fee</span>
          <span className="text-zinc-800 dark:text-zinc-200">
            {isFree ? "Free" : `₹${(baseFee / 100).toFixed(2)}`}
          </span>
        </div>
        {eventFeeSum > 0 && selected.size > 0 && (
          <div className="flex justify-between text-sm">
            <span className="text-zinc-500 dark:text-zinc-400">
              {selected.size} event{selected.size > 1 ? "s" : ""}
            </span>
            <span className="text-zinc-800 dark:text-zinc-200">
              ₹{(eventFeeSum / 100).toFixed(2)}
            </span>
          </div>
        )}
        {/* Promo code */}
        {comp.type !== "free" && (
          <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
            <div className="flex gap-2">
              <Input
                value={promoInput}
                onChange={(e) => setPromoInput(e.target.value.toUpperCase())}
                placeholder="Promo code"
                className="flex-1"
              />
              <Button
                variant="secondary"
                onClick={applyPromo}
                disabled={promoChecking || !promoInput.trim()}
              >
                {promoChecking ? "…" : "Apply"}
              </Button>
            </div>
            {promoError && (
              <p className="mt-1 text-xs text-red-600 dark:text-red-400">{promoError}</p>
            )}
            {promoApplied && (
              <div className="mt-2 flex items-center justify-between text-sm">
                <span className="text-accent-primary">
                  {promoApplied.code} applied
                  {promoApplied.discountType === "percentage"
                    ? ` (${promoApplied.discountValue}% off)`
                    : ` (-₹${(promoApplied.discountValue / 100).toFixed(2)})`}
                </span>
                <button
                  onClick={() => { setPromoApplied(null); setPromoInput(""); }}
                  className="text-xs text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
                >
                  Remove
                </button>
              </div>
            )}
          </div>
        )}

        <div className="mt-2 flex justify-between border-t border-zinc-200 pt-2 font-semibold dark:border-zinc-800">
          <span className="text-zinc-700 dark:text-zinc-300">Total</span>
          <span className="text-zinc-900 dark:text-zinc-100">
            {isFree ? "Free" : `₹${(totalFee / 100).toFixed(2)}`}
          </span>
        </div>
      </div>

      {error && (
        <p className="mb-4 text-sm text-amber-600 dark:text-amber-400">{error}</p>
      )}

      <Button
        fullWidth
        size="lg"
        onClick={handleRegister}
        loading={busy}
        disabled={selected.size === 0 || isFull}
      >
        {isFull ? "Registration Full" : isFree ? "Register (Free)" : `Pay ₹${(totalFee / 100).toFixed(2)}`}
      </Button>

      {/* Email verification popup */}
      <Modal open={showVerifyPopup} onClose={() => setShowVerifyPopup(false)} title="Verification Required" size="sm">
        <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-full bg-amber-100 dark:bg-amber-900/30">
          <svg className="h-6 w-6 text-amber-600" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
        </div>
        <p className="mb-6 text-sm text-zinc-600 dark:text-zinc-400">
          You need to verify both your email and mobile number before you can register for competitions. Go to
          Settings to complete verification.
        </p>
        <div className="flex gap-3">
          <Button variant="secondary" fullWidth onClick={() => setShowVerifyPopup(false)}>
            Cancel
          </Button>
          <Button fullWidth onClick={() => router.push("/settings")}>
            Go to Settings
          </Button>
        </div>
      </Modal>
    </main>
  );
}

export default function RegisterPage() {
  return (
    <RouteGuard>
      <RegisterContent />
    </RouteGuard>
  );
}
