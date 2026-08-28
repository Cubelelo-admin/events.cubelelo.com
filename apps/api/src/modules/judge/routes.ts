import type { FastifyInstance } from "fastify";
import type { FlagStatus, SolvePenalty } from "@cubers/types";
import type { Repository } from "../../db/repo";
import { requireRole } from "../../auth/plugin";
import { verifyResult, FLAG_ACTIONS } from "../../lib/resultVerification";
import { computePriority } from "../../lib/flagEngine";
import type { Realtime } from "../../sockets/realtime";


export async function registerJudgeRoutes(
  app: FastifyInstance,
  repo: Repository,
  realtime: Realtime,
): Promise<void> {
  const judgeOrAbove = { preHandler: requireRole(repo, "judge", "moderator", "admin") };

  // List assigned rounds for the current judge
  app.get("/api/v1/judge/assignments", judgeOrAbove, async (req) => {
    const judgeId = req.authClaims!.sub;
    const assignments = await repo.judgeAssignments.findByJudge(judgeId);

    return Promise.all(
      assignments.map(async (a) => {
        const round = await repo.rounds.findById(a.roundId);
        const event = round
          ? await repo.competitionEvents.findByRound(round.id)
          : undefined;
        const comp = event
          ? await repo.competitions.findById(event.competitionId)
          : undefined;

        const results = await repo.results.findByRound(a.roundId);
        const verifiedCount = results.filter(
          (r) => r.flagStatus === "verified" || r.verifiedBy,
        ).length;

        return {
          id: a.id,
          roundId: a.roundId,
          roundNumber: round?.roundNumber ?? null,
          roundStatus: round?.status ?? "unknown",
          eventType: event?.eventType ?? "unknown",
          competitionId: comp?.id ?? null,
          competitionTitle: comp?.title ?? "Unknown",
          assignedAt: a.assignedAt,
          totalResults: results.length,
          verifiedCount,
        };
      }),
    );
  });

  // All results for an assigned round
  app.get<{ Params: { roundId: string } }>(
    "/api/v1/judge/rounds/:roundId/results",
    judgeOrAbove,
    async (req, reply) => {
      const judgeId = req.authClaims!.sub;
      const judge = await repo.users.findById(judgeId);

      // Admin/moderator can access any round; judges only their assigned rounds
      if (judge?.role === "judge") {
        const assignments = await repo.judgeAssignments.findByJudge(judgeId);
        const isAssigned = assignments.some((a) => a.roundId === req.params.roundId);
        if (!isAssigned)
          return reply.code(403).send({ error: "not_assigned_to_round" });
      }

      const round = await repo.rounds.findById(req.params.roundId);
      if (!round) return reply.code(404).send({ error: "round_not_found" });

      const results = await repo.results.findByRound(round.id);
      const event = await repo.competitionEvents.findByRound(round.id);

      const peopleIds = [...new Set(results.flatMap((r) =>
        r.verifiedBy ? [r.userId, r.verifiedBy] : [r.userId],
      ))];
      const peopleMap = await repo.users.findByIds(peopleIds);

      return results.map((r) => {
        const user = peopleMap.get(r.userId);
        const verifier = r.verifiedBy ? peopleMap.get(r.verifiedBy) ?? null : null;
        return {
          id: r.id,
          userId: r.userId,
          userName: user?.name ?? r.userId,
          userClId: user?.clId ?? r.userId,
          eventType: event?.eventType ?? "unknown",
          roundNumber: round.roundNumber,
          solves: r.solves,
          judgeOverrides: r.judgeOverrides ?? null,
          bestSingleMs: r.bestSingleMs,
          ao5Ms: r.ao5Ms,
          videoUrl: r.videoUrl,
          flagStatus: r.flagStatus,
          flagReasons: r.flagReasons ?? [],
          priority: computePriority(r.flagReasons ?? []),
          verifiedBy: r.verifiedBy,
          verifiedByName: verifier?.name ?? null,
          verifiedAt: r.verifiedAt,
          verificationComment: r.verificationComment,
          submittedAt: r.submittedAt,
          rank: r.rank,
        };
      });
    },
  );

  // Judge verifies a result
  app.post<{
    Params: { id: string };
    Body: {
      action?: FlagStatus;
      reason?: string;
      comment?: string;
      /** Per-attempt penalties, parallel to the result's solves. null = unchanged. */
      solvePenalties?: (SolvePenalty | null)[];
    };
  }>("/api/v1/judge/results/:id/verify", judgeOrAbove, async (req, reply) => {
    const judgeId = req.authClaims!.sub;
    const result = await repo.results.findById(req.params.id);
    if (!result) return reply.code(404).send({ error: "result_not_found" });

    // The judge route's own door: judges are confined to the rounds they are
    // assigned to. Everything after this is shared with the admin route.
    const judge = await repo.users.findById(judgeId);
    if (judge?.role === "judge") {
      const assignments = await repo.judgeAssignments.findByJudge(judgeId);
      const isAssigned = assignments.some((a) => a.roundId === result.roundId);
      if (!isAssigned)
        return reply.code(403).send({ error: "not_assigned_to_round" });
    }

    const outcome = await verifyResult(repo, realtime, {
      result,
      action: req.body?.action,
      reason: req.body?.reason,
      comment: req.body?.comment,
      solvePenalties: req.body?.solvePenalties,
      actorId: judgeId,
      auditPrefix: "judge_result",
    });
    if (!outcome.ok) return reply.code(outcome.status).send({ error: outcome.error });

    return { id: result.id, flagStatus: outcome.flagStatus };
  });

  app.get<{ Params: { roundId: string } }>(
    "/api/v1/judge/rounds/:roundId/scrambles",
    judgeOrAbove,
    async (req, reply) => {
      const judgeId = req.authClaims!.sub;
      const judge = await repo.users.findById(judgeId);

      // Judges can only see scrambles for their assigned rounds
      if (judge?.role === "judge") {
        const assignments = await repo.judgeAssignments.findByJudge(judgeId);
        const isAssigned = assignments.some((a) => a.roundId === req.params.roundId);
        if (!isAssigned)
          return reply.code(403).send({ error: "not_assigned_to_round" });
      }

      const round = await repo.rounds.findById(req.params.roundId);
      if (!round) return reply.code(404).send({ error: "round_not_found" });

      const set = await repo.scrambleSets.findByRound(round.id);
      if (!set) return { roundId: round.id, scrambles: [], locked: false };
      return {
        roundId: round.id,
        scrambles: set.scrambles,
        locked: Boolean(set.lockedAt),
        generatedAt: set.generatedAt,
        lockedAt: set.lockedAt,
      };
    },
  );
}
