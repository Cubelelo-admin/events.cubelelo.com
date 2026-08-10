import { randomUUID } from "node:crypto";
import type { RoundStatus } from "@cubers/types";
import { generateScrambleSet, isEventId } from "@cubers/scramble-core";
import type { Repository } from "../db/repo";
import type { Round, RoundAdvancement, AdvancementCriteria } from "../db/types";
import type { Realtime } from "../sockets/realtime";
import { withTransaction } from "../db/pool";
import { recomputeRanks } from "./resultStats";
import { getRedis } from "./redis";

const DEFAULT_SCRAMBLE_COUNT = 5;

/**
 * Generates and locks a round's scrambles if they don't exist yet.
 * Called automatically when a round opens — admins no longer trigger this by hand,
 * since scrambles must always be ready the instant competitors can access the round.
 */
export async function ensureScramblesGenerated(
  repo: Repository,
  round: Round,
): Promise<void> {
  const existing = await repo.scrambleSets.findByRound(round.id);
  if (existing?.lockedAt) return;

  const event = await repo.competitionEvents.findByRound(round.id);
  if (!event || !isEventId(event.eventType)) return;

  const now = new Date().toISOString();
  const scrambles = await generateScrambleSet(event.eventType, DEFAULT_SCRAMBLE_COUNT);
  await repo.scrambleSets.upsert({
    id: existing?.id ?? randomUUID(),
    roundId: round.id,
    scrambles,
    generatedAt: now,
    lockedAt: now,
    lockedBy: undefined,
  });
}

export async function closeRound(
  repo: Repository,
  realtime: Realtime,
  round: Round,
): Promise<void> {
  await repo.rounds.update(round.id, { status: "closed" });
  realtime.emitRoundStatus(round.id, "closed" as RoundStatus, round.opensAt);
}

export async function shortlistRound(
  repo: Repository,
  realtime: Realtime,
  round: Round,
): Promise<void> {
  const criteria = round.advancementCriteria;
  const legacyCount = round.advancementCount;

  if (!criteria && !legacyCount) return;

  const results = await repo.results.findByRound(round.id);
  const key = (n: number | null) => (n === null ? Number.POSITIVE_INFINITY : n);

  const eligible = results.filter(
    (r) => r.flagStatus !== "flagged" && r.flagStatus !== "disqualified",
  );

  const sorted = [...eligible].sort(
    (a, b) => key(a.ao5Ms) - key(b.ao5Ms) || key(a.bestSingleMs) - key(b.bestSingleMs),
  );

  let shortlisted: typeof eligible;

  if (criteria) {
    shortlisted = applyMethod(criteria, sorted);
  } else {
    shortlisted = sorted.slice(0, legacyCount!);
  }

  if (shortlisted.length === 0) return;

  const advanced: RoundAdvancement[] = shortlisted.map((r, i) => ({
    roundId: round.id,
    userId: r.userId,
    rank: i + 1,
  }));

  // CAS + save in a single transaction — if save fails, the status rolls back
  const claimed = await withTransaction(async (client) => {
    const { rowCount } = await client.query(
      "UPDATE rounds SET status = $1 WHERE id = $2 AND status = $3",
      ["advanced", round.id, "closed"],
    );
    if ((rowCount ?? 0) === 0) return false;

    await client.query("DELETE FROM round_advancements WHERE round_id = $1", [round.id]);
    for (const e of advanced) {
      await client.query(
        "INSERT INTO round_advancements (round_id, user_id, rank) VALUES ($1,$2,$3)",
        [e.roundId, e.userId, e.rank],
      );
    }
    return true;
  });
  if (!claimed) return;

  // Cache advancement set in Redis keyed by the DESTINATION round ID
  const redis = await getRedis();
  if (redis) {
    const allRounds = await repo.rounds.findByCompetition(
      (await repo.competitionEvents.findByRound(round.id))?.competitionId ?? "",
    );
    const destRound = allRounds.find(
      (r) => r.competitionEventId === round.competitionEventId && r.roundNumber === round.roundNumber + 1,
    );
    if (destRound) {
      const userIds = advanced.map((e) => e.userId);
      if (userIds.length > 0) {
        await redis.del(`adv:${destRound.id}`);
        await redis.sadd(`adv:${destRound.id}`, ...userIds);
        await redis.expire(`adv:${destRound.id}`, 86400);
      }
    }
  }

  realtime.emitRoundStatus(round.id, "advanced" as RoundStatus, round.opensAt);

  await checkCompetitionCompletion(repo, realtime, round);
}

async function checkCompetitionCompletion(
  repo: Repository,
  realtime: Realtime,
  round: Round,
): Promise<void> {
  const event = await repo.competitionEvents.findByRound(round.id);
  if (!event) return;
  const comp = await repo.competitions.findById(event.competitionId);
  if (!comp || comp.status === "completed" || comp.status === "cancelled" || comp.status === "draft") return;

  const events = await repo.competitionEvents.findByCompetition(comp.id);
  const rounds = await repo.rounds.findByCompetition(comp.id);

  for (const ev of events) {
    const eventRounds = rounds
      .filter((r) => r.competitionEventId === ev.id)
      .sort((a, b) => a.roundNumber - b.roundNumber);
    const finalRound = eventRounds[eventRounds.length - 1];
    if (!finalRound) return;

    if (finalRound.status !== "advanced" && finalRound.status !== "closed") return;
    const results = await repo.results.findByRound(finalRound.id);
    if (results.length === 0) return;
    if (results.some((r) => r.flagStatus === "flagged")) return;
  }

  await repo.competitions.update(comp.id, { status: "completed" });
  realtime.emitCompStatus(comp.id, "completed");
  console.log(`⏱ Competition ${comp.id} auto-completed (all final rounds resolved)`);
}

function applyMethod<T extends { ao5Ms: number | null; bestSingleMs: number | null }>(
  criteria: AdvancementCriteria,
  sorted: T[],
): T[] {
  if (criteria.method === "rank" && criteria.rankLimit) {
    return sorted.slice(0, criteria.rankLimit);
  }
  if (criteria.method === "time" && criteria.timeLimitMs) {
    const limit = criteria.timeLimitMs;
    return sorted.filter((r) => r.ao5Ms !== null && r.ao5Ms <= limit);
  }
  if (criteria.method === "best_single" && criteria.bestSingleMs) {
    const limit = criteria.bestSingleMs;
    return sorted.filter((r) => r.bestSingleMs !== null && r.bestSingleMs <= limit);
  }
  return [];
}

/**
 * Re-derive the advancement list for a round that is already "advanced".
 * Called when a result is disqualified post-advancement so the shortlist
 * reflects the corrected standings and the DQ'd user loses next-round access.
 */
export async function reshortlistAdvancedRound(
  repo: Repository,
  realtime: Realtime,
  round: Round,
  disqualifiedUserId: string,
): Promise<void> {
  if (round.status !== "advanced") return;
  const criteria = round.advancementCriteria;
  const legacyCount = round.advancementCount;
  if (!criteria && !legacyCount) return;

  const results = await repo.results.findByRound(round.id);
  const key = (n: number | null) => (n === null ? Number.POSITIVE_INFINITY : n);

  const eligible = results.filter(
    (r) => r.flagStatus !== "flagged" && r.flagStatus !== "disqualified",
  );
  const sorted = [...eligible].sort(
    (a, b) => key(a.ao5Ms) - key(b.ao5Ms) || key(a.bestSingleMs) - key(b.bestSingleMs),
  );

  const shortlisted = criteria
    ? applyMethod(criteria, sorted)
    : sorted.slice(0, legacyCount!);

  const advanced: RoundAdvancement[] = shortlisted.map((r, i) => ({
    roundId: round.id,
    userId: r.userId,
    rank: i + 1,
  }));

  await withTransaction(async (client) => {
    await client.query("DELETE FROM round_advancements WHERE round_id = $1", [round.id]);
    for (const e of advanced) {
      await client.query(
        "INSERT INTO round_advancements (round_id, user_id, rank) VALUES ($1,$2,$3)",
        [e.roundId, e.userId, e.rank],
      );
    }
  });

  // If the DQ'd user submitted results in the next round, disqualify them
  const event = await repo.competitionEvents.findByRound(round.id);
  if (event) {
    const allRounds = await repo.rounds.findByCompetition(event.competitionId);
    const nextRound = allRounds.find(
      (r) => r.competitionEventId === round.competitionEventId && r.roundNumber === round.roundNumber + 1,
    );
    if (nextRound) {
      const nextResults = await repo.results.findByRound(nextRound.id);
      const dqResult = nextResults.find((r) => r.userId === disqualifiedUserId);
      if (dqResult && dqResult.flagStatus !== "disqualified") {
        await repo.results.update(dqResult.id, {
          flagStatus: "disqualified",
          verifiedBy: undefined,
          verifiedAt: new Date().toISOString(),
        });
        await recomputeRanks(repo, nextRound.id);
        realtime.emitLeaderboard(nextRound.id, await repo.results.findByRound(nextRound.id));
      }
    }
  }
}

// Legacy wrapper for backward compatibility during transition
export async function closeAndShortlist(
  repo: Repository,
  realtime: Realtime,
  round: Round,
): Promise<void> {
  await closeRound(repo, realtime, round);

  if (!round.advancementCriteria && round.advancementCount && round.advancementCount > 0) {
    const freshRound = await repo.rounds.findById(round.id);
    if (freshRound) await shortlistRound(repo, realtime, freshRound);
  }
}
