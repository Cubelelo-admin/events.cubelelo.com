import type { FastifyInstance } from "fastify";
import type { Repository } from "../../db/repo";
import type { Realtime } from "../../sockets/realtime";
import { requireRole, requireAuth } from "../../auth/plugin";
import { createOwnershipChecks } from "../../auth/ownership";
import type { RoundStatus } from "@cubers/types";
import { isWcaFormat, scrambleCountForFormat, FORMAT_ATTEMPTS } from "@cubers/types";
import type { Round } from "../../db/types";
import { formatForRound, cutoffForRound, timeLimitForRound } from "../../lib/roundFormat";
import { effectiveRoundStatus } from "../../lib/statusUtils";
import { validateRoundTimes } from "../../lib/scheduleValidation";
import { parseAdvancementCriteria } from "../../lib/advancementCriteria";
import { recordScrambleFetch } from "../../lib/scrambleTiming";
import { scrambleLimiter, adminLimiter } from "../../lib/rateLimiter";
import { ensureScramblesGenerated } from "../../lib/roundLifecycle";
import { scheduleRoundJobs, cancelRoundJobs } from "../../lib/roundScheduler";

export async function registerRoundRoutes(
  app: FastifyInstance,
  repo: Repository,
  realtime: Realtime,
): Promise<void> {
  const adminOnly = { preHandler: requireRole(repo, "admin") };
  const adminOrMod = { preHandler: requireRole(repo, "admin", "moderator") };

  const { ownedCompByRound } = createOwnershipChecks(repo);

  // Round detail.
  app.get<{ Params: { id: string } }>(
    "/api/v1/rounds/:id",
    async (req, reply) => {
      const round = await repo.rounds.findById(req.params.id);
      if (!round) return reply.code(404).send({ error: "round_not_found" });
      const event = await repo.competitionEvents.findByRound(round.id);
      const set = await repo.scrambleSets.findByRound(round.id);
      return {
        id: round.id,
        roundNumber: round.roundNumber,
        status: effectiveRoundStatus(round),
        opensAt: round.opensAt ?? null,
        closesAt: round.closesAt ?? null,
        advancementCount: round.advancementCount ?? null,
        advancementCriteria: round.advancementCriteria ?? null,
        eventType: event?.eventType,
        videoRequired: round.videoRequired ?? false,
        scrambleLocked: Boolean(set?.lockedAt),
      };
    },
  );

  // Lobby snapshot.
  app.get<{ Params: { id: string } }>(
    "/api/v1/rounds/:id/lobby",
    async (req, reply) => {
      const round = await repo.rounds.findById(req.params.id);
      if (!round) return reply.code(404).send({ error: "round_not_found" });
      const event = await repo.competitionEvents.findByRound(round.id);
      const competition = event
        ? await repo.competitions.findById(event.competitionId)
        : undefined;
      return {
        round: {
          id: round.id,
          roundNumber: round.roundNumber,
          status: effectiveRoundStatus(round),
          opensAt: round.opensAt ?? null,
          closesAt: round.closesAt ?? null,
          eventType: event?.eventType ?? null,
          format: formatForRound(round, event?.eventType),
          attempts: FORMAT_ATTEMPTS[formatForRound(round, event?.eventType)],
          cutoffMs: cutoffForRound(round, event) ?? null,
          timeLimitMs: timeLimitForRound(round, event) ?? null,
        },
        competition: {
          id: competition?.id ?? null,
          title: competition?.title ?? null,
          rulesMd: competition?.rulesMd ?? null,
        },
        roster: await (async () => {
          const raw = await repo.roster.snapshot(round.id);
          const userMap = raw.length > 0 ? await repo.users.findByIds(raw.map((r) => r.userId)) : new Map();
          return raw.map((r) => {
            const u = userMap.get(r.userId);
            return { userId: r.userId, name: r.name, clId: u?.clId ?? undefined };
          });
        })(),
      };
    },
  );

  // Server-locked scramble delivery.
  app.get<{ Params: { id: string } }>(
    "/api/v1/rounds/:id/scramble",
    { preHandler: [scrambleLimiter, requireAuth] },
    async (req, reply) => {
      const round = await repo.rounds.findById(req.params.id);
      if (!round) return reply.code(404).send({ error: "round_not_found" });
      if (effectiveRoundStatus(round) !== "open") return reply.code(409).send({ error: "round_not_open" });

      let set = await repo.scrambleSets.findByRound(round.id);
      if (!set || !set.lockedAt) {
        try {
          await ensureScramblesGenerated(repo, round);
          set = await repo.scrambleSets.findByRound(round.id);
        } catch (err) {
          req.log.error(err, "Fallback scramble generation failed");
        }
        if (!set || !set.lockedAt) return reply.code(409).send({ error: "scrambles_not_ready" });
      }

      const user = await repo.users.findById(req.authClaims!.sub);
      if (!user) return reply.code(403).send({ error: "not_synced" });

      if (round.roundNumber > 1) {
        const advanced = await repo.advancements.isAdvanced(round.id, user.id);
        if (!advanced) return reply.code(403).send({ error: "not_shortlisted" });
      } else {
        const event = await repo.competitionEvents.findByRound(round.id);
        if (event) {
          const registered = await repo.registrations.isRegisteredForEvent(user.id, event.id);
          if (!registered) {
            return reply.code(403).send({ error: "not_registered_for_event" });
          }
        }
      }

      await recordScrambleFetch(round.id, req.authClaims!.sub);
      return { roundId: round.id, scrambles: set.scrambles };
    },
  );

  // View scrambles (admin only).
  app.get<{ Params: { id: string } }>(
    "/api/v1/admin/rounds/:id/scrambles",
    adminOrMod,
    async (req, reply) => {
      if (!(await ownedCompByRound(req, reply, req.params.id))) return;
      const round = await repo.rounds.findById(req.params.id);
      if (!round) return reply.code(404).send({ error: "round_not_found" });
      const set = await repo.scrambleSets.findByRound(round.id);
      if (!set) return { roundId: round.id, scrambles: [], locked: false };
      return {
        roundId: round.id, scrambles: set.scrambles,
        locked: Boolean(set.lockedAt), generatedAt: set.generatedAt, lockedAt: set.lockedAt,
      };
    },
  );

  // Regenerate scrambles for a round (admin only, only before competition starts).
  app.post<{ Params: { id: string } }>(
    "/api/v1/admin/rounds/:id/regenerate-scrambles",
    adminOrMod,
    async (req, reply) => {
      if (!(await ownedCompByRound(req, reply, req.params.id))) return;
      const round = await repo.rounds.findById(req.params.id);
      if (!round) return reply.code(404).send({ error: "round_not_found" });

      const event = await repo.competitionEvents.findByRound(round.id);
      if (!event) return reply.code(404).send({ error: "event_not_found" });

      const comp = await repo.competitions.findById(event.competitionId);
      if (!comp) return reply.code(404).send({ error: "competition_not_found" });

      const results = await repo.results.findByRound(round.id);
      if (results.length > 0) {
        return reply.code(409).send({ error: "round_has_results" });
      }

      const roundStatus = effectiveRoundStatus(round);
      if (roundStatus === "closed" || roundStatus === "advanced") {
        return reply.code(409).send({ error: "round_already_finished" });
      }

      const existing = await repo.scrambleSets.findByRound(round.id);
      const allowed = comp.status === "draft" || comp.status === "published"
        || (comp.status === "live" && (!existing || existing.scrambles.length === 0));
      if (!allowed) {
        return reply.code(409).send({ error: "scramble_regeneration_not_allowed" });
      }

      const { isEventId: checkEvent, generateScrambleSet } = await import("@cubers/scramble-core");
      if (!checkEvent(event.eventType)) return reply.code(400).send({ error: "invalid_event_type" });

      const now = new Date().toISOString();
      const scrambles = await generateScrambleSet(
        event.eventType,
        scrambleCountForFormat(formatForRound(round, event.eventType)),
      );
      await repo.scrambleSets.upsert({
        id: existing?.id ?? (await import("node:crypto")).randomUUID(),
        roundId: round.id,
        scrambles,
        generatedAt: now,
        lockedAt: now,
        lockedBy: undefined,
      });

      return { roundId: round.id, scrambles, generatedAt: now };
    },
  );

  // Cancel a round (admin only).
  app.post<{ Params: { id: string } }>(
    "/api/v1/admin/rounds/:id/cancel",
    adminOrMod,
    async (req, reply) => {
      if (!(await ownedCompByRound(req, reply, req.params.id))) return;
      const round = await repo.rounds.findById(req.params.id);
      if (!round) return reply.code(404).send({ error: "round_not_found" });
      const status = effectiveRoundStatus(round);
      if (status === "advanced") return reply.code(409).send({ error: "round_already_advanced" });
      if (status === "cancelled") return reply.code(409).send({ error: "round_already_cancelled" });

      const updated = await repo.rounds.update(round.id, { status: "cancelled" });
      if (!updated) return reply.code(404).send({ error: "round_not_found" });
      await cancelRoundJobs(round.id);
      realtime.emitRoundStatus(updated.id, "cancelled", updated.opensAt);
      return { id: updated.id, status: "cancelled" };
    },
  );

  // Reopen a closed or advanced round (admin only).
  app.post<{ Params: { id: string } }>(
    "/api/v1/admin/rounds/:id/reopen",
    adminOrMod,
    async (req, reply) => {
      if (!(await ownedCompByRound(req, reply, req.params.id))) return;
      const round = await repo.rounds.findById(req.params.id);
      if (!round) return reply.code(404).send({ error: "round_not_found" });
      const status = effectiveRoundStatus(round);
      if (status !== "closed" && status !== "advanced") {
        return reply.code(409).send({ error: "round_not_closed_or_advanced" });
      }

      if (status === "advanced") {
        const event = await repo.competitionEvents.findByRound(round.id);
        if (event) {
          const allRounds = await repo.rounds.findByCompetition(event.competitionId);
          const nextRound = allRounds.find(
            (r) => r.competitionEventId === round.competitionEventId && r.roundNumber === round.roundNumber + 1,
          );
          if (nextRound) {
            const nextResults = await repo.results.findByRound(nextRound.id);
            if (nextResults.length > 0) {
              return reply.code(409).send({ error: "next_round_has_results" });
            }
          }
        }
      }

      const now = new Date().toISOString();
      await repo.rounds.update(round.id, { status: "open", opensAt: now, closesAt: undefined });
      await cancelRoundJobs(round.id);
      realtime.emitRoundStatus(round.id, "open" as RoundStatus, now);
      return { id: round.id, status: "open" };
    },
  );

  // Update round settings (advancementCount, schedule, duration)
  app.patch<{
    Params: { id: string };
    Body: {
      advancementCount?: number;
      advancementCriteria?: { method: string; rankLimit?: number; timeLimitMs?: number; bestSingleMs?: number } | null;
      opensAt?: string | null;
      closesAt?: string | null;
      durationMinutes?: number;
      format?: string;
      cutoffMs?: number | null;
      timeLimitMs?: number | null;
    };
  }>("/api/v1/admin/rounds/:id", adminOrMod, async (req, reply) => {
    if (!(await ownedCompByRound(req, reply, req.params.id))) return;
    const { advancementCount, advancementCriteria, opensAt, closesAt, durationMinutes, format, cutoffMs, timeLimitMs } = req.body ?? {};
    const fields: Parameters<typeof repo.rounds.update>[1] = {};
    if (typeof advancementCount === "number") fields.advancementCount = advancementCount;

    if (format !== undefined) {
      if (!isWcaFormat(format)) return reply.code(400).send({ error: "invalid_format" });
      fields.format = format;
    }
    if (cutoffMs !== undefined) {
      if (cutoffMs !== null && (typeof cutoffMs !== "number" || cutoffMs < 1))
        return reply.code(400).send({ error: "invalid_cutoff" });
      fields.cutoffMs = cutoffMs ?? undefined;
    }
    if (timeLimitMs !== undefined) {
      if (timeLimitMs !== null && (typeof timeLimitMs !== "number" || timeLimitMs < 1))
        return reply.code(400).send({ error: "invalid_time_limit" });
      fields.timeLimitMs = timeLimitMs ?? undefined;
    }

    if (advancementCriteria !== undefined) {
      const parsed = parseAdvancementCriteria(advancementCriteria);
      if (!parsed.ok) return reply.code(400).send({ error: parsed.code });
      fields.advancementCriteria = parsed.criteria;
    }
    if (opensAt !== undefined) fields.opensAt = opensAt ?? undefined;
    if (closesAt !== undefined) fields.closesAt = closesAt ?? undefined;
    if (typeof durationMinutes === "number") fields.durationMinutes = durationMinutes;

    // Auto-compute closesAt from opensAt + durationMinutes when both are set
    if (fields.opensAt && fields.durationMinutes) {
      const open = new Date(fields.opensAt);
      fields.closesAt = new Date(open.getTime() + fields.durationMinutes * 60_000).toISOString();
    } else if (fields.durationMinutes && !fields.opensAt) {
      const round = await repo.rounds.findById(req.params.id);
      if (round?.opensAt) {
        const open = new Date(round.opensAt);
        fields.closesAt = new Date(open.getTime() + fields.durationMinutes * 60_000).toISOString();
      }
    }

    // Validate round times against competition and sibling rounds
    if (fields.opensAt !== undefined || fields.closesAt !== undefined) {
      const existing = await repo.rounds.findById(req.params.id);
      if (!existing) return reply.code(404).send({ error: "round_not_found" });
      const merged = { ...existing, ...fields };
      const event = await repo.competitionEvents.findByRound(existing.id);
      if (event) {
        const comp = await repo.competitions.findById(event.competitionId);
        const allRounds = await repo.rounds.findByCompetition(event.competitionId);
        const siblings = allRounds.filter((r) => r.competitionEventId === existing.competitionEventId);
        const result = validateRoundTimes(merged as Round, siblings, comp ?? {}, event.eventType);
        if (!result.valid) {
          return reply.code(400).send({ error: "schedule_validation_failed", errors: result.errors });
        }
      }
    }

    const updated = await repo.rounds.update(req.params.id, fields);
    if (!updated) return reply.code(404).send({ error: "round_not_found" });
    if (fields.opensAt !== undefined || fields.closesAt !== undefined) {
      await scheduleRoundJobs(updated);
    }
    return {
      id: updated.id, status: updated.status,
      advancementCount: updated.advancementCount,
      advancementCriteria: updated.advancementCriteria ?? null,
      opensAt: updated.opensAt, closesAt: updated.closesAt,
      durationMinutes: updated.durationMinutes,
      videoRequired: updated.videoRequired ?? false,
      format: updated.format ?? null,
      cutoffMs: updated.cutoffMs ?? null,
      timeLimitMs: updated.timeLimitMs ?? null,
    };
  });

  // ── Round criteria summary (read-only panel data for §3 Verification Hub) ──
  app.get<{ Params: { id: string } }>(
    "/api/v1/rounds/:id/criteria",
    async (req, reply) => {
      const round = await repo.rounds.findById(req.params.id);
      if (!round) return reply.code(404).send({ error: "round_not_found" });
      const event = await repo.competitionEvents.findByRound(round.id);
      const settings = await repo.systemSettings.get();

      return {
        roundId: round.id,
        roundNumber: round.roundNumber,
        eventType: event?.eventType ?? null,
        videoRequired: round.videoRequired ?? false,
        advancementCriteria: round.advancementCriteria ?? null,
        advancementCount: round.advancementCount ?? null,
        flagRuleDefaults: settings.flagRuleDefaults,
        recordReference: event ? (settings.recordReferences[event.eventType] ?? null) : null,
      };
    },
  );

  // ── Admin: toggle videoRequired on a round ──
  app.patch<{ Params: { id: string }; Body: { videoRequired: boolean } }>(
    "/api/v1/rounds/:id/video-required",
    adminOrMod,
    async (req, reply) => {
      const { videoRequired } = req.body ?? {};
      if (typeof videoRequired !== "boolean") {
        return reply.code(400).send({ error: "invalid_video_required" });
      }
      if (!(await ownedCompByRound(req, reply, req.params.id))) return;
      const round = await repo.rounds.findById(req.params.id);
      if (!round) return reply.code(404).send({ error: "round_not_found" });

      const updated = await repo.rounds.update(req.params.id, { videoRequired });
      return { id: updated!.id, videoRequired: updated!.videoRequired ?? false };
    },
  );
}
