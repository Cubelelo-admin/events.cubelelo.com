import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ao5, computeStats } from "@cubers/timer-core";
import type { Solve, SolvePenalty, FlagStatus } from "@cubers/types";
import type { Repository } from "../../db/repo";
import type { Result } from "../../db/types";
import type { Realtime } from "../../sockets/realtime";
import { requireAuth } from "../../auth/plugin";
import { effectiveRoundStatus } from "../../lib/statusUtils";
import { getScrambleFetchTime } from "../../lib/scrambleTiming";
import { submitLimiter } from "../../lib/rateLimiter";
import { recomputeRanks, recomputePersonalBest } from "../../lib/resultStats";
import { ANTICHEAT_THRESHOLDS, DEFAULT_ANTICHEAT_THRESHOLD } from "../../lib/eventConfig";
import { computeFlags } from "../../lib/flagEngine";
import { withAdvisoryLock } from "../../db/pool";
import { env } from "../../config/env";
import { setLeaderboardCache, getLeaderboardCache, type CachedLeaderboardEntry } from "../../lib/leaderboardCache";

const PENALTIES: SolvePenalty[] = ["none", "plus2", "dnf"];

const MIN_SOLVE_MS = 300;

const MEAN_OF_3_EVENTS = new Set(["666", "777", "333bf", "444bf", "555bf", "333mbf"]);

function solveCountForEvent(eventType: string): number {
  return MEAN_OF_3_EVENTS.has(eventType) ? 3 : 5;
}

function parseSolves(input: unknown, expectedCount: number): Solve[] | null {
  if (!Array.isArray(input)) return null;
  if (input.length !== expectedCount) return null;
  const solves: Solve[] = [];
  for (const raw of input) {
    if (
      typeof raw !== "object" ||
      raw === null ||
      typeof (raw as Solve).time_ms !== "number" ||
      !PENALTIES.includes((raw as Solve).penalty)
    ) {
      return null;
    }
    const timeMs = (raw as Solve).time_ms;
    const penalty = (raw as Solve).penalty;
    const r = raw as Record<string, unknown>;
    const inspPenalty = typeof r.inspectionPenalty === "string" && PENALTIES.includes(r.inspectionPenalty as SolvePenalty)
      ? (r.inspectionPenalty as SolvePenalty)
      : "none";
    if (penalty !== "dnf" && inspPenalty !== "dnf" && timeMs < MIN_SOLVE_MS) return null;
    if (timeMs < 0) return null;
    solves.push({
      time_ms: timeMs,
      inspectionPenalty: inspPenalty,
      penalty,
    });
  }
  return solves;
}

export async function registerResultRoutes(
  app: FastifyInstance,
  repo: Repository,
  realtime: Realtime,
): Promise<void> {
  app.post<{
    Params: { id: string };
    Body: { solves?: unknown; videoUrl?: string };
  }>(
    "/api/v1/rounds/:id/results",
    { preHandler: [submitLimiter, requireAuth] },
    async (req, reply) => {
      const [round, user] = await Promise.all([
        repo.rounds.findById(req.params.id),
        repo.users.findById(req.authClaims!.sub),
      ]);
      if (!round) return reply.code(404).send({ error: "round_not_found" });
      if (effectiveRoundStatus(round) !== "open") return reply.code(409).send({ error: "round_not_open" });
      if (!user) return reply.code(403).send({ error: "not_synced" });

      const event = await repo.competitionEvents.findByRound(round.id);

      if (round.roundNumber > 1) {
        const advanced = await repo.advancements.isAdvanced(round.id, user.id);
        if (!advanced) return reply.code(403).send({ error: "not_shortlisted" });
      } else if (event) {
        const registered = await repo.registrations.isRegisteredForEvent(user.id, event.id);
        if (!registered) return reply.code(403).send({ error: "not_registered_for_event" });
      }

      const existingResults = await repo.results.findByRound(round.id);

      if (existingResults.some((r) => r.userId === user.id)) {
        return reply.code(409).send({ error: "already_submitted" });
      }
      const expectedCount = solveCountForEvent(event?.eventType ?? "333");
      const solves = parseSolves(req.body?.solves, expectedCount);
      if (!solves) return reply.code(400).send({ error: "invalid_solves" });

      const videoUrl = req.body?.videoUrl?.trim() || null;
      if (videoUrl) {
        try {
          const parsed = new URL(videoUrl);
          const allowed = ["youtube.com", "youtu.be", "drive.google.com", "photos.google.com", "instagram.com", "streamable.com"];
          if (parsed.protocol !== "https:" || !allowed.some((h) => parsed.hostname === h || parsed.hostname.endsWith(`.${h}`))) {
            return reply.code(400).send({ error: "invalid_video_url" });
          }
        } catch {
          return reply.code(400).send({ error: "invalid_video_url" });
        }
      }

      // Anti-cheat: validate submission falls within round open/close window
      const now = Date.now();
      if (round.opensAt && now < new Date(round.opensAt).getTime()) {
        return reply.code(400).send({ error: "round_not_yet_open" });
      }
      if (round.closesAt && now > new Date(round.closesAt).getTime()) {
        return reply.code(400).send({ error: "round_closed" });
      }

      // Anti-cheat: total claimed solve time must not exceed wall-clock time since scramble fetch
      const fetchedAt = await getScrambleFetchTime(round.id, user.id);
      if (fetchedAt) {
        const totalClaimedMs = solves.reduce((sum, s) => sum + s.time_ms, 0);
        const wallClockMs = now - fetchedAt;
        if (totalClaimedMs > wallClockMs) {
          return reply.code(400).send({ error: "timing_mismatch" });
        }
        // If round has a close time, ensure scramble fetch happened after round opened
        if (round.opensAt && fetchedAt < new Date(round.opensAt).getTime()) {
          return reply.code(400).send({ error: "scramble_fetched_before_round_open" });
        }
      }

      const stats = computeStats(solves);
      const computedAo5 = ao5(solves);

      // §6 — Auto-flag engine: evaluate all configurable rules
      const eventType = event?.eventType ?? "333";
      let flagStatus: FlagStatus = "clean";

      // Legacy absolute-minimum anticheat (always runs, independent of admin config)
      if (computedAo5 !== null && computedAo5 !== Infinity) {
        const threshold = ANTICHEAT_THRESHOLDS[eventType] ?? DEFAULT_ANTICHEAT_THRESHOLD;
        if (computedAo5 < threshold) flagStatus = "flagged";
      }

      // Run the configurable flag engine
      const [settings, personalBest, roundResults] = await Promise.all([
        repo.systemSettings.get(),
        repo.personalBests.findByUser(user.id).then((pbs) =>
          pbs.find((pb) => pb.eventType === eventType) ?? null,
        ),
        repo.results.findByRound(round.id),
      ]);

      const flagReasons = computeFlags({
        bestSingleMs: stats.best_single_ms,
        ao5Ms: computedAo5,
        videoUrl,
        videoRequired: round.videoRequired ?? false,
        advancementCriteria: round.advancementCriteria,
        advancementCount: round.advancementCount,
        eventType,
        rules: settings.flagRuleDefaults,
        record: settings.recordReferences[eventType] ?? null,
        personalBest,
        roundResultCount: roundResults.length,
      });

      // If any rules fired, mark as flagged
      if (flagReasons.length > 0) flagStatus = "flagged";

      const result: Result = {
        id: randomUUID(),
        roundId: round.id,
        userId: user.id,  // UUID, matches FK in PG schema
        solves,
        bestSingleMs: stats.best_single_ms,
        ao5Ms: computedAo5,
        meanMs: stats.mean_ms,
        medianMs: stats.median_ms,
        stdMs: stats.std_ms,
        rank: null,
        videoUrl,
        flagStatus,
        flagReasons,
        submittedAt: new Date().toISOString(),
      };
      // Use advisory lock in PG mode for race-safe duplicate check;
      // fall back to repo-only path for mem-repo (tests / CI).
      if (env.DATABASE_URL) {
        const inserted = await withAdvisoryLock(`round:${round.id}`, async (client) => {
          const { rows: dupeCheck } = await client.query(
            "SELECT 1 FROM results WHERE round_id = $1 AND user_id = $2 LIMIT 1",
            [round.id, user.id],
          );
          if (dupeCheck.length > 0) return false;

          await client.query(
            `INSERT INTO results
               (id, round_id, user_id, solves_json, best_single_ms, ao5_ms, mean_ms,
                median_ms, std_ms, rank, video_url, flag_status, flag_reasons, verified_by, verified_at,
                submitted_at)
             VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16)`,
            [result.id, result.roundId, result.userId, JSON.stringify(result.solves),
             result.bestSingleMs, result.ao5Ms, result.meanMs, result.medianMs, result.stdMs,
             result.rank, result.videoUrl, result.flagStatus, JSON.stringify(result.flagReasons ?? []),
             null, null, result.submittedAt],
          );
          return true;
        });

        if (!inserted) {
          return reply.code(409).send({ error: "already_submitted" });
        }
      } else {
        // mem-repo path: dupe already checked above (existingResults), just create
        await repo.results.create(result);
      }

      const board = await recomputeRanks(repo, round.id);
      board.sort(
        (a, b) =>
          (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER),
      );

      const userIds = [...new Set(board.map((r) => r.userId))];
      const usersMap = await repo.users.findByIds(userIds);
      const enriched: CachedLeaderboardEntry[] = board.map((r) => {
        const u = usersMap.get(r.userId);
        return {
          id: r.id, userId: r.userId, userName: u?.name ?? r.userId, userClId: u?.clId ?? r.userId,
          ao5Ms: r.ao5Ms, bestSingleMs: r.bestSingleMs, rank: r.rank, flagStatus: r.flagStatus,
        };
      });
      await setLeaderboardCache(round.id, enriched);
      realtime.emitLeaderboard(round.id, enriched);

      // Compute personal bests after result submission
      if (event) {
        await recomputePersonalBest(repo, user.id, event.eventType);
      }

      return reply.code(201).send(result);
    },
  );

  // Update video URL (within deadline window after round closes)
  app.patch<{
    Params: { id: string };
    Body: { videoUrl?: string };
  }>(
    "/api/v1/results/:id/video",
    { preHandler: requireAuth },
    async (req, reply) => {
      const result = await repo.results.findById(req.params.id);
      if (!result) return reply.code(404).send({ error: "result_not_found" });

      const user = await repo.users.findById(req.authClaims!.sub);
      if (!user || result.userId !== user.id) return reply.code(403).send({ error: "not_your_result" });

      const round = await repo.rounds.findById(result.roundId);
      if (!round) return reply.code(404).send({ error: "round_not_found" });

      const event = await repo.competitionEvents.findById(round.competitionEventId);
      if (!event) return reply.code(404).send({ error: "event_not_found" });

      const comp = await repo.competitions.findById(event.competitionId);
      if (!comp) return reply.code(404).send({ error: "competition_not_found" });

      if (round.closesAt) {
        const deadlineMs = new Date(round.closesAt).getTime() + comp.videoDeadlineMinutes * 60 * 1000;
        if (Date.now() > deadlineMs) {
          return reply.code(409).send({ error: "video_deadline_passed" });
        }
      }

      const videoUrl = req.body?.videoUrl?.trim() || null;
      if (!videoUrl) return reply.code(400).send({ error: "video_url_required" });
      if (!videoUrl.startsWith("https://")) {
        return reply.code(400).send({ error: "invalid_video_url" });
      }

      await repo.results.update(req.params.id, { videoUrl });
      return { ok: true, videoUrl };
    },
  );

  // Leaderboard for a round — serves from Redis cache when available.
  app.get<{ Params: { id: string } }>(
    "/api/v1/rounds/:id/results",
    async (req) => {
      const cached = await getLeaderboardCache(req.params.id);
      if (cached) return cached;

      const board = await repo.results.findByRound(req.params.id);
      board.sort(
        (a, b) =>
          (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER),
      );
      const userIds = [...new Set(board.map((r) => r.userId))];
      const usersMap = await repo.users.findByIds(userIds);
      const enriched: CachedLeaderboardEntry[] = board.map((r) => {
        const u = usersMap.get(r.userId);
        return {
          id: r.id, userId: r.userId, userName: u?.name ?? r.userId, userClId: u?.clId ?? r.userId,
          ao5Ms: r.ao5Ms, bestSingleMs: r.bestSingleMs, rank: r.rank, flagStatus: r.flagStatus,
        };
      });
      await setLeaderboardCache(req.params.id, enriched);
      return enriched;
    },
  );

  // Verified results only (official leaderboard).
  app.get<{ Params: { id: string } }>(
    "/api/v1/rounds/:id/verified-results",
    async (req) => {
      const board = await repo.results.findByRound(req.params.id);
      const filtered = board
        .filter((r) => r.flagStatus === "clean" || r.flagStatus === "verified")
        .sort(
          (a, b) =>
            (a.rank ?? Number.MAX_SAFE_INTEGER) - (b.rank ?? Number.MAX_SAFE_INTEGER),
        );
      const userIds = [...new Set(filtered.map((r) => r.userId))];
      const usersMap = await repo.users.findByIds(userIds);
      return filtered.map((r) => {
        const u = usersMap.get(r.userId);
        return { ...r, userName: u?.name ?? r.userId, userClId: u?.clId ?? r.userId };
      });
    },
  );
}
