import { randomUUID } from "node:crypto";
import type { RoundStatus } from "@cubers/types";
import { generateScrambleSet, isEventId } from "@cubers/scramble-core";
import { scrambleCountForFormat, FORMAT_AVERAGE_STAT, type WcaFormat } from "@cubers/types";
import { formatForRound } from "./roundFormat";
import { compareForRanking, isTied, type RankableResult } from "./resultStats";
import type { Repository } from "../db/repo";
import type { Round, RoundAdvancement, AdvancementCriteria } from "../db/types";
import type { Realtime } from "../sockets/realtime";
import { recomputeRanks } from "./resultStats";
import { getRedis } from "./redis";

/**
 * Scrambles per round = one per attempt of the round's format, plus the WCA
 * extras (E1, E2) reserved for extra attempts under Regulation A5. Previously
 * fixed at 5, which over-generated for Mo3/Bo3 rounds and left no extras.
 */
function scrambleCountForRound(round: Round, eventType: string | undefined): number {
  return scrambleCountForFormat(formatForRound(round, eventType));
}

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
  const scrambles = await generateScrambleSet(
    event.eventType,
    scrambleCountForRound(round, event.eventType),
  );
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

  const [results, event] = await Promise.all([
    repo.results.findByRound(round.id),
    repo.competitionEvents.findByRound(round.id),
  ]);
  const format = formatForRound(round, event?.eventType);

  const eligible = results.filter(
    (r) => r.flagStatus !== "flagged" && r.flagStatus !== "disqualified",
  );

  const shortlisted = computeShortlist(eligible, criteria, legacyCount, format);

  if (shortlisted.length === 0) {
    if (eligible.length >= MIN_COMPETITORS_TO_ADVANCE) {
      console.warn(
        `⚠ Round ${round.id}: advancement criteria selected nobody from ${eligible.length} eligible results`,
      );
    }
    return;
  }

  const advanced: RoundAdvancement[] = shortlisted.map((r, i) => ({
    roundId: round.id,
    userId: r.userId,
    rank: i + 1,
  }));

  // Claim the round, then save. Both go through the repository: this used to be
  // raw SQL behind `withTransaction`, which needs a live Postgres pool, so
  // shortlisting threw on the in-memory backend and the whole persistence path
  // was untestable — only the pure `computeShortlist` had coverage.
  //
  // The claim is a compare-and-set, so two callers cannot advance the same round
  // twice. Saving is no longer in the same transaction as the claim, so a failed
  // save is compensated by handing the round back to `closed` rather than
  // leaving it `advanced` with no advancement list.
  const claimed = await repo.rounds.compareAndUpdateStatus(round.id, "closed", "advanced");
  if (!claimed) return;

  try {
    await repo.advancements.save(round.id, advanced);
  } catch (err) {
    await repo.rounds.compareAndUpdateStatus(round.id, "advanced", "closed");
    throw err;
  }

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

/**
 * Mark the competition completed once every event's final round has been
 * resolved. Exported so the publish route can use it rather than keeping a
 * fourth copy of the rule.
 */
export async function checkCompetitionCompletion(
  repo: Repository,
  realtime: Realtime,
  round: Round,
): Promise<void> {
  const event = await repo.competitionEvents.findByRound(round.id);
  if (!event) return;
  const comp = await repo.competitions.findById(event.competitionId);
  if (!comp || comp.status === "completed" || comp.status === "cancelled" || comp.status === "draft") return;

  // Archived events are not run — archiving only flips a flag on the event and
  // never touches its rounds, so they stay `pending` forever. Counting them here
  // meant any competition containing an archived event could never complete.
  const events = (await repo.competitionEvents.findByCompetition(comp.id)).filter(
    (e) => !e.archived,
  );
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

/**
 * WCA 9p1: at most 75% of the competitors in a round may advance. Applied to
 * every method, so a `rankLimit` larger than three quarters of the field is
 * clamped rather than advancing everyone.
 */
export const MAX_ADVANCEMENT_RATIO = 0.75;

/**
 * A round below this many competitors is effectively a final — advancing from it
 * is meaningless, and 9p1's ratio leaves almost nobody behind.
 */
export const MIN_COMPETITORS_TO_ADVANCE = 2;

/** The most competitors that may advance from a field of this size (9p1). */
export function advancementCap(fieldSize: number): number {
  return Math.floor(fieldSize * MAX_ADVANCEMENT_RATIO);
}

/**
 * Apply the 75% cap without splitting a tie.
 *
 * WCA 9p3: competitors tied at the advancement boundary either all advance or
 * all do not. Truncating at the cap could otherwise separate two competitors
 * with identical results based on nothing but array order — so when the cap
 * lands inside a tie, the whole tied group is dropped.
 */
function capWithoutSplittingTies<T extends RankableResult>(
  shortlisted: T[],
  fieldSize: number,
  format: WcaFormat,
): T[] {
  const cap = advancementCap(fieldSize);
  if (shortlisted.length <= cap) return shortlisted;

  let cut = cap;
  // Walk back while the last advancing competitor ties the first excluded one.
  while (cut > 0) {
    const last = shortlisted[cut - 1];
    const next = shortlisted[cut];
    if (!last || !next || !isTied(last, next, format)) break;
    cut--;
  }
  return shortlisted.slice(0, cut);
}

function applyMethod<T extends RankableResult>(
  criteria: AdvancementCriteria,
  sorted: T[],
  format: WcaFormat,
): T[] {
  if (criteria.method === "rank" && criteria.rankLimit) {
    const limit = criteria.rankLimit;
    // Include everyone tied with the competitor on the limit line, then let the
    // 75% cap decide whether that whole group fits.
    let end = Math.min(limit, sorted.length);
    while (end < sorted.length) {
      const last = sorted[end - 1];
      const next = sorted[end];
      if (!last || !next || !isTied(last, next, format)) break;
      end++;
    }
    return sorted.slice(0, end);
  }
  if (criteria.method === "time" && criteria.timeLimitMs) {
    const limit = criteria.timeLimitMs;
    const avgStat = FORMAT_AVERAGE_STAT[format];
    // Compare against the format's own average — reading ao5Ms for a Mo3 round
    // meant nobody ever cleared the threshold.
    return sorted.filter((r) => {
      const average = avgStat === "mean" ? r.meanMs : avgStat === "ao5" ? r.ao5Ms : null;
      return average !== null && average <= limit;
    });
  }
  if (criteria.method === "best_single" && criteria.bestSingleMs) {
    const limit = criteria.bestSingleMs;
    return sorted.filter((r) => r.bestSingleMs !== null && r.bestSingleMs <= limit);
  }
  return [];
}

/**
 * The shortlist for a round: sort by the format's ranking rules, apply the
 * configured criteria, then enforce the WCA 9p limits.
 */
export function computeShortlist<T extends RankableResult>(
  eligible: T[],
  criteria: AdvancementCriteria | undefined,
  legacyCount: number | undefined,
  format: WcaFormat,
): T[] {
  if (eligible.length < MIN_COMPETITORS_TO_ADVANCE) return [];

  const sorted = [...eligible].sort(compareForRanking(format));
  const selected = criteria
    ? applyMethod(criteria, sorted, format)
    : sorted.slice(0, legacyCount ?? 0);

  return capWithoutSplittingTies(selected, eligible.length, format);
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

  const [results, event] = await Promise.all([
    repo.results.findByRound(round.id),
    repo.competitionEvents.findByRound(round.id),
  ]);
  const format = formatForRound(round, event?.eventType);

  const eligible = results.filter(
    (r) => r.flagStatus !== "flagged" && r.flagStatus !== "disqualified",
  );

  const shortlisted = computeShortlist(eligible, criteria, legacyCount, format);

  const advanced: RoundAdvancement[] = shortlisted.map((r, i) => ({
    roundId: round.id,
    userId: r.userId,
    rank: i + 1,
  }));

  // Replaces the round's advancement list wholesale, same as the initial save.
  await repo.advancements.save(round.id, advanced);

  // If the DQ'd user submitted results in the next round, disqualify them
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
