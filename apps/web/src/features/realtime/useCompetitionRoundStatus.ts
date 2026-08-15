"use client";

import { useEffect, useState } from "react";
import { acquireSocket, releaseSocket, trackCompJoin, trackCompLeave } from "./socket";

/**
 * Live status for every round of one competition.
 *
 * The competition page renders all rounds at once, so `useRoundStatus` — one
 * room per round — is the wrong shape here: a socket may join only ten rooms,
 * and a competition with eight events over two rounds would silently stop
 * updating partway through. This takes a single `comp:` room instead, which the
 * server fans `round:status` out to.
 *
 * Returns only what has changed since the page loaded. Callers overlay it on the
 * fetched rounds, so a round nobody has heard about keeps its fetched status.
 */
export function useCompetitionRoundStatus(compId: string | null): Map<string, string> {
  const [statuses, setStatuses] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    if (!compId) return;

    const socket = acquireSocket();
    socket.emit("join", { compId });
    trackCompJoin(compId);

    const handler = (p: { roundId: string; status: string }) => {
      setStatuses((prev) => {
        if (prev.get(p.roundId) === p.status) return prev;
        const next = new Map(prev);
        next.set(p.roundId, p.status);
        return next;
      });
    };
    socket.on("round:status", handler);

    return () => {
      socket.off("round:status", handler);
      trackCompLeave(compId);
      releaseSocket();
    };
  }, [compId]);

  return statuses;
}
