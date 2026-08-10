"use client";

import { useEffect, useState } from "react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";

interface CompTimestamps {
  status: string;
  registrationOpensAt?: string | null;
  registrationDeadline?: string | null;
  startsAt?: string | null;
  endsAt?: string | null;
  cancellationReason?: string | null;
}

interface UserStatusInfo {
  label: string;
  tone: BadgeTone;
}

function formatCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const d = Math.floor(total / 86400);
  const h = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m ${s}s`;
}

function computeUserStatus(comp: CompTimestamps, now: number, isRegistered?: boolean): UserStatusInfo {
  const { status } = comp;

  if (status === "cancelled") {
    return { label: "Competition Cancelled", tone: "danger" };
  }
  if (status === "completed") {
    return { label: "Result Announced", tone: "info" };
  }
  if (status === "results_pending") {
    return { label: "Result Pending", tone: "warning" };
  }
  if (status === "live") {
    return { label: "Competition Live", tone: "success" };
  }
  if (status === "registration_closed") {
    if (isRegistered && comp.startsAt) {
      const remaining = new Date(comp.startsAt).getTime() - now;
      if (remaining > 0) {
        return {
          label: `Starting In ${formatCountdown(remaining)}`,
          tone: "info",
        };
      }
    }
    return { label: "Registration Closed", tone: "warning" };
  }
  if (status === "registration_open") {
    return { label: "Registration Open", tone: "success" };
  }

  // upcoming — check if registration opening countdown applies
  if (status === "upcoming" && comp.registrationOpensAt) {
    const remaining = new Date(comp.registrationOpensAt).getTime() - now;
    if (remaining > 0) {
      return {
        label: `Reg. Opens In ${formatCountdown(remaining)}`,
        tone: "info",
      };
    }
  }

  return { label: "Upcoming", tone: "neutral" };
}

export function UserStatusBadge({
  comp,
  isRegistered,
}: {
  comp: CompTimestamps;
  isRegistered?: boolean;
}) {
  const [now, setNow] = useState(() => Date.now());

  const hasCountdown =
    (comp.status === "upcoming" && comp.registrationOpensAt) ||
    (comp.status === "registration_closed" && isRegistered && comp.startsAt);

  useEffect(() => {
    if (!hasCountdown) return;
    let timer: ReturnType<typeof setTimeout>;
    const tick = () => {
      const now = Date.now();
      setNow(now);
      // Align to second boundary for crisp second transitions
      timer = setTimeout(tick, 1000 - (now % 1000) || 1000);
    };
    tick();
    return () => clearTimeout(timer);
  }, [hasCountdown]);

  const { label, tone } = computeUserStatus(comp, now, isRegistered);

  return <Badge tone={tone}>{label}</Badge>;
}
