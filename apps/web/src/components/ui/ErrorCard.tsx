"use client";

import { useRouter } from "next/navigation";

const ERROR_INFO: Record<string, { title: string; message: string; steps: string[] }> = {
  not_registered_for_event: {
    title: "Not Registered",
    message: "You are not registered for this event.",
    steps: [
      "Go to the competition page and register first.",
      "Make sure you selected this event during registration.",
    ],
  },
  payment_pending: {
    title: "Payment Pending",
    message: "Your registration payment has not been completed yet.",
    steps: [
      "Go to the competition page and complete your payment.",
      "If you already paid, wait a moment and try again — confirmation may take a few seconds.",
      "Contact support if payment was deducted but not reflected.",
    ],
  },
  not_shortlisted: {
    title: "Not Qualified",
    message: "You were not shortlisted for this round.",
    steps: [
      "Only top performers from the previous round advance.",
      "Check the results to see the cutoff.",
    ],
  },
  not_synced: {
    title: "Account Not Synced",
    message: "Your account could not be found.",
    steps: [
      "Try logging out and logging back in.",
      "If the issue persists, contact support.",
    ],
  },
  round_not_open: {
    title: "Round Not Open",
    message: "This round is not open for participation yet.",
    steps: [
      "Check the schedule for when it opens.",
      "The page will update automatically when the round starts.",
    ],
  },
  scrambles_not_ready: {
    title: "Scrambles Loading",
    message: "Scrambles are being generated for this round.",
    steps: [
      "Wait a few seconds and try again.",
      "This usually resolves within a minute.",
    ],
  },
  round_not_found: {
    title: "Round Not Found",
    message: "This round does not exist or has been removed.",
    steps: [
      "Go back to the competition page.",
      "Check if the event is still listed.",
    ],
  },
  competition_not_found: {
    title: "Competition Not Found",
    message: "This competition does not exist or has been removed.",
    steps: [
      "Check the URL for typos.",
      "Browse all competitions from the home page.",
    ],
  },
  duplicate_title: {
    title: "Duplicate Name",
    message: "A competition with this name already exists.",
    steps: [
      "Choose a different title for your competition.",
      "Check existing competitions to avoid duplicates.",
    ],
  },
  network_error: {
    title: "Connection Issue",
    message: "Could not reach the server.",
    steps: [
      "Check your internet connection.",
      "Try refreshing the page.",
      "If the issue persists, the server may be temporarily down.",
    ],
  },
};

const DEFAULT_INFO = {
  title: "Something Went Wrong",
  message: "An unexpected error occurred.",
  steps: [
    "Try refreshing the page.",
    "If the issue persists, try logging out and back in.",
    "Contact support if the problem continues.",
  ],
};

function resolveError(raw: string): { title: string; message: string; steps: string[] } {
  const match = ERROR_INFO[raw];
  if (match) return match;
  try {
    const jsonMatch = raw.match(/\{.*\}/s);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const key = parsed.error ?? parsed.message;
      if (key && ERROR_INFO[key]) return ERROR_INFO[key];
    }
  } catch {}
  if (raw.includes("fetch") || raw.includes("Failed") || raw.includes("NetworkError")) {
    return ERROR_INFO.network_error;
  }
  return { ...DEFAULT_INFO, message: raw || DEFAULT_INFO.message };
}

export function ErrorCard({
  error,
  onRetry,
  onBack,
}: {
  error: string;
  onRetry?: () => void;
  onBack?: boolean;
}) {
  const router = useRouter();
  const info = resolveError(error);

  return (
    <div className="mx-auto max-w-sm rounded-xl border border-zinc-200 bg-white p-6 shadow-lg dark:border-zinc-700 dark:bg-zinc-900">
      <div className="mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/30">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-red-500">
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      </div>
      <h3 className="mb-1 text-base font-semibold text-zinc-900 dark:text-zinc-100">{info.title}</h3>
      <p className="mb-3 text-sm text-zinc-600 dark:text-zinc-400">{info.message}</p>
      <ul className="mb-4 space-y-1">
        {info.steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2 text-xs text-zinc-500 dark:text-zinc-400">
            <span className="mt-0.5 shrink-0 text-zinc-400 dark:text-zinc-500">{i + 1}.</span>
            {s}
          </li>
        ))}
      </ul>
      <div className="flex items-center gap-2">
        {onBack !== false && (
          <button
            onClick={() => router.back()}
            className="rounded-lg border border-zinc-200 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            Go Back
          </button>
        )}
        {onRetry && (
          <button
            onClick={onRetry}
            className="rounded-lg bg-zinc-800 px-4 py-2 text-sm font-medium text-white transition hover:bg-zinc-700 dark:bg-zinc-700 dark:hover:bg-zinc-600"
          >
            Try Again
          </button>
        )}
      </div>
    </div>
  );
}
