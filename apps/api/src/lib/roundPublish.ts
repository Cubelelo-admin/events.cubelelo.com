import { randomUUID } from "node:crypto";
import type { Repository } from "../db/repo";
import type { Round } from "../db/types";
import type { Realtime } from "../sockets/realtime";
import { effectiveRoundStatus } from "./statusUtils";
import { shortlistRound, checkCompetitionCompletion } from "./roundLifecycle";
import { isActiveRegistration } from "./registrationStatus";
import { roundNotificationEmail, sendBulk } from "./email";

export interface PublishOptions {
  actorId: string;
  /**
   * Published by the deadline rather than by a person.
   *
   * The only rule this relaxes is the "everything must be verified" guard —
   * the point of the deadline is that the next round cannot wait for a review
   * that has not happened. Everything else still applies.
   */
  auto?: boolean;
}

export interface PublishResult {
  roundNumber: number;
  eventType: string;
  recipientCount: number;
  sentCount: number;
  sent: boolean;
  advancedCount: number;
  advanced: { userId: string; rank: number; name: string; clId: string }[];
  competitionCompleted: boolean;
  auto: boolean;
}

export type PublishOutcome =
  | { ok: true; result: PublishResult }
  | { ok: false; status: number; error: string };

/**
 * Finalise a round: freeze the standings, shortlist from them, tell everyone.
 *
 * Callable rather than routable because two things now publish — the organiser
 * pressing the button, and the deadline that fires before the next round opens.
 * Keeping this in the route would have made the job a fifth copy of logic that
 * already existed four times over.
 *
 * Publishing is what advances competitors. Verification deliberately does not.
 */
export async function publishRound(
  repo: Repository,
  realtime: Realtime,
  round: Round,
  opts: PublishOptions,
): Promise<PublishOutcome> {
  if (round.resultsPublishedAt) {
    return { ok: false, status: 409, error: "already_published" };
  }

  // `advanced` is allowed as well as `closed`: the shortlist claims the round
  // before the publish stamp lands, so a failure between the two must leave
  // publishing resumable rather than stranding the round forever.
  const status = effectiveRoundStatus(round);
  if (status !== "closed" && status !== "advanced") {
    return { ok: false, status: 409, error: "round_not_closed" };
  }

  const results = await repo.results.findByRound(round.id);
  // A human publishing mid-review is almost always a mistake. The deadline has
  // no such luxury — flagged results simply do not make the shortlist, because
  // `shortlistRound` already excludes them from the eligible set.
  if (!opts.auto && results.some((r) => r.flagStatus === "flagged")) {
    return { ok: false, status: 409, error: "results_not_verified" };
  }

  const event = await repo.competitionEvents.findById(round.competitionEventId);
  if (!event) return { ok: false, status: 404, error: "event_not_found" };

  // Shortlist first, stamp second. Stamping first meant a failed shortlist left
  // `resultsPublishedAt` set while the compensating revert put the status back
  // to `closed` — so every retry hit `already_published` and the round could
  // never be published at all.
  await shortlistRound(repo, realtime, round);
  await repo.rounds.update(round.id, { resultsPublishedAt: new Date().toISOString() });

  const advanced = await repo.advancements.findByRound(round.id);
  const advancedUsers = await repo.users.findByIds(advanced.map((a) => a.userId));

  const comp = await repo.competitions.findById(event.competitionId);
  const regs = await repo.registrations.findByCompetition(event.competitionId);
  const activeRegs = regs.filter(isActiveRegistration);
  const usersMap = await repo.users.findByIds(activeRegs.map((r) => r.userId));
  const recipients: { email: string; name: string }[] = [];
  for (const reg of activeRegs) {
    const user = usersMap.get(reg.userId);
    if (user?.email) recipients.push({ email: user.email, name: user.name });
  }

  const compTitle = comp?.title ?? "Competition";
  const sentCount = await sendBulk(
    recipients.map((r) => {
      const msg = roundNotificationEmail(r.name, compTitle, round.roundNumber, "results_published");
      return { to: r.email, subject: msg.subject, html: msg.html };
    }),
  );

  // One implementation of "is this competition finished", shared with the round
  // lifecycle rather than restated here.
  const fresh = await repo.rounds.findById(round.id);
  if (fresh) await checkCompetitionCompletion(repo, realtime, fresh);
  const compAfter = await repo.competitions.findById(event.competitionId);

  await repo.auditLog.create({
    id: randomUUID(),
    adminId: opts.actorId,
    action: opts.auto ? "round_results_auto_published" : "round_results_published",
    target: round.id,
    reason: `${advanced.length} advanced`,
    createdAt: new Date().toISOString(),
  });

  return {
    ok: true,
    result: {
      roundNumber: round.roundNumber,
      eventType: event.eventType,
      recipientCount: recipients.length,
      sentCount,
      sent: sentCount > 0,
      advancedCount: advanced.length,
      advanced: advanced.map((a) => ({
        userId: a.userId,
        rank: a.rank,
        name: advancedUsers.get(a.userId)?.name ?? a.userId,
        clId: advancedUsers.get(a.userId)?.clId ?? a.userId,
      })),
      competitionCompleted: compAfter?.status === "completed",
      auto: Boolean(opts.auto),
    },
  };
}

/**
 * The round that follows this one in the same event, if any.
 *
 * The auto-publish deadline belongs to round N but is derived from round N+1's
 * opening time — a final round has nothing to block, so it is never scheduled.
 */
export async function nextRoundOf(
  repo: Repository,
  round: Round,
): Promise<Round | null> {
  const event = await repo.competitionEvents.findById(round.competitionEventId);
  if (!event) return null;
  const all = await repo.rounds.findByCompetition(event.competitionId);
  return (
    all.find(
      (r) =>
        r.competitionEventId === round.competitionEventId &&
        r.roundNumber === round.roundNumber + 1,
    ) ?? null
  );
}

/**
 * The round before this one in the same event, if any.
 *
 * Needed because a round's opening time is what sets the *previous* round's
 * publish deadline — so moving round 2 has to reschedule round 1.
 */
export async function previousRoundOf(
  repo: Repository,
  round: Round,
): Promise<Round | null> {
  if (round.roundNumber <= 1) return null;
  const event = await repo.competitionEvents.findById(round.competitionEventId);
  if (!event) return null;
  const all = await repo.rounds.findByCompetition(event.competitionId);
  return (
    all.find(
      (r) =>
        r.competitionEventId === round.competitionEventId &&
        r.roundNumber === round.roundNumber - 1,
    ) ?? null
  );
}

/**
 * When this round's results will publish themselves, or null if never.
 *
 * Null when there is no following round, when the next round has no opening
 * time, or when the deadline is switched off.
 */
export async function autoPublishAt(
  repo: Repository,
  round: Round,
): Promise<Date | null> {
  const settings = await repo.systemSettings.get();
  const lead = settings.autoPublishLeadMinutes;
  if (!lead || lead <= 0) return null;

  const next = await nextRoundOf(repo, round);
  if (!next?.opensAt) return null;

  return new Date(new Date(next.opensAt).getTime() - lead * 60_000);
}
