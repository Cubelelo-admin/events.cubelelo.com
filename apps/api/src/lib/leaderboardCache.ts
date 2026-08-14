import { getRedis } from "./redis";

const CACHE_TTL = 60;

export interface CachedLeaderboardEntry {
  id: string;
  userId: string;
  userName?: string;
  userClId?: string;
  ao5Ms: number | null;
  /** Mo3 rounds rank on the mean; `ao5Ms` is null for them, so both are carried. */
  meanMs: number | null;
  bestSingleMs: number | null;
  rank: number | null;
  flagStatus: string;
}

export async function setLeaderboardCache(roundId: string, board: CachedLeaderboardEntry[]): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;
  await redis.set(`lb:${roundId}`, JSON.stringify(board), "EX", CACHE_TTL);
}

/**
 * Drop a round's cached leaderboard.
 *
 * Must be called whenever standings change outside the submit path — a judge's
 * +2, DNF or disqualification. Without it the 60 s cache keeps serving the
 * pre-penalty board from `GET /rounds/:id/results` while the socket broadcast
 * shows the corrected one.
 */
export async function clearLeaderboardCache(roundId: string): Promise<void> {
  const redis = await getRedis();
  if (!redis) return;
  await redis.del(`lb:${roundId}`);
}

export async function getLeaderboardCache(roundId: string): Promise<CachedLeaderboardEntry[] | null> {
  const redis = await getRedis();
  if (!redis) return null;
  const raw = await redis.get(`lb:${roundId}`);
  if (!raw) return null;
  return JSON.parse(raw);
}
