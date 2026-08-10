import type { Repository } from "../db/repo";
import { recomputePersonalBest } from "./resultStats";

export interface TransferSummary {
  movedResults: number;
  skippedResults: number;
  movedRegistrations: number;
  skippedRegistrations: number;
  movedPayments: number;
}

/**
 * Move one user's competition history (results, registrations, payments) to
 * another user, then rebuild the receiver's personal bests for the affected
 * events. Used by the legacy-claim flow (HIGH-014) and admin account merge.
 *
 * Conflicts keep the receiver's own rows: a result in a round the receiver
 * already competed in, or a registration for a competition they are already
 * registered for, is skipped (unique constraints would reject it anyway).
 */
export async function transferUserData(
  repo: Repository,
  fromUserId: string,
  toUserId: string,
): Promise<TransferSummary> {
  const summary: TransferSummary = {
    movedResults: 0,
    skippedResults: 0,
    movedRegistrations: 0,
    skippedRegistrations: 0,
    movedPayments: 0,
  };

  const [fromResults, toResults] = await Promise.all([
    repo.results.findByUser(fromUserId),
    repo.results.findByUser(toUserId),
  ]);
  const takenRounds = new Set(toResults.map((r) => r.roundId));
  const affectedEvents = new Set<string>();

  const [fromRegs, toRegs] = await Promise.all([
    repo.registrations.findByUser(fromUserId),
    repo.registrations.findByUser(toUserId),
  ]);
  const takenComps = new Set(toRegs.map((r) => r.competitionId));

  for (const result of fromResults) {
    if (takenRounds.has(result.roundId)) {
      summary.skippedResults++;
      continue;
    }
    await repo.results.update(result.id, { userId: toUserId });
    summary.movedResults++;
    const event = await repo.competitionEvents.findByRound(result.roundId);
    if (event) affectedEvents.add(event.eventType);
  }

  for (const reg of fromRegs) {
    if (takenComps.has(reg.competitionId)) {
      summary.skippedRegistrations++;
      continue;
    }
    await repo.registrations.update(reg.id, { userId: toUserId });
    summary.movedRegistrations++;
  }

  const allPayments = await repo.payments.findAll();
  const fromPayments = allPayments.filter((p) => p.userId === fromUserId);
  for (const p of fromPayments) {
    await repo.payments.update(p.id, { userId: toUserId });
    summary.movedPayments++;
  }

  // Recompute PBs for all events the receiver now has results in,
  // not just transferred ones — skipped results may share events
  const allResults = await repo.results.findByUser(toUserId);
  const allRoundIds = [...new Set(allResults.map((r) => r.roundId))];
  const eventMap = await repo.competitionEvents.findByRounds(allRoundIds);
  const allEvents = new Set<string>();
  for (const ev of eventMap.values()) allEvents.add(ev.eventType);
  for (const eventType of allEvents) {
    await recomputePersonalBest(repo, toUserId, eventType);
  }

  return summary;
}
