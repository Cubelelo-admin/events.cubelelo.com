"use client";

import { useEffect, useState } from "react";

function formatRemaining(diffMs: number): string {
  if (diffMs <= 0) return "any moment now";
  const days = Math.floor(diffMs / 86_400_000);
  const hours = Math.floor((diffMs % 86_400_000) / 3_600_000);
  const mins = Math.floor((diffMs % 3_600_000) / 60_000);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${mins}m`;
  const secs = Math.floor((diffMs % 60_000) / 1000);
  return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
}

function tickInterval(diffMs: number): number {
  if (diffMs <= 60_000) return 1000;
  if (diffMs <= 3_600_000) return 1000;
  return 30_000;
}

/** Live-updating countdown label. Ticks every second when under 1 hour. */
export function Countdown({ target, className = "" }: { target: string; className?: string }) {
  const [label, setLabel] = useState(() => formatRemaining(new Date(target).getTime() - Date.now()));

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const now = Date.now();
      const diff = new Date(target).getTime() - now;
      setLabel(formatRemaining(diff));
      if (diff > 0) {
        const interval = tickInterval(diff);
        // Align to second boundary when ticking every second
        const delay = interval <= 1000 ? (1000 - (now % 1000) || 1000) : interval;
        timer = setTimeout(tick, delay);
      }
    };
    tick();
    return () => clearTimeout(timer);
  }, [target]);

  return <span className={className}>{label}</span>;
}

/** Hook returning remaining ms that ticks aligned to second boundaries. */
export function useCountdownMs(target: string | null): number | null {
  const [remaining, setRemaining] = useState<number | null>(() => {
    if (!target) return null;
    return Math.max(0, new Date(target).getTime() - Date.now());
  });

  useEffect(() => {
    if (!target) { setRemaining(null); return; }
    const targetMs = new Date(target).getTime();
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const now = Date.now();
      const left = Math.max(0, targetMs - now);
      setRemaining(left);
      if (left > 0) {
        // Align next tick to the next second boundary so display flips crisply
        timer = setTimeout(tick, 1000 - (now % 1000) || 1000);
      }
    };
    tick();
    return () => clearTimeout(timer);
  }, [target]);

  return remaining;
}
