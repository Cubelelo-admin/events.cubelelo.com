"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import {
  fetchEventPage,
  type EventPageData,
  type EventRoundInfo,
  type EventUserRound,
} from "@/lib/api";
import { useAuth } from "@/features/auth/AuthProvider";
import { useRoundStatus } from "@/features/realtime/useRoundStatus";
import { StatusBadge } from "@/features/competitions/StatusBadge";
import { useCountdownMs } from "@/components/Countdown";
import { Skeleton } from "@/components/Skeleton";
import { VideoUploadSection } from "./VideoUploadSection";
import { LiveRankingsPanel } from "./LiveRankingsPanel";
import { VerifiedResultsPanel } from "./VerifiedResultsPanel";
import { RoundParticipantsPanel } from "./RoundParticipantsPanel";

type RoundTab = "live" | "verified" | "participants";

function fmtCountdown(ms: number): string {
  const total = Math.ceil(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0)
    return `${h}:${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

export function EventRoundPanel({
  compId,
  eventId,
  eventType,
  videoDeadlineMinutes,
  cached,
  onCache,
}: {
  compId: string;
  eventId: string;
  eventType: string;
  videoDeadlineMinutes: number;
  cached: EventPageData | null;
  onCache: (data: EventPageData) => void;
}) {
  const { user } = useAuth();
  const [data, setData] = useState<EventPageData | null>(cached);
  const [loading, setLoading] = useState(!cached);
  const [selectedRoundIdx, setSelectedRoundIdx] = useState<number>(-1);
  const [roundTab, setRoundTab] = useState<RoundTab>("live");

  useEffect(() => {
    if (cached) {
      setData(cached);
      return;
    }
    setLoading(true);
    fetchEventPage(compId, eventId)
      .then((d) => {
        setData(d);
        onCache(d);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [compId, eventId, cached, onCache]);

  // Auto-select the latest non-pending round
  useEffect(() => {
    if (!data || selectedRoundIdx >= 0) return;
    const latestIdx = [...data.rounds]
      .reverse()
      .findIndex((r) => r.status !== "pending");
    setSelectedRoundIdx(
      latestIdx >= 0 ? data.rounds.length - 1 - latestIdx : data.rounds.length - 1,
    );
  }, [data, selectedRoundIdx]);

  const refreshData = () => {
    fetchEventPage(compId, eventId)
      .then((d) => {
        setData(d);
        onCache(d);
      })
      .catch(() => {});
  };

  if (loading) {
    return (
      <div className="mt-4 space-y-3">
        <Skeleton className="h-10 w-full rounded-lg" />
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }

  if (!data) return null;

  const { rounds, userStatus, finalStandings } = data;
  const selectedRound = rounds[selectedRoundIdx] ?? null;
  const userRound = userStatus?.rounds.find(
    (r) => r.roundId === selectedRound?.id,
  );
  const nextRound =
    selectedRound && selectedRoundIdx < rounds.length - 1
      ? rounds[selectedRoundIdx + 1]
      : null;
  const isLastRound = selectedRoundIdx === rounds.length - 1;

  return (
    <div className="mt-4">
      {/* Round selector pills */}
      {rounds.length > 1 && (
        <div className="mb-4 flex flex-wrap gap-2">
          {rounds.map((r, idx) => (
            <button
              key={r.id}
              onClick={() => {
                setSelectedRoundIdx(idx);
                setRoundTab("live");
              }}
              className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition ${
                selectedRoundIdx === idx
                  ? "bg-accent-primary text-zinc-950"
                  : "bg-zinc-100 text-zinc-600 hover:bg-zinc-200 dark:bg-zinc-800 dark:text-zinc-400 dark:hover:bg-zinc-700"
              }`}
            >
              Round {r.roundNumber}
              <StatusBadge status={r.status} />
            </button>
          ))}
        </div>
      )}

      {selectedRound && (
        <SelectedRoundView
          round={selectedRound}
          userRound={userRound ?? null}
          userStatus={userStatus}
          nextRound={nextRound}
          isLastRound={isLastRound}
          finalStandings={isLastRound ? finalStandings : null}
          competitionId={compId}
          eventType={eventType}
          roundTab={roundTab}
          setRoundTab={setRoundTab}
          videoDeadlineMinutes={videoDeadlineMinutes}
          onVideoUpdate={refreshData}
        />
      )}
    </div>
  );
}

/* ── Selected Round View ── */

function SelectedRoundView({
  round,
  userRound,
  userStatus,
  nextRound,
  isLastRound,
  finalStandings,
  competitionId,
  eventType,
  roundTab,
  setRoundTab,
  videoDeadlineMinutes,
  onVideoUpdate,
}: {
  round: EventRoundInfo;
  userRound: EventUserRound | null;
  userStatus: EventPageData["userStatus"];
  nextRound: EventRoundInfo | null;
  isLastRound: boolean;
  finalStandings: { rank: number; userId: string; displayName: string }[] | null;
  competitionId: string;
  eventType: string;
  roundTab: RoundTab;
  setRoundTab: (t: RoundTab) => void;
  videoDeadlineMinutes: number;
  onVideoUpdate: () => void;
}) {
  const { status: liveStatus } = useRoundStatus(round.id, round.status);

  // Client-side close check: hide "Enter Round" once closesAt passes per local clock
  const closeRemaining = useCountdownMs(liveStatus === "open" && round.closesAt ? round.closesAt : null);
  const closedLocally = closeRemaining !== null && closeRemaining <= 0;

  const canEnter =
    liveStatus === "open" &&
    !closedLocally &&
    userStatus?.registered &&
    userRound?.userStatus !== "submitted" &&
    (round.roundNumber === 1 ||
      userRound?.userStatus === "active" ||
      userRound?.userStatus === "upcoming");

  const isLocked =
    round.roundNumber > 1 &&
    userRound?.userStatus === "locked";

  // Countdown
  const countdownTarget =
    liveStatus === "pending" && round.opensAt
      ? round.opensAt
      : liveStatus === "closed" && nextRound?.opensAt
        ? nextRound.opensAt
        : null;
  const remaining = useCountdownMs(countdownTarget);

  // Video deadline
  const videoDeadlineTarget = round.closesAt
    ? new Date(new Date(round.closesAt).getTime() + videoDeadlineMinutes * 60 * 1000).toISOString()
    : null;
  const showVideoUpload = userRound?.result && (liveStatus === "closed" || liveStatus === "advanced") && videoDeadlineTarget;

  return (
    <div className="rounded-xl border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-zinc-900/40">
      {/* Round header */}
      <div className="flex flex-wrap items-center gap-3 border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
        <span className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          Round {round.roundNumber}
        </span>
        <StatusBadge status={liveStatus} />
        <div className="flex items-center gap-2 text-sm text-zinc-500">
          <span>{round.resultCount} result{round.resultCount !== 1 ? "s" : ""}</span>
          <span>·</span>
          <span>{round.participantCount} participant{round.participantCount !== 1 ? "s" : ""}</span>
        </div>

        {userRound && (
          <span
            className={`ml-auto rounded-full px-2.5 py-1 text-xs font-medium ${
              userRound.userStatus === "qualified"
                ? isLastRound
                  ? "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400"
                  : "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-400"
                : userRound.userStatus === "eliminated"
                  ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-400"
                  : userRound.userStatus === "submitted"
                    ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-400"
                    : "bg-zinc-100 text-zinc-600 dark:bg-zinc-800 dark:text-zinc-400"
            }`}
          >
            {userRound.userStatus === "qualified"
              ? isLastRound ? "Top Finisher" : "Qualified"
              : userRound.userStatus === "eliminated"
                ? isLastRound ? "Participated" : "Eliminated"
                : userRound.userStatus === "submitted"
                  ? "Submitted"
                  : userRound.userStatus === "active"
                    ? "Ready"
                    : userRound.userStatus === "locked"
                      ? "Not Shortlisted"
                      : userRound.userStatus.replace("_", " ")}
          </span>
        )}
      </div>

      {/* Actions bar */}
      <div className="border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
        <div className="flex flex-wrap items-center gap-3">
          {remaining !== null && remaining > 0 && (
            <div className="text-sm text-zinc-500">
              {liveStatus === "pending" ? "Opens in " : "Next round in "}
              <span className="font-mono font-semibold text-zinc-300">
                {fmtCountdown(remaining)}
              </span>
            </div>
          )}

          {liveStatus === "open" && !closedLocally && (
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-emerald-400">Round is live</span>
              {closeRemaining !== null && closeRemaining > 0 && (
                <span className={`font-mono text-xs font-semibold ${closeRemaining < 60_000 ? "text-red-500 animate-pulse" : closeRemaining < 300_000 ? "text-amber-500" : "text-zinc-500"}`}>
                  · {fmtCountdown(closeRemaining)}
                </span>
              )}
            </div>
          )}

          {liveStatus === "open" && closedLocally && (
            <span className="text-sm font-medium text-red-500">Round closing…</span>
          )}

          {liveStatus === "closed" && !nextRound && (
            <span className="text-sm text-zinc-500">
              {isLastRound ? "Final round closed — awaiting results" : "Round closed"}
            </span>
          )}

          {liveStatus === "advanced" && (
            <span className="text-sm text-zinc-500">
              {isLastRound ? "Event complete — final standings available" : "Round complete — results finalized"}
            </span>
          )}

          <div className="ml-auto">
            {liveStatus === "open" && userStatus?.registered && (
              userRound?.userStatus === "submitted" ? (
                <span className="rounded-lg bg-zinc-200 px-5 py-2 text-sm font-semibold text-zinc-500 dark:bg-zinc-700 dark:text-zinc-400">
                  Response Submitted
                </span>
              ) : canEnter ? (
                <Link
                  href={`/competitions/${competitionId}/round/${round.roundNumber}?eventId=${eventType}`}
                  className="rounded-lg bg-emerald-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-emerald-500"
                >
                  Enter Round
                </Link>
              ) : isLocked ? (
                <span className="rounded-lg bg-zinc-700 px-5 py-2 text-sm font-semibold text-zinc-400">
                  Not Shortlisted
                </span>
              ) : null
            )}
          </div>
        </div>

        {showVideoUpload && (
          <VideoUploadSection
            resultId={userRound!.result!.id}
            currentVideoUrl={userRound!.result!.videoUrl}
            deadline={videoDeadlineTarget!}
            onUpdate={onVideoUpdate}
          />
        )}
      </div>

      {/* Tabs */}
      <div className="flex flex-wrap gap-2 border-b border-zinc-200 px-5 py-3 dark:border-zinc-800">
        {(["live", "verified", "participants"] as RoundTab[]).map((t) => (
          <button
            key={t}
            onClick={() => setRoundTab(t)}
            className={`rounded-lg px-3.5 py-2 text-sm font-semibold transition ${
              roundTab === t
                ? "bg-accent-primary text-zinc-950"
                : "bg-zinc-100 text-zinc-500 hover:bg-zinc-200 dark:bg-zinc-900 dark:text-zinc-400 dark:hover:bg-zinc-800"
            }`}
          >
            {t === "live"
              ? round.resultsPublishedAt
                ? "Final Standings"
                : "Live Rankings"
              : t === "verified"
                ? "Verified Results"
                : "Participants"}
          </button>
        ))}
      </div>

      {/* Tab content */}
      <div className="p-5">
        {roundTab === "live" && (
          <LiveRankingsPanel
            roundId={round.id}
            roundStatus={liveStatus}
            publishedAt={round.resultsPublishedAt}
          />
        )}
        {roundTab === "verified" && <VerifiedResultsPanel roundId={round.id} />}
        {roundTab === "participants" && (
          <RoundParticipantsPanel roundId={round.id} roundStatus={liveStatus} />
        )}
      </div>

      {/* Final Standings */}
      {isLastRound && finalStandings && finalStandings.length > 0 && (
        <div className="border-t border-zinc-200 px-5 py-4 dark:border-zinc-800">
          <h3 className="mb-3 text-sm font-semibold uppercase tracking-wider text-amber-500">
            Final Standings
          </h3>
          <div className="space-y-1">
            {finalStandings.map((entry) => (
              <div
                key={entry.userId}
                className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-zinc-700 dark:text-zinc-300"
              >
                <span className={`w-8 text-center font-bold ${
                  entry.rank === 1 ? "text-amber-500 dark:text-amber-400" : entry.rank === 2 ? "text-zinc-500 dark:text-zinc-400" : entry.rank === 3 ? "text-amber-700 dark:text-amber-600" : "text-zinc-500"
                }`}>
                  #{entry.rank}
                </span>
                <span className="text-zinc-800 dark:text-zinc-200">{entry.displayName}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
