import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { isEventId } from "@cubers/scramble-core";
import type { CompStatus, CompType, FlagStatus, SolvePenalty } from "@cubers/types";
import { defaultFormatForEvent } from "@cubers/types";
import type { Repository } from "../../db/repo";
import { type Competition, type CompetitionEvent, type Round, type AuditLogEntry, type Announcement, type PromoCode, type Appeal, type RankTier, type Banner, type FaqEntry, type ContentPage, type PersonalBest, sanitizeUser } from "../../db/types";
import type { Realtime } from "../../sockets/realtime";
import { requireRole, requireAuth } from "../../auth/plugin";
import { promoLimiter } from "../../lib/rateLimiter";
import {
  createOwnershipChecks,
  isAdmin as isAdminRole,
  isStaff,
  isSuperAdmin,
} from "../../auth/ownership";
import { effectiveCompStatus, effectiveRoundStatus } from "../../lib/statusUtils";
import {
  isActiveRegistration,
  isPaidCompetition,
  hasResultsInCompetition,
} from "../../lib/registrationStatus";
import { shortlistRound, reshortlistAdvancedRound, ensureScramblesGenerated } from "../../lib/roundLifecycle";
import { validateCompetitionSchedule, validateScheduleFields, validateForPublish } from "../../lib/scheduleValidation";
import {
  applyCompetitionFields,
  buildRoundFields,
  clampRoundCount,
  parseRuleSetIds,
  COMP_TYPES,
  type CompetitionEventInput,
  type CompetitionInput,
  type CreateOnlyInput,
  type RoundFields,
} from "./competitionInput";
import { collectCertificateData, generateCertificatePDF } from "../../lib/certificate";
import { emailService, sendBulk, roundNotificationEmail, bulkEmail, migrationEmail, staffWelcomeEmail } from "../../lib/email";
import { applyResultOverride, parseSolvePenalties, requiresAttemptPenalties } from "../../lib/resultStats";
import { scheduleRoundJobs } from "../../lib/roundScheduler";
import { transferUserData } from "../../lib/accountTransfer";
import { ZipArchive } from "archiver";
import { ANTICHEAT_THRESHOLDS, DEFAULT_ANTICHEAT_THRESHOLD } from "../../lib/eventConfig";
import { computeFlags, computePriority } from "../../lib/flagEngine";
import { getQueue } from "../../lib/jobQueue";

/** Video deadline applied when a competition does not set its own. */
const DEFAULT_VIDEO_DEADLINE_MINUTES = 1440;

const COMP_STATUSES: CompStatus[] = [
  "draft", "published", "registration_open", "registration_closed",
  "cancelled", "live", "results_pending", "completed",
];
const FLAG_ACTIONS: FlagStatus[] = ["verified", "plus2", "dnf", "disqualified"];

export async function registerAdminRoutes(
  app: FastifyInstance,
  repo: Repository,
  realtime: Realtime,
): Promise<void> {
  const adminOnly = { preHandler: requireRole(repo, "admin") };
  const adminOrMod = { preHandler: requireRole(repo, "admin", "moderator") };

  // ── Helpers: moderator ownership checks ──────────────────────────────────

  const { ownedComp, ownedCompByRound, ownedCompByEvent, ownedCompByResult } =
    createOwnershipChecks(repo);

  /** Check if the caller is admin (not just moderator). */
  async function isAdmin(req: import("fastify").FastifyRequest): Promise<boolean> {
    return isAdminRole(await repo.users.findById(req.authClaims!.sub));
  }

  /**
   * Validate a `ruleSetIds` payload and confirm every id exists.
   *
   * Checked before anything is written, so an unknown id returns 400 rather than
   * surfacing as a foreign-key violation mid-write.
   */
  async function resolveRuleSetIds(
    raw: unknown,
  ): Promise<{ ok: true; ids: string[] | undefined } | { ok: false; code: string }> {
    const parsed = parseRuleSetIds(raw);
    if (parsed === "invalid") return { ok: false, code: "invalid_rule_set_ids" };
    if (parsed === undefined) return { ok: true, ids: undefined };
    if (parsed.length > 0) {
      const found = await repo.ruleSets.findByIds(parsed);
      if (found.size !== parsed.length) return { ok: false, code: "rule_set_not_found" };
    }
    return { ok: true, ids: parsed };
  }

  // ── Competitions ──────────────────────────────────────────────────────────

  app.post<{ Body: CompetitionInput & CreateOnlyInput }>(
    "/api/v1/admin/competitions",
    adminOrMod,
    async (req, reply) => {
      const body = req.body ?? {};
      const { saveAsDraft } = body;

      const title = typeof body.title === "string" ? body.title.trim() : "";
      if (!title) return reply.code(400).send({ error: "missing_title" });

      const existing = await repo.competitions.findByTitle(title);
      if (existing) return reply.code(409).send({ error: "duplicate_title" });

      const user = await repo.users.findById(req.authClaims!.sub);
      const now = new Date().toISOString();
      const compId = randomUUID();

      // Same reducer the PATCH handler uses, so any field settable on one
      // endpoint is settable on the other.
      const fields: Partial<Competition> = {};
      const applied = applyCompetitionFields(body, fields, { isAdmin: isAdminRole(user) });
      if (!applied.ok) return reply.code(applied.status).send({ error: applied.code });

      const ruleSets = await resolveRuleSetIds(body.ruleSetIds);
      if (!ruleSets.ok) return reply.code(400).send({ error: ruleSets.code });

      const competition: Competition = {
        id: compId,
        title,
        type: fields.type ?? "free",
        status: "draft",
        baseFee: fields.baseFee ?? 0,
        perEventFee: fields.perEventFee ?? 0,
        featured: fields.featured ?? false,
        videoDeadlineMinutes: fields.videoDeadlineMinutes ?? DEFAULT_VIDEO_DEADLINE_MINUTES,
        ...fields,
        createdBy: user?.id,
        createdAt: now,
      };

      const eventSpecs: CompetitionEventInput[] = body.events?.length
        ? body.events
        : body.eventType
          ? [{ eventType: body.eventType, roundCount: body.roundCount }]
          : [];

      // Reject the whole request on any invalid event type. Previously only an
      // all-invalid array 400'd, so a mixed array silently dropped entries.
      const invalid = eventSpecs.find((s) => !s.eventType || !isEventId(s.eventType));
      if (invalid) return reply.code(400).send({ error: "invalid_event_type" });

      // Validate every round's criteria before writing anything, so a bad spec
      // cannot leave a half-built competition behind.
      const plans: { spec: CompetitionEventInput; rounds: number; roundFields: RoundFields[] }[] = [];
      for (const spec of eventSpecs) {
        const rounds = clampRoundCount(spec.roundCount);
        const roundFields: RoundFields[] = [];
        for (let i = 1; i <= rounds; i++) {
          const built = buildRoundFields(spec, i, rounds);
          if (!built.ok) return reply.code(400).send({ error: built.code });
          roundFields.push(built.fields);
        }
        plans.push({ spec, rounds, roundFields });
      }

      await repo.competitions.create(competition);
      if (ruleSets.ids) await repo.competitionRuleSets.replace(compId, ruleSets.ids);

      for (const { spec, rounds, roundFields } of plans) {
        const event: CompetitionEvent = {
          id: randomUUID(),
          competitionId: compId,
          eventType: spec.eventType,
          roundCount: rounds,
          cutoffMs: spec.cutoffMs,
          timeLimitMs: spec.timeLimitMs,
          fee: spec.fee,
          archived: spec.archived ?? false,
        };
        await repo.competitionEvents.create(event);

        for (let i = 1; i <= rounds; i++) {
          const round: Round = {
            id: randomUUID(),
            competitionEventId: event.id,
            roundNumber: i,
            status: "pending",
            ...roundFields[i - 1]!,
          };
          await repo.rounds.create(round);
          if (round.opensAt || round.closesAt) await scheduleRoundJobs(round);
        }
      }

      // saveAsDraft = true keeps it as draft (default). If false, publish now —
      // through the same gate as PATCH {status:"published"}, which this path
      // used to bypass entirely.
      if (saveAsDraft === false) {
        const allRounds = await repo.rounds.findByCompetition(compId);
        const allEvents = await repo.competitionEvents.findByCompetition(compId);
        const check = validateForPublish(competition, allRounds, allEvents);
        if (!check.valid) {
          return reply.code(400).send({
            error: competition.bannerUrl ? "schedule_validation_failed" : "banner_required",
            errors: check.errors,
          });
        }
        await repo.competitions.update(compId, { status: "published", publishedBy: req.authClaims!.sub });
        for (const round of allRounds) {
          await ensureScramblesGenerated(repo, round);
        }
      }

      return reply.code(201).send({ id: compId, status: saveAsDraft === false ? "published" : "draft" });
    },
  );

  // Edit competition fields (includes featured toggle and status)
  app.patch<{
    Params: { id: string };
    Body: CompetitionInput & { status?: CompStatus; cancellationReason?: string };
  }>("/api/v1/admin/competitions/:id", adminOrMod, async (req, reply) => {
    if (!(await ownedComp(req, reply, req.params.id))) return;
    const body = req.body ?? {};
    const { status, cancellationReason } = body;

    const fields: Partial<Competition> = {};

    if (typeof body.title === "string") {
      const dup = await repo.competitions.findByTitle(body.title.trim());
      if (dup && dup.id !== req.params.id)
        return reply.code(409).send({ error: "duplicate_title" });
    }

    // Same reducer the create handler uses.
    const caller = await repo.users.findById(req.authClaims!.sub);
    const applied = applyCompetitionFields(body, fields, { isAdmin: isAdminRole(caller) });
    if (!applied.ok) return reply.code(applied.status).send({ error: applied.code });

    const ruleSets = await resolveRuleSetIds(body.ruleSetIds);
    if (!ruleSets.ok) return reply.code(400).send({ error: ruleSets.code });

    if (status && COMP_STATUSES.includes(status)) fields.status = status;
    if (typeof cancellationReason === "string") fields.cancellationReason = cancellationReason;

    if (status === "cancelled" && !cancellationReason?.trim()) {
      return reply.code(400).send({ error: "cancellation_reason_required" });
    }

    // Soft-validate schedule ordering on any schedule field update
    const hasScheduleChange = fields.registrationOpensAt !== undefined
      || fields.registrationDeadline !== undefined
      || fields.startsAt !== undefined
      || fields.endsAt !== undefined;

    if (hasScheduleChange || fields.status === "published") {
      const comp = await repo.competitions.findById(req.params.id);
      if (!comp) return reply.code(404).send({ error: "competition_not_found" });
      const merged = { ...comp, ...fields };

      if (hasScheduleChange && fields.status !== "published") {
        const soft = validateScheduleFields(merged);
        if (!soft.valid) {
          return reply.code(400).send({ error: "schedule_validation_failed", errors: soft.errors });
        }
      }

      if (fields.status === "published") {
        const rounds = await repo.rounds.findByCompetition(req.params.id);
        const events = await repo.competitionEvents.findByCompetition(req.params.id);
        const result = validateForPublish(merged, rounds, events);
        if (!result.valid) {
          return reply.code(400).send({
            error: merged.bannerUrl ? "schedule_validation_failed" : "banner_required",
            errors: result.errors,
          });
        }
      }
    }

    if (fields.status === "published") {
      (fields as Record<string, unknown>).publishedBy = req.authClaims!.sub;
    }
    if (ruleSets.ids) await repo.competitionRuleSets.replace(req.params.id, ruleSets.ids);

    const updated = await repo.competitions.update(req.params.id, fields);

    if (!updated) return reply.code(404).send({ error: "competition_not_found" });

    // Sync events and rounds when events array is provided
    const eventSpecs = req.body?.events;
    if (eventSpecs && eventSpecs.length > 0) {
      const existingEvents = await repo.competitionEvents.findByCompetition(req.params.id);
      const existingRounds = await repo.rounds.findByCompetition(req.params.id);

      // Reject any invalid event type outright rather than skipping it silently.
      const badSpec = eventSpecs.find((s) => !s.eventType || !isEventId(s.eventType));
      if (badSpec) return reply.code(400).send({ error: "invalid_event_type" });

      // Validate every round's criteria up front so a bad spec cannot leave the
      // competition half-reconciled.
      const plans: { spec: CompetitionEventInput; rounds: number; roundFields: RoundFields[] }[] = [];
      for (const spec of eventSpecs) {
        const rounds = clampRoundCount(spec.roundCount);
        const roundFields: RoundFields[] = [];
        for (let i = 1; i <= rounds; i++) {
          const built = buildRoundFields(spec, i, rounds);
          if (!built.ok) return reply.code(400).send({ error: built.code });
          roundFields.push(built.fields);
        }
        plans.push({ spec, rounds, roundFields });
      }

      for (const { spec, rounds, roundFields } of plans) {
        // Match archived events too. Filtering them out meant re-adding an
        // archived event type inserted a duplicate row, violating
        // `unique (competition_id, event_type)` as an unhandled 500.
        const existing = existingEvents.find((e) => e.eventType === spec.eventType);
        if (existing) {
          const evFields: Partial<CompetitionEvent> = {};
          if (spec.cutoffMs !== undefined) evFields.cutoffMs = spec.cutoffMs;
          if (spec.timeLimitMs !== undefined) evFields.timeLimitMs = spec.timeLimitMs;
          if (spec.fee !== undefined) evFields.fee = spec.fee;
          if (rounds !== existing.roundCount) evFields.roundCount = rounds;
          // An explicit `archived` wins, so the events array can archive as well
          // as un-archive. Otherwise, re-adding an archived event un-archives it.
          if (spec.archived !== undefined) evFields.archived = spec.archived;
          else if (existing.archived) evFields.archived = false;
          if (Object.keys(evFields).length > 0) {
            await repo.competitionEvents.update(existing.id, evFields);
          }

          const eventRounds = existingRounds.filter((r) => r.competitionEventId === existing.id);

          for (let i = 1; i <= rounds; i++) {
            const planned = roundFields[i - 1]!;
            const er = eventRounds.find((r) => r.roundNumber === i);

            if (er) {
              // Existing round: only schedule and criteria are reconciled here.
              // Cutoff, time limit and format stay under the round's own control
              // (see `applyToExistingRounds` below) so a per-round override is
              // not silently clobbered by an event-level edit.
              const rFields: Partial<Round> = {};
              if (planned.opensAt) rFields.opensAt = planned.opensAt;
              if (planned.durationMinutes) {
                rFields.durationMinutes = planned.durationMinutes;
                if (planned.closesAt) rFields.closesAt = planned.closesAt;
              }
              if (spec.roundCriteria?.[i - 1] !== undefined) {
                rFields.advancementCriteria = planned.advancementCriteria;
              }
              // Explicit opt-in to push the event's cutoff / time limit down.
              if (spec.applyToExistingRounds) {
                if (spec.cutoffMs !== undefined) rFields.cutoffMs = spec.cutoffMs;
                if (spec.timeLimitMs !== undefined) rFields.timeLimitMs = spec.timeLimitMs;
              }
              if (Object.keys(rFields).length > 0) await repo.rounds.update(er.id, rFields);
              continue;
            }

            const round: Round = {
              id: randomUUID(),
              competitionEventId: existing.id,
              roundNumber: i,
              status: "pending",
              ...planned,
            };
            await repo.rounds.create(round);
            if (round.opensAt || round.closesAt) await scheduleRoundJobs(round);
          }

          // Delete excess rounds (only if no results)
          for (const r of eventRounds) {
            if (r.roundNumber > rounds) {
              const results = await repo.results.findByRound(r.id);
              if (results.length === 0) {
                await repo.rounds.delete(r.id);
              }
            }
          }
        } else {
          // Create new event + rounds
          const event: CompetitionEvent = {
            id: randomUUID(),
            competitionId: req.params.id,
            eventType: spec.eventType,
            roundCount: rounds,
            cutoffMs: spec.cutoffMs,
            timeLimitMs: spec.timeLimitMs,
            fee: spec.fee,
            archived: spec.archived ?? false,
          };
          await repo.competitionEvents.create(event);

          for (let i = 1; i <= rounds; i++) {
            const round: Round = {
              id: randomUUID(),
              competitionEventId: event.id,
              roundNumber: i,
              status: "pending",
              // `advancementCount` used to be omitted on this branch only.
              ...roundFields[i - 1]!,
            };
            await repo.rounds.create(round);
            if (round.opensAt || round.closesAt) await scheduleRoundJobs(round);
          }
        }
      }
    }

    // Pre-generate scrambles for every round AFTER events/rounds are synced
    if (fields.status === "published") {
      const allRounds = await repo.rounds.findByCompetition(req.params.id);
      for (const round of allRounds) {
        await ensureScramblesGenerated(repo, round);
      }
    }

    return {
      id: updated.id, title: updated.title,
      status: effectiveCompStatus(updated),
      registrationOpensAt: updated.registrationOpensAt ?? null,
      registrationDeadline: updated.registrationDeadline ?? null,
      startsAt: updated.startsAt ?? null,
      endsAt: updated.endsAt ?? null,
      featured: updated.featured,
      registrationLimit: updated.registrationLimit ?? null,
      cancellationReason: updated.cancellationReason ?? null,
    };
  });

  // Upload competition desktop banner
  app.post<{ Params: { id: string } }>(
    "/api/v1/admin/competitions/:id/upload-banner",
    adminOrMod,
    async (req, reply) => {
      const comp = await ownedComp(req, reply, req.params.id);
      if (!comp) return;

      const data = await req.file();
      if (!data) return reply.code(400).send({ error: "no_file" });

      const ext = data.filename.split(".").pop()?.toLowerCase() ?? "png";
      if (!["jpg", "jpeg", "png", "gif", "webp"].includes(ext))
        return reply.code(400).send({ error: "invalid_file_type" });

      const chunks: Buffer[] = [];
      for await (const chunk of data.file) chunks.push(chunk as Buffer);
      const buffer = Buffer.concat(chunks);

      // @fastify/multipart enforces its 5 MB limit by *truncating* the stream,
      // not by throwing. Checking `buffer.length` therefore never fires — the
      // buffer is capped at the limit — and an oversized photo used to be stored
      // as a corrupt, half-written image with a 200 response. `truncated` is the
      // only signal that the file was cut short.
      if (data.file.truncated)
        return reply.code(413).send({ error: "file_too_large_max_5mb" });

      const { getStorage } = await import("../../lib/storage");
      const filename = `competitions/${comp.id}_banner_${randomUUID().slice(0, 8)}.${ext}`;
      const storage = getStorage();
      const bannerUrl = await storage.upload(filename, buffer, `image/${ext === "jpg" ? "jpeg" : ext}`);

      const updated = await repo.competitions.update(comp.id, { bannerUrl });
      return { bannerUrl: updated?.bannerUrl ?? bannerUrl };
    },
  );

  // Upload competition mobile banner
  app.post<{ Params: { id: string } }>(
    "/api/v1/admin/competitions/:id/upload-mobile-banner",
    adminOrMod,
    async (req, reply) => {
      const comp = await ownedComp(req, reply, req.params.id);
      if (!comp) return;

      const data = await req.file();
      if (!data) return reply.code(400).send({ error: "no_file" });

      const ext = data.filename.split(".").pop()?.toLowerCase() ?? "png";
      if (!["jpg", "jpeg", "png", "gif", "webp"].includes(ext))
        return reply.code(400).send({ error: "invalid_file_type" });

      const chunks: Buffer[] = [];
      for await (const chunk of data.file) chunks.push(chunk as Buffer);
      const buffer = Buffer.concat(chunks);

      // @fastify/multipart enforces its 5 MB limit by *truncating* the stream,
      // not by throwing. Checking `buffer.length` therefore never fires — the
      // buffer is capped at the limit — and an oversized photo used to be stored
      // as a corrupt, half-written image with a 200 response. `truncated` is the
      // only signal that the file was cut short.
      if (data.file.truncated)
        return reply.code(413).send({ error: "file_too_large_max_5mb" });

      const { getStorage } = await import("../../lib/storage");
      const filename = `competitions/${comp.id}_mobile_banner_${randomUUID().slice(0, 8)}.${ext}`;
      const storage = getStorage();
      const mobileBannerUrl = await storage.upload(filename, buffer, `image/${ext === "jpg" ? "jpeg" : ext}`);

      const updated = await repo.competitions.update(comp.id, { mobileBannerUrl });
      return { mobileBannerUrl: updated?.mobileBannerUrl ?? mobileBannerUrl };
    },
  );

  // Duplicate a competition
  app.post<{
    Params: { id: string };
    Body: { reuseScrambles?: boolean; type?: CompType; copySchedule?: boolean };
  }>("/api/v1/admin/competitions/:id/duplicate", adminOrMod, async (req, reply) => {
    const source = await ownedComp(req, reply, req.params.id);
    if (!source) return;

    const user = await repo.users.findById(req.authClaims!.sub);
    const now = new Date().toISOString();
    const overrideType =
      req.body?.type && COMP_TYPES.includes(req.body.type) ? req.body.type : source.type;
    const newCompId = randomUUID();

    const copySched = req.body?.copySchedule !== false;
    let dupTitle = `${source.title} (copy)`;
    let attempt = 1;
    while (await repo.competitions.findByTitle(dupTitle)) {
      attempt++;
      dupTitle = `${source.title} (copy ${attempt})`;
    }
    const comp: Competition = {
      id: newCompId,
      title: dupTitle,
      type: overrideType,
      status: "draft",
      description: source.description,
      rulesMd: source.rulesMd,
      baseFee: overrideType === "free" ? 0 : source.baseFee,
      perEventFee: overrideType === "free" ? 0 : source.perEventFee,
      registrationDeadline: copySched ? source.registrationDeadline : undefined,
      registrationOpensAt: copySched ? source.registrationOpensAt : undefined,
      startsAt: copySched ? source.startsAt : undefined,
      endsAt: copySched ? source.endsAt : undefined,
      featured: false,
      videoDeadlineMinutes: source.videoDeadlineMinutes,
      registrationLimit: source.registrationLimit,
      createdBy: user?.id,
      createdAt: now,
    };
    await repo.competitions.create(comp);

    const sourceEvents = await repo.competitionEvents.findByCompetition(source.id);

    for (const srcEvent of sourceEvents) {
      const event: CompetitionEvent = {
        id: randomUUID(),
        competitionId: newCompId,
        eventType: srcEvent.eventType,
        roundCount: srcEvent.roundCount,
        cutoffMs: srcEvent.cutoffMs,
        timeLimitMs: srcEvent.timeLimitMs,
        fee: srcEvent.fee,
      };
      await repo.competitionEvents.create(event);

      const srcRounds = (await repo.rounds.findByCompetition(source.id))
        .filter((r) => r.competitionEventId === srcEvent.id)
        .sort((a, b) => a.roundNumber - b.roundNumber);

      for (const srcRound of srcRounds) {
        const round: Round = {
          id: randomUUID(),
          competitionEventId: event.id,
          roundNumber: srcRound.roundNumber,
          status: "pending",
          format: srcRound.format,
          cutoffMs: srcRound.cutoffMs,
          timeLimitMs: srcRound.timeLimitMs,
          advancementCount: srcRound.advancementCount,
          advancementCriteria: srcRound.advancementCriteria,
          opensAt: copySched ? srcRound.opensAt : undefined,
          closesAt: copySched ? srcRound.closesAt : undefined,
          durationMinutes: copySched ? srcRound.durationMinutes : undefined,
        };
        await repo.rounds.create(round);
        if (round.opensAt || round.closesAt) await scheduleRoundJobs(round);

        if (req.body?.reuseScrambles) {
          const srcSet = await repo.scrambleSets.findByRound(srcRound.id);
          if (srcSet) {
            await repo.scrambleSets.upsert({
              id: randomUUID(),
              roundId: round.id,
              scrambles: [...srcSet.scrambles],
              generatedAt: now,
              lockedAt: now,
              lockedBy: undefined,
            });
          }
        }
      }
    }

    return reply.code(201).send({ id: newCompId, title: comp.title });
  });

  // Create practice event from an existing competition, moving all registered participants
  app.post<{
    Params: { id: string };
    Body: { startsAt?: string; endsAt?: string };
  }>("/api/v1/admin/competitions/:id/practice", adminOrMod, async (req, reply) => {
    const source = await ownedComp(req, reply, req.params.id);
    if (!source) return;

    const user = await repo.users.findById(req.authClaims!.sub);
    const now = new Date().toISOString();
    const newCompId = randomUUID();

    const comp: Competition = {
      id: newCompId,
      title: `${source.title} Practice`,
      type: "practice",
      status: "draft",
      description: source.description,
      rulesMd: source.rulesMd,
      baseFee: 0,
      perEventFee: 0,
      startsAt: req.body?.startsAt ?? undefined,
      endsAt: req.body?.endsAt ?? undefined,
      featured: false,
      videoDeadlineMinutes: source.videoDeadlineMinutes,
      registrationLimit: source.registrationLimit,
      createdBy: user?.id,
      createdAt: now,
    };
    await repo.competitions.create(comp);

    const sourceEvents = await repo.competitionEvents.findByCompetition(source.id);
    const eventMap = new Map<string, string>();

    for (const srcEvent of sourceEvents) {
      const newEventId = randomUUID();
      eventMap.set(srcEvent.id, newEventId);
      await repo.competitionEvents.create({
        id: newEventId,
        competitionId: newCompId,
        eventType: srcEvent.eventType,
        roundCount: srcEvent.roundCount,
        cutoffMs: srcEvent.cutoffMs,
        timeLimitMs: srcEvent.timeLimitMs,
      });

      const srcRounds = (await repo.rounds.findByCompetition(source.id))
        .filter((r) => r.competitionEventId === srcEvent.id)
        .sort((a, b) => a.roundNumber - b.roundNumber);

      for (const srcRound of srcRounds) {
        await repo.rounds.create({
          id: randomUUID(),
          competitionEventId: newEventId,
          roundNumber: srcRound.roundNumber,
          status: "pending",
          format: srcRound.format,
          cutoffMs: srcRound.cutoffMs,
          timeLimitMs: srcRound.timeLimitMs,
          advancementCount: srcRound.advancementCount,
          advancementCriteria: srcRound.advancementCriteria,
        });
      }
    }

    const regs = await repo.registrations.findByCompetition(source.id);
    // Only people actually in the source competition come across — a withdrawn
    // or removed registration should not reappear in the practice copy.
    const activeRegs = regs.filter(isActiveRegistration);
    const regEventsByReg = await repo.registrations.findEventsForAll(activeRegs.map((r) => r.id));

    let copiedCount = 0;
    for (const reg of activeRegs) {
      const newRegId = randomUUID();
      await repo.registrations.create({
        id: newRegId,
        userId: reg.userId,
        competitionId: newCompId,
        paymentStatus: "paid",
        status: "active",
        createdAt: now,
      });

      const srcEvents = regEventsByReg.get(reg.id) ?? [];
      for (const srcEv of srcEvents) {
        const mappedId = eventMap.get(srcEv.id);
        if (mappedId) {
          await repo.registrations.addEvent(newRegId, mappedId);
        }
      }
      copiedCount++;
    }

    return reply.code(201).send({ id: newCompId, title: comp.title, participantsCopied: copiedCount });
  });

  // ── Announcements ─────────────────────────────────────────────────────────

  app.get("/api/v1/admin/announcements", adminOrMod, async () => {
    return repo.announcements.findAll(false);
  });

  app.post<{ Body: { title?: string; bodyMd?: string; imageUrl?: string; redirectUrl?: string; pinned?: boolean; published?: boolean } }>(
    "/api/v1/admin/announcements",
    adminOnly,
    async (req, reply) => {
      const { title, bodyMd, imageUrl, redirectUrl, pinned, published } = req.body ?? {};
      if (!title || !bodyMd) return reply.code(400).send({ error: "missing_fields" });

      const user = await repo.users.findById(req.authClaims!.sub);
      const now = new Date().toISOString();
      const announcement: Announcement = {
        id: randomUUID(),
        title,
        bodyMd,
        imageUrl: imageUrl?.trim() || undefined,
        redirectUrl: redirectUrl?.trim() || undefined,
        pinned: pinned ?? false,
        published: published ?? false,
        createdBy: user?.id,
        createdAt: now,
        updatedAt: now,
      };
      await repo.announcements.create(announcement);
      return reply.code(201).send(announcement);
    },
  );

  app.patch<{
    Params: { id: string };
    Body: { title?: string; bodyMd?: string; imageUrl?: string; redirectUrl?: string; pinned?: boolean; published?: boolean };
  }>("/api/v1/admin/announcements/:id", adminOnly, async (req, reply) => {
    const updated = await repo.announcements.update(req.params.id, req.body ?? {});
    if (!updated) return reply.code(404).send({ error: "announcement_not_found" });
    return updated;
  });

  app.delete<{ Params: { id: string } }>(
    "/api/v1/admin/announcements/:id",
    adminOnly,
    async (req, reply) => {
      await repo.announcements.delete(req.params.id);
      return reply.code(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/admin/announcements/:id/upload-image",
    adminOnly,
    async (req, reply) => {
      const ann = await repo.announcements.findById(req.params.id);
      if (!ann) return reply.code(404).send({ error: "announcement_not_found" });

      const data = await req.file();
      if (!data) return reply.code(400).send({ error: "no_file" });

      const ext = data.filename.split(".").pop()?.toLowerCase() ?? "png";
      if (!["jpg", "jpeg", "png", "gif", "webp"].includes(ext))
        return reply.code(400).send({ error: "invalid_file_type" });

      const chunks: Buffer[] = [];
      for await (const chunk of data.file) chunks.push(chunk as Buffer);
      const buffer = Buffer.concat(chunks);

      if (buffer.length > 2 * 1024 * 1024)
        return reply.code(400).send({ error: "file_too_large_max_2mb" });

      const { getStorage } = await import("../../lib/storage");
      const filename = `announcements/${ann.id}_${randomUUID().slice(0, 8)}.${ext}`;
      const storage = getStorage();
      const imageUrl = await storage.upload(filename, buffer, `image/${ext === "jpg" ? "jpeg" : ext}`);

      const updated = await repo.announcements.update(ann.id, { imageUrl });
      return updated;
    },
  );

  // ── Verification queue (admin + moderator) ────────────────────────────────

  app.get<{ Params: { id: string } }>(
    "/api/v1/admin/competitions/:id/queue",
    adminOrMod,
    async (req, reply) => {
      const comp = await ownedComp(req, reply, req.params.id);
      if (!comp) return;

      const rounds = await repo.rounds.findByCompetition(comp.id);
      const flagged = (await repo.results.findByRounds(rounds.map((r) => r.id)))
        .filter((r) => r.flagStatus === "flagged");

      const thresholds = ANTICHEAT_THRESHOLDS;

      const userIds = [...new Set(flagged.map((r) => r.userId))];
      const [usersMap, userResultCounts, events] = await Promise.all([
        repo.users.findByIds(userIds),
        repo.results.countByUsers(userIds),
        repo.competitionEvents.findByCompetition(comp.id),
      ]);

      const roundsMap = new Map<string, typeof rounds[0]>();
      for (const r of rounds) roundsMap.set(r.id, r);

      const eventTypeById = new Map(events.map((e) => [e.id, e.eventType]));
      const eventsByRound = new Map<string, string>();
      for (const r of rounds) {
        const eventType = eventTypeById.get(r.competitionEventId);
        if (eventType) eventsByRound.set(r.id, eventType);
      }

      return flagged.map((r) => {
        const round = roundsMap.get(r.roundId);
        const eventType = eventsByRound.get(r.roundId) ?? "unknown";
        const user = usersMap.get(r.userId);
        const resultCount = userResultCounts.get(r.userId) ?? 0;

        const reasons: string[] = [];
        const threshold = thresholds[eventType];
        if (threshold && r.ao5Ms !== null && r.ao5Ms < threshold) {
          reasons.push(
            `ao5 (${(r.ao5Ms / 1000).toFixed(2)}s) below ${eventType} threshold (${(threshold / 1000).toFixed(1)}s)`,
          );
        }
        if (resultCount <= 1) {
          reasons.push("New user with no prior competition history");
        }

        return {
          id: r.id, roundId: r.roundId, userId: r.userId,
          userName: user?.name ?? r.userId, userClId: user?.clId ?? r.userId,
          eventType, roundNumber: round?.roundNumber ?? null,
          ao5Ms: r.ao5Ms, bestSingleMs: r.bestSingleMs,
          solves: r.solves, videoUrl: r.videoUrl, flagStatus: r.flagStatus,
          suspicionReasons: reasons, submittedAt: r.submittedAt,
        };
      });
    },
  );

  // Verify / override a result (admin + moderator + assigned judge)
  app.post<{
    Params: { id: string };
    Body: {
      action?: FlagStatus;
      reason?: string;
      comment?: string;
      /** Per-attempt penalties, parallel to the result's solves. null = unchanged. */
      solvePenalties?: (SolvePenalty | null)[];
    };
  }>("/api/v1/admin/results/:id/verify", adminOrMod, async (req, reply) => {
    if (!(await ownedCompByResult(req, reply, req.params.id))) return;
    const result = await repo.results.findById(req.params.id);
    if (!result) return reply.code(404).send({ error: "result_not_found" });

    const action = req.body?.action;
    if (!action || !FLAG_ACTIONS.includes(action))
      return reply.code(400).send({ error: "invalid_action" });

    // Require a reason for destructive actions
    if (["plus2", "dnf", "disqualified"].includes(action) && !req.body?.reason) {
      return reply.code(400).send({ error: "reason_required" });
    }

    const solvePenalties = parseSolvePenalties(req.body?.solvePenalties, result.solves.length);
    if (solvePenalties === "invalid")
      return reply.code(400).send({ error: "invalid_solve_penalties" });
    // A +2 or DNF belongs to a specific attempt; refuse to guess which.
    if (requiresAttemptPenalties(action) && !solvePenalties)
      return reply.code(400).send({ error: "attempt_penalties_required" });

    const admin = await repo.users.findById(req.authClaims!.sub);
    const now = new Date().toISOString();

    await repo.results.update(result.id, {
      flagStatus: action,
      verifiedBy: admin?.id ?? req.authClaims!.sub,
      verifiedAt: now,
      verificationComment: req.body?.comment || undefined,
    });

    // §10 — Audit log with old/new values
    const entry: AuditLogEntry = {
      id: randomUUID(),
      adminId: admin?.id ?? req.authClaims!.sub,
      action: `result_${action}`,
      target: result.id,
      reason: req.body?.reason,
      oldValue: JSON.stringify({
        flagStatus: result.flagStatus,
        flagReasons: result.flagReasons,
        judgeOverrides: result.judgeOverrides ?? null,
      }),
      newValue: JSON.stringify({
        flagStatus: action,
        comment: req.body?.comment || null,
        solvePenalties: solvePenalties ?? null,
      }),
      createdAt: now,
    };
    await repo.auditLog.create(entry);

    // Re-derive stats under the action, re-rank, rebuild the user's PB,
    // and broadcast the corrected leaderboard. Runs for every action so a
    // "verified" verdict also restores stats from a previous penalty.
    await applyResultOverride(repo, realtime, result, action, solvePenalties);

    // Check if shortlisting should trigger (no more flagged results in this round)
    const round = await repo.rounds.findById(result.roundId);
    if (round && round.status === "closed" && (round.advancementCriteria || round.advancementCount)) {
      const allResults = await repo.results.findByRound(round.id);
      const hasFlagged = allResults.some((r) => r.flagStatus === "flagged");
      if (!hasFlagged) {
        await shortlistRound(repo, realtime, round);
      }
    }

    // If the round is already advanced and a result was DQ'd, re-derive the advancement list
    if (round && round.status === "advanced" && action === "disqualified") {
      await reshortlistAdvancedRound(repo, realtime, round, result.userId);
    }

    return { id: result.id, flagStatus: action };
  });

  // §8 — Bulk verify multiple results at once
  app.post<{
    Body: {
      resultIds?: string[];
      action?: FlagStatus;
      reason?: string;
      comment?: string;
    };
  }>("/api/v1/admin/verification/bulk-verify", adminOrMod, async (req, reply) => {
    const { resultIds, action, reason, comment } = req.body ?? {};
    if (!resultIds || !Array.isArray(resultIds) || resultIds.length === 0)
      return reply.code(400).send({ error: "result_ids_required" });
    if (!action || !FLAG_ACTIONS.includes(action))
      return reply.code(400).send({ error: "invalid_action" });
    if (resultIds.length > 200)
      return reply.code(400).send({ error: "bulk_limit_exceeded" });
    if (["plus2", "dnf", "disqualified"].includes(action) && !reason)
      return reply.code(400).send({ error: "reason_required" });
    // Ownership check on first result (bulk ops are within a single competition)
    const firstResultId = resultIds[0];
    if (!firstResultId) return reply.code(400).send({ error: "result_ids_required" });
    if (!(await ownedCompByResult(req, reply, firstResultId))) return;

    const adminId = req.authClaims!.sub;
    const now = new Date().toISOString();
    const previousStates: { id: string; flagStatus: string }[] = [];

    for (const rid of resultIds) {
      const result = await repo.results.findById(rid);
      if (!result) continue;

      previousStates.push({ id: result.id, flagStatus: result.flagStatus });

      await repo.results.update(result.id, {
        flagStatus: action,
        verifiedBy: adminId,
        verifiedAt: now,
        verificationComment: comment || undefined,
      });

      // §10 — Audit with old/new
      await repo.auditLog.create({
        id: randomUUID(),
        adminId,
        action: `bulk_result_${action}`,
        target: result.id,
        reason: reason || undefined,
        oldValue: JSON.stringify({ flagStatus: result.flagStatus }),
        newValue: JSON.stringify({ flagStatus: action }),
        createdAt: now,
      });

      await applyResultOverride(repo, realtime, result, action);
    }

    return { updated: previousStates.length, previousStates };
  });

  // §8 — Undo a bulk action (restore previous flag statuses)
  app.post<{
    Body: { restorations?: { id: string; flagStatus: string }[] };
  }>("/api/v1/admin/verification/bulk-undo", adminOrMod, async (req, reply) => {
    const { restorations } = req.body ?? {};
    if (!restorations || !Array.isArray(restorations) || restorations.length === 0)
      return reply.code(400).send({ error: "restorations_required" });
    // Ownership check on first result
    const firstRestoration = restorations[0];
    if (!firstRestoration) return reply.code(400).send({ error: "restorations_required" });
    if (!(await ownedCompByResult(req, reply, firstRestoration.id))) return;

    const adminId = req.authClaims!.sub;
    const now = new Date().toISOString();
    let restored = 0;

    for (const r of restorations) {
      const result = await repo.results.findById(r.id);
      if (!result) continue;

      await repo.results.update(result.id, {
        flagStatus: r.flagStatus as FlagStatus,
        verifiedBy: undefined,
        verifiedAt: undefined,
        verificationComment: undefined,
      });

      await repo.auditLog.create({
        id: randomUUID(),
        adminId,
        action: "bulk_undo",
        target: result.id,
        oldValue: JSON.stringify({ flagStatus: result.flagStatus }),
        newValue: JSON.stringify({ flagStatus: r.flagStatus }),
        createdAt: now,
      });

      await applyResultOverride(repo, realtime, result, r.flagStatus as FlagStatus);
      restored++;
    }

    return { restored };
  });

  // ── Verification Hub (§1) ─────────────────────────────────────────────────

  // Overview: all competitions with aggregate verification stats (no compId required)
  app.get(
    "/api/v1/admin/verification/hub/overview",
    adminOrMod,
    async (req) => {
      const user = await repo.users.findById(req.authClaims!.sub);
      if (!user) return { competitions: [] };

      // Get all competitions — admins see all, moderators see only their own
      let allComps = await repo.competitions.findAll();
      if (user.role === "moderator") {
        allComps = allComps.filter((c) => c.createdBy === user.id);
      }

      // Filter to competitions that have at least results_pending or completed status,
      // or are live (rounds may already have results)
      const relevant = allComps.filter((c) => {
        const s = effectiveCompStatus(c);
        return ["live", "results_pending", "completed"].includes(s);
      });

      if (relevant.length === 0) return { competitions: [] };

      const compIds = relevant.map((c) => c.id);

      // Bulk-fetch events for all competitions (single query)
      const eventsByComp = await repo.competitionEvents.findByCompetitions(compIds);

      // Build competitionEventId → compId mapping, then fetch all rounds in one go
      const ceToComp = new Map<string, string>();
      for (const [compId, events] of eventsByComp) {
        for (const ev of events) ceToComp.set(ev.id, compId);
      }

      // Use findAll and filter to the relevant competition event IDs (avoids N queries)
      const allRounds = (await repo.rounds.findAll()).filter((r) => ceToComp.has(r.competitionEventId));

      // Group rounds by competition
      const roundsByComp = new Map<string, Round[]>();
      for (const r of allRounds) {
        const compId = ceToComp.get(r.competitionEventId)!;
        const list = roundsByComp.get(compId) ?? [];
        list.push(r);
        roundsByComp.set(compId, list);
      }

      // Bulk-fetch all results (single query)
      const allRoundIds = allRounds.map((r) => r.id);
      const allResults = allRoundIds.length > 0
        ? await repo.results.findByRounds(allRoundIds)
        : [];

      // Group results by roundId
      const resultsByRound = new Map<string, typeof allResults>();
      for (const r of allResults) {
        const list = resultsByRound.get(r.roundId) ?? [];
        list.push(r);
        resultsByRound.set(r.roundId, list);
      }

      // Bulk-fetch registration counts (single query)
      const regCounts = await repo.competitions.countRegistrationsBatch(compIds);

      // Build overview
      const competitions = relevant.map((c) => {
        const rounds = roundsByComp.get(c.id) ?? [];
        let totalResults = 0, totalVerified = 0, totalFlagged = 0, totalClean = 0;
        const roundCount = rounds.length;

        for (const r of rounds) {
          const results = resultsByRound.get(r.id) ?? [];
          totalResults += results.length;
          totalVerified += results.filter((x) =>
            x.flagStatus === "verified" || x.flagStatus === "plus2" ||
            x.flagStatus === "dnf" || x.flagStatus === "disqualified",
          ).length;
          totalFlagged += results.filter((x) => x.flagStatus === "flagged").length;
          totalClean += results.filter((x) => x.flagStatus === "clean").length;
        }

        // Derive verification status
        let verificationStatus: string;
        if (totalResults === 0) verificationStatus = "empty";
        else if (totalVerified === totalResults) verificationStatus = "complete";
        else if (totalFlagged > 0) verificationStatus = "needs_review";
        else verificationStatus = "in_progress";

        return {
          id: c.id,
          title: c.title,
          status: effectiveCompStatus(c),
          startsAt: c.startsAt ?? null,
          endsAt: c.endsAt ?? null,
          bannerUrl: c.bannerUrl ?? null,
          mobileBannerUrl: c.mobileBannerUrl ?? null,
          registrationCount: regCounts.get(c.id) ?? 0,
          roundCount,
          eventCount: (eventsByComp.get(c.id) ?? []).length,
          stats: { total: totalResults, verified: totalVerified, flagged: totalFlagged, clean: totalClean },
          verificationStatus,
        };
      });

      // Sort: needs_review first, then in_progress, then complete, then empty
      const statusOrder: Record<string, number> = { needs_review: 0, in_progress: 1, complete: 2, empty: 3 };
      competitions.sort((a, b) => (statusOrder[a.verificationStatus] ?? 4) - (statusOrder[b.verificationStatus] ?? 4));

      return { competitions };
    },
  );

  // Hub summary: per-round verification stats for a competition
  app.get<{ Querystring: { compId?: string } }>(
    "/api/v1/admin/verification/hub",
    adminOrMod,
    async (req, reply) => {
      const { compId } = req.query;
      if (!compId) return reply.code(400).send({ error: "competition_id_required" });

      const comp = await ownedComp(req, reply, compId);
      if (!comp) return;

      const events = await repo.competitionEvents.findByCompetition(compId);
      const allRounds = await repo.rounds.findByCompetition(compId);

      // Group rounds by competition event
      const roundsByEvent = new Map<string, Round[]>();
      for (const r of allRounds) {
        const list = roundsByEvent.get(r.competitionEventId) ?? [];
        list.push(r);
        roundsByEvent.set(r.competitionEventId, list);
      }

      // Fetch all results and judge assignments in bulk
      const roundIds = allRounds.map((r) => r.id);
      const allResults = roundIds.length > 0
        ? await repo.results.findByRounds(roundIds)
        : [];

      // Group results by roundId
      const resultsByRound = new Map<string, typeof allResults>();
      for (const r of allResults) {
        const list = resultsByRound.get(r.roundId) ?? [];
        list.push(r);
        resultsByRound.set(r.roundId, list);
      }

      // Fetch judge assignments for all rounds
      const assignmentsByRound = new Map<string, { judgeId: string; judgeName: string; judgeClId: string }[]>();
      for (const rid of roundIds) {
        const assignments = await repo.judgeAssignments.findByRound(rid);
        if (assignments.length > 0) {
          const judgeIds = assignments.map((a) => a.judgeId);
          const judgeMap = await repo.users.findByIds(judgeIds);
          assignmentsByRound.set(
            rid,
            assignments.map((a) => {
              const j = judgeMap.get(a.judgeId);
              return { judgeId: a.judgeId, judgeName: j?.name ?? "Unknown", judgeClId: j?.clId ?? a.judgeId };
            }),
          );
        }
      }

      const hubEvents = events.map((ev) => {
        const rounds = (roundsByEvent.get(ev.id) ?? [])
          .sort((a, b) => a.roundNumber - b.roundNumber)
          .map((r) => {
            const results = resultsByRound.get(r.id) ?? [];
            const total = results.length;
            const flagged = results.filter((x) => x.flagStatus === "flagged").length;
            const verified = results.filter((x) =>
              x.flagStatus === "verified" || x.flagStatus === "plus2" ||
              x.flagStatus === "dnf" || x.flagStatus === "disqualified",
            ).length;
            const clean = results.filter((x) => x.flagStatus === "clean").length;

            // Derived status: complete | has_flagged | in_progress | empty
            let verificationStatus: string;
            if (total === 0) verificationStatus = "empty";
            else if (verified === total) verificationStatus = "complete";
            else if (flagged > 0) verificationStatus = "has_flagged";
            else verificationStatus = "in_progress";

            return {
              id: r.id,
              roundNumber: r.roundNumber,
              status: effectiveRoundStatus(r),
              videoRequired: r.videoRequired ?? false,
              resultsPublishedAt: r.resultsPublishedAt ?? null,
              stats: { total, flagged, verified, clean },
              verificationStatus,
              judges: assignmentsByRound.get(r.id) ?? [],
            };
          });

        return {
          eventType: ev.eventType,
          competitionEventId: ev.id,
          rounds,
        };
      });

      return {
        competition: { id: comp.id, title: comp.title, status: effectiveCompStatus(comp) },
        events: hubEvents,
      };
    },
  );

  // §6 — Re-run flag engine on all results in a round
  app.post<{ Params: { roundId: string } }>(
    "/api/v1/admin/verification/rounds/:roundId/reflag",
    adminOrMod,
    async (req, reply) => {
      if (!(await ownedCompByRound(req, reply, req.params.roundId))) return;
      const round = await repo.rounds.findById(req.params.roundId);
      if (!round) return reply.code(404).send({ error: "round_not_found" });

      const event = await repo.competitionEvents.findByRound(round.id);
      const eventType = event?.eventType ?? "333";
      const settings = await repo.systemSettings.get();
      const record = settings.recordReferences[eventType] ?? null;
      const results = await repo.results.findByRound(round.id);

      // Fetch all PBs for users in this round
      const userIds = [...new Set(results.map((r) => r.userId))];
      const allPbs = await Promise.all(
        userIds.map((uid) => repo.personalBests.findByUser(uid)),
      );
      const pbsByUser = new Map<string, PersonalBest | null>();
      userIds.forEach((uid, i) => {
        const pb = (allPbs[i] ?? []).find((p: PersonalBest) => p.eventType === eventType) ?? null;
        pbsByUser.set(uid, pb);
      });

      let updated = 0;
      for (const r of results) {
        // Skip already-verified results — don't re-flag what a judge has reviewed
        if (r.flagStatus === "verified" || r.flagStatus === "plus2" ||
            r.flagStatus === "dnf" || r.flagStatus === "disqualified") continue;

        const flagReasons = computeFlags({
          bestSingleMs: r.bestSingleMs,
          ao5Ms: r.ao5Ms,
          videoUrl: r.videoUrl,
          videoRequired: round.videoRequired ?? false,
          advancementCriteria: round.advancementCriteria,
          advancementCount: round.advancementCount,
          eventType,
          rules: settings.flagRuleDefaults,
          record,
          personalBest: pbsByUser.get(r.userId) ?? null,
          roundResultCount: results.length,
        });

        const newStatus: FlagStatus = flagReasons.length > 0 ? "flagged" : "clean";
        if (newStatus !== r.flagStatus || JSON.stringify(flagReasons) !== JSON.stringify(r.flagReasons)) {
          await repo.results.update(r.id, { flagStatus: newStatus, flagReasons });
          updated++;
        }
      }

      return { roundId: round.id, totalResults: results.length, updated };
    },
  );

  // §10 — Audit trail for a single result
  app.get<{ Params: { resultId: string } }>(
    "/api/v1/admin/verification/results/:resultId/audit",
    adminOrMod,
    async (req, reply) => {
      if (!(await ownedCompByResult(req, reply, req.params.resultId))) return;
      const result = await repo.results.findById(req.params.resultId);
      if (!result) return reply.code(404).send({ error: "result_not_found" });

      const entries = await repo.auditLog.findByTarget(req.params.resultId);
      const adminIds = [...new Set(entries.map((e) => e.adminId).filter(Boolean))];
      const adminsMap = adminIds.length > 0 ? await repo.users.findByIds(adminIds) : new Map();

      return entries.map((e) => {
        const admin = adminsMap.get(e.adminId);
        return {
          id: e.id,
          action: e.action,
          adminName: admin?.name ?? e.adminId,
          reason: e.reason ?? null,
          oldValue: e.oldValue ? JSON.parse(e.oldValue) : null,
          newValue: e.newValue ? JSON.parse(e.newValue) : null,
          createdAt: e.createdAt,
        };
      });
    },
  );

  // ── Verification management (admin + moderator) ─────────────────────────

  // All results for a round with user info + verification status
  app.get<{ Params: { roundId: string } }>(
    "/api/v1/admin/verification/rounds/:roundId/results",
    adminOrMod,
    async (req, reply) => {
      if (!(await ownedCompByRound(req, reply, req.params.roundId))) return;
      const round = await repo.rounds.findById(req.params.roundId);
      if (!round) return reply.code(404).send({ error: "round_not_found" });

      const results = await repo.results.findByRound(round.id);
      const event = await repo.competitionEvents.findByRound(round.id);

      const userIds = [...new Set(results.map((r) => r.userId))];
      const usersMap = await repo.users.findByIds(userIds);

      return results.map((r) => {
        const user = usersMap.get(r.userId);
        return {
          id: r.id,
          userId: r.userId,
          userName: user?.name ?? r.userId,
          userClId: user?.clId ?? r.userId,
          eventType: event?.eventType ?? "unknown",
          roundNumber: round.roundNumber,
          solves: r.solves,
          bestSingleMs: r.bestSingleMs,
          ao5Ms: r.ao5Ms,
          videoUrl: r.videoUrl,
          flagStatus: r.flagStatus,
          flagReasons: r.flagReasons ?? [],
          priority: computePriority(r.flagReasons ?? []),
          verifiedBy: r.verifiedBy,
          verifiedAt: r.verifiedAt,
          verificationComment: r.verificationComment,
          submittedAt: r.submittedAt,
          rank: r.rank,
        };
      });
    },
  );

  // Judges assigned to a round
  app.get<{ Params: { roundId: string } }>(
    "/api/v1/admin/verification/rounds/:roundId/judges",
    adminOrMod,
    async (req, reply) => {
      if (!(await ownedCompByRound(req, reply, req.params.roundId))) return;
      const round = await repo.rounds.findById(req.params.roundId);
      if (!round) return reply.code(404).send({ error: "round_not_found" });

      const assignments = await repo.judgeAssignments.findByRound(round.id);
      const [judgesMap, results] = await Promise.all([
        repo.users.findByIds(assignments.map((a) => a.judgeId)),
        repo.results.findByRound(round.id),
      ]);
      return assignments.map((a) => {
        const judge = judgesMap.get(a.judgeId);
        return {
          id: a.id,
          judgeId: a.judgeId,
          judgeName: judge?.name ?? a.judgeId,
          judgeClId: judge?.clId ?? a.judgeId,
          assignedAt: a.assignedAt,
          verifiedCount: results.filter((r) => r.verifiedBy === a.judgeId).length,
          totalResults: results.length,
        };
      });
    },
  );

  // Assign a judge to a round
  app.post<{
    Body: { judgeId?: string; roundId?: string };
  }>("/api/v1/admin/verification/assign", adminOrMod, async (req, reply) => {
    const { judgeId, roundId } = req.body ?? {};
    if (!judgeId || !roundId)
      return reply.code(400).send({ error: "judgeId_and_roundId_required" });
    if (!(await ownedCompByRound(req, reply, roundId))) return;

    const judge = await repo.users.findById(judgeId);
    if (!judge || !isStaff(judge))
      return reply.code(400).send({ error: "invalid_judge" });

    const round = await repo.rounds.findById(roundId);
    if (!round) return reply.code(404).send({ error: "round_not_found" });

    const assignment = {
      id: randomUUID(),
      judgeId,
      roundId,
      assignedBy: req.authClaims!.sub,
      assignedAt: new Date().toISOString(),
    };
    await repo.judgeAssignments.create(assignment);

    return reply.code(201).send({ id: assignment.id, judgeId, roundId });
  });

  // Unassign a judge
  app.delete<{ Params: { id: string } }>(
    "/api/v1/admin/verification/assign/:id",
    adminOrMod,
    async (req, reply) => {
      // The paired POST checks ownership; without it here a moderator could
      // unassign judges from any competition, including ones they don't run.
      const assignment = await repo.judgeAssignments.findById(req.params.id);
      if (!assignment) return reply.code(404).send({ error: "assignment_not_found" });
      if (!(await ownedCompByRound(req, reply, assignment.roundId))) return;

      await repo.judgeAssignments.delete(req.params.id);
      return { ok: true };
    },
  );

  // List judges available for assignment
  app.get("/api/v1/admin/verification/judges", adminOrMod, async () => {
    const allUsers = await repo.users.findAll();
    return allUsers
      .filter(isStaff)
      .map((u) => ({ id: u.id, name: u.name, clId: u.clId, role: u.role }));
  });

  // ── Competition Events (admin) ────────────────────────────────────────────

  app.patch<{
    Params: { id: string };
    Body: { cutoffMs?: number; timeLimitMs?: number; roundCount?: number; fee?: number; archived?: boolean };
  }>("/api/v1/admin/competition-events/:id", adminOrMod, async (req, reply) => {
    if (!(await ownedCompByEvent(req, reply, req.params.id))) return;
    const { cutoffMs, timeLimitMs, roundCount, fee, archived } = req.body ?? {};
    const fields: Partial<CompetitionEvent> = {};
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
    if (roundCount !== undefined) {
      // Clamped like the two competition endpoints, which this used to bypass —
      // a raw value here also desynchronises round_count from the actual rows.
      if (typeof roundCount !== "number") return reply.code(400).send({ error: "invalid_round_count" });
      fields.roundCount = clampRoundCount(roundCount);
    }
    if (fee !== undefined) {
      if (fee !== null && (typeof fee !== "number" || fee < 0))
        return reply.code(400).send({ error: "invalid_fee" });
      fields.fee = fee ?? undefined;
    }
    if (archived !== undefined) fields.archived = archived;
    if (Object.keys(fields).length === 0) return reply.code(400).send({ error: "no_valid_fields" });

    const updated = await repo.competitionEvents.update(req.params.id, fields);
    if (!updated) return reply.code(404).send({ error: "event_not_found" });
    return updated;
  });

  app.delete<{ Params: { id: string } }>(
    "/api/v1/admin/competition-events/:id",
    adminOrMod,
    async (req, reply) => {
      if (!(await ownedCompByEvent(req, reply, req.params.id))) return;
      const ev = await repo.competitionEvents.findById(req.params.id);
      if (!ev) return reply.code(404).send({ error: "event_not_found" });
      const rounds = await repo.rounds.findByCompetition(ev.competitionId);
      const eventRounds = rounds.filter((r) => r.competitionEventId === ev.id);
      for (const r of eventRounds) {
        const results = await repo.results.findByRound(r.id);
        if (results.length > 0) {
          return reply.code(409).send({ error: "event_has_results" });
        }
      }
      await repo.competitionEvents.delete(ev.id);
      return reply.code(204).send();
    },
  );

  // ── Users (admin) ────────────────────────────────────────────────────────

  app.get<{ Querystring: { search?: string; role?: string; stage?: string; competitionId?: string; page?: string; limit?: string } }>(
    "/api/v1/admin/users",
    adminOnly,
    async (req) => {
      let users = await repo.users.findAll(req.query.search);
      if (req.query.role) users = users.filter((u) => u.role === req.query.role);
      if (req.query.stage) users = users.filter((u) => u.accountStage === req.query.stage);

      // Filter by competition registration
      if (req.query.competitionId) {
        const regs = await repo.registrations.findByCompetition(req.query.competitionId);
        const regUserIds = new Set(regs.map((r) => r.userId));
        users = users.filter((u) => regUserIds.has(u.id));
      }

      const total = users.length;
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(5000, Math.max(1, Number(req.query.limit) || 50));
      const paginated = users.slice((page - 1) * limit, page * limit);
      return { data: paginated.map(sanitizeUser), total, page, limit };
    },
  );

  app.patch<{
    Params: { id: string };
    Body: {
      role?: string; accountStage?: string; name?: string; email?: string; mobileNo?: string;
      emailVerified?: boolean; mobileVerified?: boolean;
    };
  }>("/api/v1/admin/users/:id", adminOnly, async (req, reply) => {
    const { role, accountStage, name, email, mobileNo, emailVerified, mobileVerified } = req.body ?? {};
    const admin = await repo.users.findById(req.authClaims!.sub);
    const isSuper = isSuperAdmin(admin);
    const ROLES = isSuper
      ? ["user", "judge", "moderator", "admin", "super_admin"]
      : ["user", "judge", "moderator", "admin"];
    const STAGES = ["active", "migrated_stub", "suspended", "banned", "deleted"];

    const fields: Partial<import("../../db/types").User> = {};
    if (role && ROLES.includes(role)) fields.role = role as import("@cubers/types").UserRole;
    if (accountStage && STAGES.includes(accountStage)) fields.accountStage = accountStage as import("@cubers/types").AccountStage;
    if (typeof name === "string" && name.trim()) fields.name = name.trim();
    if (typeof email === "string" && email.trim()) fields.email = email.trim();
    if (typeof mobileNo === "string") fields.mobileNo = mobileNo.trim() || undefined;
    if (typeof emailVerified === "boolean") fields.emailVerified = emailVerified;
    if (typeof mobileVerified === "boolean") fields.mobileVerified = mobileVerified;

    if (Object.keys(fields).length === 0) return reply.code(400).send({ error: "no_valid_fields" });

    const updated = await repo.users.update(req.params.id, fields);
    if (!updated) return reply.code(404).send({ error: "user_not_found" });

    if (fields.accountStage === "suspended" || fields.accountStage === "banned" || fields.accountStage === "deleted") {
      realtime.disconnectUser(req.params.id);
    }

    await repo.auditLog.create({
      id: randomUUID(),
      adminId: admin?.id ?? req.authClaims!.sub,
      action: "user_update",
      target: req.params.id,
      reason: `set ${Object.entries(fields).map(([k, v]) => `${k}=${v}`).join(", ")}`,
      createdAt: new Date().toISOString(),
    });

    return sanitizeUser(updated);
  });

  // Delete a user (admin)
  app.delete<{ Params: { id: string } }>(
    "/api/v1/admin/users/:id",
    adminOnly,
    async (req, reply) => {
      const target = await repo.users.findById(req.params.id);
      if (!target) return reply.code(404).send({ error: "user_not_found" });

      if (target.id === req.authClaims!.sub) {
        return reply.code(400).send({ error: "cannot_delete_self" });
      }

      await repo.users.update(req.params.id, {
        email: `deleted-${req.params.id}@deleted.local`,
        name: "Deleted User",
        lastName: undefined,
        mobileNo: undefined,
        avatarUrl: undefined,
        instagram: undefined,
        passwordHash: undefined,
        accountStage: "deleted",
      });
      realtime.disconnectUser(req.params.id);

      const admin = await repo.users.findById(req.authClaims!.sub);
      await repo.auditLog.create({
        id: randomUUID(),
        adminId: admin?.id ?? req.authClaims!.sub,
        action: "user_delete",
        target: req.params.id,
        reason: `Soft-deleted user ${target.email} (${target.clId})`,
        createdAt: new Date().toISOString(),
      });

      return reply.code(204).send();
    },
  );

  // All scrambles for a competition (admin)
  app.get<{ Params: { id: string } }>(
    "/api/v1/admin/competitions/:id/scrambles",
    adminOrMod,
    async (req, reply) => {
      const comp = await ownedComp(req, reply, req.params.id);
      if (!comp) return;

      const events = await repo.competitionEvents.findByCompetition(comp.id);
      const rounds = await repo.rounds.findByCompetition(comp.id);

      const eventMap = new Map(events.map((e) => [e.id, e.eventType]));
      const grouped: Record<string, Array<{
        roundId: string; roundNumber: number; status: string; scrambles: string[]; locked: boolean; generatedAt?: string; hasResults: boolean;
      }>> = {};

      for (const r of rounds) {
        const evType = eventMap.get(r.competitionEventId ?? "") ?? "unknown";
        const set = await repo.scrambleSets.findByRound(r.id);
        const results = await repo.results.findByRound(r.id);
        if (!grouped[evType]) grouped[evType] = [];
        grouped[evType].push({
          roundId: r.id,
          roundNumber: r.roundNumber,
          status: r.status,
          scrambles: set?.scrambles ?? [],
          locked: Boolean(set?.lockedAt),
          generatedAt: set?.generatedAt,
          hasResults: results.length > 0,
        });
      }

      const result = Object.entries(grouped).map(([eventType, rds]) => ({
        eventType,
        rounds: rds.sort((a, b) => a.roundNumber - b.roundNumber),
      }));

      return reply.send({ competitionId: comp.id, status: comp.status, events: result });
    },
  );

  // Delete a competition (admin)
  app.delete<{ Params: { id: string } }>(
    "/api/v1/admin/competitions/:id",
    adminOrMod,
    async (req, reply) => {
      const comp = await ownedComp(req, reply, req.params.id);
      if (!comp) return;

      if (comp.status !== "draft" && comp.status !== "cancelled") {
        return reply.code(409).send({ error: "cancel_before_deleting" });
      }

      if (comp.status === "draft") {
        const regs = await repo.registrations.findByCompetition(req.params.id);
        if (regs.length > 0) {
          return reply.code(409).send({ error: "competition_has_registrations" });
        }
      }

      await repo.competitions.delete(req.params.id);

      const admin = await repo.users.findById(req.authClaims!.sub);
      await repo.auditLog.create({
        id: randomUUID(),
        adminId: admin?.id ?? req.authClaims!.sub,
        action: "competition_delete",
        target: req.params.id,
        reason: `Permanently deleted competition "${comp.title}"`,
        createdAt: new Date().toISOString(),
      });

      return reply.code(204).send();
    },
  );

  // ── Admin: competition participants (enhanced) ──────────────────────────
  app.get<{ Params: { id: string } }>(
    "/api/v1/admin/competitions/:id/participants",
    adminOrMod,
    async (req, reply) => {
      const comp = await ownedComp(req, reply, req.params.id);
      if (!comp) return;

      const regs = await repo.registrations.findByCompetition(comp.id);
      req.log.info({ compId: comp.id, regCount: regs.length }, "admin participants: fetched registrations");
      if (regs.length === 0) return { count: 0, participants: [] };

      const regIds = regs.map((r) => r.id);
      const userIds = [...new Set(regs.map((r) => r.userId))];
      const [usersMap, eventsByReg, paymentsByReg] = await Promise.all([
        repo.users.findByIds(userIds),
        repo.registrations.findEventsForAll(regIds),
        repo.payments.findByRegistrationIds(regIds),
      ]);

      const participants = regs.map((reg) => {
        const u = usersMap.get(reg.userId);
        const regEvents = (eventsByReg.get(reg.id) ?? []).map((e) => e.eventType);
        const payment = paymentsByReg.get(reg.id);
        return {
          registrationId: reg.id,
          userId: reg.userId,
          clId: u?.clId ?? reg.userId,
          name: u?.name ?? "Unknown",
          email: u?.email ?? "",
          mobileNo: u?.mobileNo ?? null,
          city: u?.city ?? null,
          country: u?.country ?? null,
          eventTypes: regEvents,
          // Whether the registration still stands, which is a different question
          // from whether money arrived.
          status: reg.status,
          paymentStatus: payment?.status ?? reg.paymentStatus,
          paymentAmount: payment?.amount ?? 0,
          // Enough detail for an organiser to find and refund the payment by
          // hand — refunds are not automated.
          paymentId: payment?.id ?? null,
          paymentCurrency: payment?.currency ?? null,
          razorpayOrderId: payment?.razorpayOrderId ?? null,
          razorpayPaymentId: payment?.razorpayPaymentId ?? null,
          paymentCreatedAt: payment?.createdAt ?? null,
          registeredAt: reg.createdAt,
        };
      });

      return { count: participants.length, participants };
    },
  );

  // Admin: remove a participant from a competition.
  //
  // Nothing could undo a registration before this — the competitor's own
  // withdraw endpoint rejected everyone, and there was no admin equivalent at
  // all. The row is kept and marked, so the removal stays on the record.
  app.delete<{
    Params: { id: string; regId: string };
    Body: { reason?: string };
  }>(
    "/api/v1/admin/competitions/:id/registrations/:regId",
    adminOrMod,
    async (req, reply) => {
      const comp = await ownedComp(req, reply, req.params.id);
      if (!comp) return;

      const reg = await repo.registrations.findById(req.params.regId);
      if (!reg || reg.competitionId !== comp.id)
        return reply.code(404).send({ error: "registration_not_found" });

      if (!isActiveRegistration(reg))
        return reply.code(409).send({ error: "registration_not_active" });

      if (await hasResultsInCompetition(repo, reg.userId, comp.id))
        return reply.code(409).send({ error: "registration_has_results" });

      await repo.registrations.update(reg.id, { status: "removed" });

      await repo.auditLog.create({
        id: randomUUID(),
        adminId: req.authClaims!.sub,
        action: "registration_remove",
        target: reg.id,
        reason: req.body?.reason?.trim(),
        createdAt: new Date().toISOString(),
      });

      return { ok: true, status: "removed" };
    },
  );

  // ── Payments (admin) ──────────────────────────────────────────────────────

  app.get<{ Querystring: { status?: string; competitionId?: string; page?: string; limit?: string } }>(
    "/api/v1/admin/payments",
    adminOnly,
    async (req) => {
      let payments = await repo.payments.findAll();
      if (req.query.status) payments = payments.filter((p) => p.status === req.query.status);

      // Filter by competition
      if (req.query.competitionId) {
        const compRegs = await repo.registrations.findByCompetition(req.query.competitionId);
        const compRegIds = new Set(compRegs.map((r) => r.id));
        payments = payments.filter((p) =>
          (p.registrationId && compRegIds.has(p.registrationId)) ||
          p.competitionId === req.query.competitionId,
        );
      }

      const total = payments.length;
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(5000, Math.max(1, Number(req.query.limit) || 50));
      const paginated = payments.slice((page - 1) * limit, page * limit);

      const userIds = [...new Set(paginated.map((p) => p.userId))];
      const regIds = paginated.map((p) => p.registrationId).filter((id): id is string => !!id);
      const [usersMap, regsMap] = await Promise.all([
        repo.users.findByIds(userIds),
        repo.registrations.findByIds([...new Set(regIds)]),
      ]);
      const compIds = [...new Set([...regsMap.values()].map((r) => r.competitionId))];
      const compsById = await repo.competitions.findByIds(compIds);
      const compsMap = new Map<string, string>();
      for (const p of paginated) {
        const reg = p.registrationId ? regsMap.get(p.registrationId) : undefined;
        const comp = reg ? compsById.get(reg.competitionId) : (p.competitionId ? compsById.get(p.competitionId) : undefined);
        compsMap.set(p.id, comp?.title ?? "Unknown");
      }

      return {
        data: paginated.map((p) => {
          const user = usersMap.get(p.userId);
          return {
            ...p,
            userName: user?.name ?? p.userId,
            userClId: user?.clId ?? p.userId,
            userEmail: user?.email ?? "",
            competitionTitle: compsMap.get(p.id) ?? "Unknown",
          };
        }),
        total, page, limit,
      };
    },
  );

  // Admin: manually confirm a pending payment (cash / bank transfer / offline)
  app.post<{
    Params: { id: string };
    Body: { reason?: string };
  }>("/api/v1/admin/payments/:id/confirm", adminOnly, async (req, reply) => {
    const payment = await repo.payments.findById(req.params.id);
    if (!payment) return reply.code(404).send({ error: "payment_not_found" });
    if (payment.status === "paid") return reply.code(409).send({ error: "already_paid" });

    await repo.payments.update(payment.id, { status: "paid" });

    // Create registration if payment-first flow (no registrationId yet)
    if (payment.registrationId) {
      await repo.registrations.update(payment.registrationId, { paymentStatus: "paid" });
    } else if (payment.competitionId && payment.eventIds) {
      // fulfillRegistration equivalent inline
      const regId = randomUUID();
      const eventIds = payment.eventIds.split(",").filter(Boolean);
      await repo.registrations.create({
        id: regId,
        userId: payment.userId,
        competitionId: payment.competitionId,
        paymentStatus: "paid",
        status: "active",
        createdAt: new Date().toISOString(),
      });
      for (const eid of eventIds) {
        await repo.registrations.addEvent(regId, eid);
      }
      await repo.payments.update(payment.id, { registrationId: regId } as Partial<import("../../db/types").Payment>);
    }

    await repo.auditLog.create({
      id: randomUUID(),
      adminId: req.authClaims!.sub,
      action: "payment_confirmed_manual",
      target: payment.id,
      reason: req.body?.reason?.trim() || "Manual confirmation by admin",
      createdAt: new Date().toISOString(),
    });

    return { status: "confirmed", paymentId: payment.id };
  });

  // ── CSV export ────────────────────────────────────────────────────────────

  app.get<{ Params: { id: string } }>(
    "/api/v1/admin/competitions/:id/export",
    adminOrMod,
    async (req, reply) => {
      const comp = await ownedComp(req, reply, req.params.id);
      if (!comp) return;

      const events = await repo.competitionEvents.findByCompetition(comp.id);
      const rounds = await repo.rounds.findByCompetition(comp.id);

      const rows: string[][] = [];
      rows.push([
        "Event", "Round", "Rank", "Name", "CL ID", "Best Single (s)",
        "ao5 (s)", "Solve 1", "Solve 2", "Solve 3", "Solve 4", "Solve 5",
        "Flag Status", "Video URL",
      ]);

      // Prefetch all results and users for this competition
      const allResults = (await Promise.all(rounds.map((r) => repo.results.findByRound(r.id)))).flat();
      const allUserIds = [...new Set(allResults.map((r) => r.userId))];
      const usersMap = await repo.users.findByIds(allUserIds);

      for (const ev of events) {
        const evRounds = rounds
          .filter((r) => r.competitionEventId === ev.id)
          .sort((a, b) => a.roundNumber - b.roundNumber);

        for (const round of evRounds) {
          const results = allResults.filter((r) => r.roundId === round.id);
          const sorted = results.sort((a, b) => (a.rank ?? 9999) - (b.rank ?? 9999));

          for (const r of sorted) {
            const user = usersMap.get(r.userId);
            const fmtMs = (ms: number | null) =>
              ms === null ? "DNF" : (ms / 1000).toFixed(2);
            const fmtSolve = (s: { time_ms: number; inspectionPenalty?: string; penalty: string }) => {
              const insp = s.inspectionPenalty ?? "none";
              if (insp === "dnf" || s.penalty === "dnf") return "DNF";
              let extra = 0;
              if (insp === "plus2") extra += 2000;
              if (s.penalty === "plus2") extra += 2000;
              const t = s.time_ms + extra;
              return (t / 1000).toFixed(2) + (extra > 0 ? "+" : "");
            };

            const solveStrs = Array.from({ length: 5 }, (_, i) =>
              r.solves[i] ? fmtSolve(r.solves[i]) : "",
            );

            rows.push([
              ev.eventType,
              `R${round.roundNumber}`,
              r.rank !== null ? String(r.rank) : "",
              user?.name ?? "",
              user?.clId ?? "",
              fmtMs(r.bestSingleMs),
              fmtMs(r.ao5Ms),
              ...solveStrs,
              r.flagStatus,
              r.videoUrl ?? "",
            ]);
          }
        }
      }

      const escapeCsv = (val: string) => {
        if (val.includes(",") || val.includes('"') || val.includes("\n"))
          return `"${val.replace(/"/g, '""')}"`;
        return val;
      };
      const csv = rows.map((row) => row.map(escapeCsv).join(",")).join("\n");
      const filename = `${comp.title.replace(/[^a-zA-Z0-9_-]/g, "_")}_results.csv`;

      return reply
        .header("Content-Type", "text/csv; charset=utf-8")
        .header("Content-Disposition", `attachment; filename="${filename}"`)
        .send(csv);
    },
  );

  // ── Bulk email ────────────────────────────────────────────────────────────

  app.post<{
    Params: { id: string };
    Body: {
      subject?: string;
      bodyHtml?: string;
      recipients?: Array<{ email: string; name: string }>;
    };
  }>(
    "/api/v1/admin/competitions/:id/email",
    adminOrMod,
    async (req, reply) => {
      const { subject, bodyHtml, recipients: csvRecipients } = req.body ?? {};
      if (!subject?.trim() || !bodyHtml?.trim())
        return reply.code(400).send({ error: "subject_and_body_required" });

      const comp = await ownedComp(req, reply, req.params.id);
      if (!comp) return;

      let recipients: { email: string; name: string }[];

      if (Array.isArray(csvRecipients) && csvRecipients.length > 0) {
        recipients = csvRecipients.filter((r) => r.email?.trim());
      } else {
        const regs = await repo.registrations.findByCompetition(comp.id);
        const regUserIds = [...new Set(regs.map((r) => r.userId))];
        const regUsersMap = await repo.users.findByIds(regUserIds);
        recipients = [];
        for (const reg of regs) {
          const user = regUsersMap.get(reg.userId);
          if (user?.email) recipients.push({ email: user.email, name: user.name });
        }
      }

      if (recipients.length === 0)
        return reply.code(409).send({ error: "no_recipients" });

      const queue = await getQueue();
      await queue.add("bulk-email", { recipients, subject, bodyHtml });

      const admin = await repo.users.findById(req.authClaims!.sub);
      await repo.auditLog.create({
        id: randomUUID(),
        adminId: admin?.id ?? req.authClaims!.sub,
        action: "bulk_email",
        target: comp.id,
        reason: `subject="${subject}", recipients=${recipients.length}, queued=true`,
        createdAt: new Date().toISOString(),
      });

      return {
        queued: true,
        recipientCount: recipients.length,
      };
    },
  );

  // ── Certificates ──────────────────────────────────────────────────────────

  app.get<{ Params: { id: string; userId: string } }>(
    "/api/v1/admin/competitions/:id/certificate/:userId",
    adminOrMod,
    async (req, reply) => {
      if (!(await ownedComp(req, reply, req.params.id))) return;
      const data = await collectCertificateData(repo, req.params.id, req.params.userId);
      if (!data) return reply.code(404).send({ error: "not_found" });

      const pdf = generateCertificatePDF(data);
      const filename = `${data.participantName.replace(/[^a-zA-Z0-9_-]/g, "_")}_certificate.pdf`;

      reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `attachment; filename="${filename}"`);

      return reply.send(pdf);
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/v1/admin/competitions/:id/certificates",
    adminOrMod,
    async (req, reply) => {
      const comp = await ownedComp(req, reply, req.params.id);
      if (!comp) return;

      const regs = await repo.registrations.findByCompetition(comp.id);
      if (regs.length === 0)
        return reply.code(409).send({ error: "no_registrations" });

      const filename = `${comp.title.replace(/[^a-zA-Z0-9_-]/g, "_")}_certificates.zip`;
      reply
        .header("Content-Type", "application/zip")
        .header("Content-Disposition", `attachment; filename="${filename}"`);

      const archive = new ZipArchive({ zlib: { level: 5 } });
      archive.on("error", (err: Error) => reply.log.error(err, "archive error"));

      const events = await repo.competitionEvents.findByCompetition(comp.id);
      const rounds = await repo.rounds.findByCompetition(comp.id);
      const allResults = (await Promise.all(rounds.map((r) => repo.results.findByRound(r.id)))).flat();
      const userIds = [...new Set(regs.map((r) => r.userId))];
      const usersMap = await repo.users.findByIds(userIds);

      for (const reg of regs) {
        const user = usersMap.get(reg.userId);
        if (!user) continue;

        const eventResults: { eventType: string; rank: number | null; bestSingleMs: number | null; ao5Ms: number | null }[] = [];
        let bestRank: number | null = null;
        for (const ev of events) {
          const evRounds = rounds.filter((r) => r.competitionEventId === ev.id).sort((a, b) => b.roundNumber - a.roundNumber);
          for (const round of evRounds) {
            const userResult = allResults.find((r) => r.roundId === round.id && r.userId === reg.userId);
            if (userResult) {
              eventResults.push({ eventType: ev.eventType, rank: userResult.rank, bestSingleMs: userResult.bestSingleMs, ao5Ms: userResult.ao5Ms });
              if (userResult.rank !== null && (bestRank === null || userResult.rank < bestRank)) bestRank = userResult.rank;
              break;
            }
          }
        }
        if (eventResults.length === 0) continue;

        const data = {
          competitionTitle: comp.title,
          competitionDate: comp.startsAt ?? comp.createdAt,
          participantName: user.name,
          clId: user.clId,
          events: eventResults,
          isPodium: bestRank !== null && bestRank <= 3,
          podiumRank: bestRank !== null && bestRank <= 3 ? bestRank : undefined,
        };
        const pdf = generateCertificatePDF(data);
        const pdfName = `${data.participantName.replace(/[^a-zA-Z0-9_-]/g, "_")}_${data.clId}.pdf`;
        archive.append(pdf as Buffer, { name: pdfName });
      }

      archive.finalize();
      return reply.send(archive);
    },
  );

  app.post<{
    Params: { id: string };
    Body: {
      winners: Array<{
        name: string;
        clId?: string;
        event?: string;
        rank?: number;
        bestSingle?: string;
        average?: string;
      }>;
    };
  }>(
    "/api/v1/admin/competitions/:id/certificates/csv",
    adminOrMod,
    async (req, reply) => {
      const { winners } = req.body ?? {};
      if (!Array.isArray(winners) || winners.length === 0)
        return reply.code(400).send({ error: "winners_required" });

      const comp = await ownedComp(req, reply, req.params.id);
      if (!comp) return;

      const compDate = comp.startsAt
        ? new Date(comp.startsAt).toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" })
        : new Date(comp.createdAt).toLocaleDateString("en-IN", { year: "numeric", month: "long", day: "numeric" });

      const filename = `${comp.title.replace(/[^a-zA-Z0-9_-]/g, "_")}_custom_certificates.zip`;
      reply
        .header("Content-Type", "application/zip")
        .header("Content-Disposition", `attachment; filename="${filename}"`);

      const archive = new ZipArchive({ zlib: { level: 5 } });
      archive.on("error", (err: Error) => reply.log.error(err, "archive error"));

      for (const w of winners) {
        if (!w.name?.trim()) continue;
        const rank = w.rank ?? null;
        const data = {
          participantName: w.name.trim(),
          clId: w.clId?.trim() ?? "",
          competitionTitle: comp.title,
          competitionDate: compDate,
          events: w.event
            ? [{
                eventType: w.event.trim(),
                rank,
                bestSingleMs: w.bestSingle ? Math.round(parseFloat(w.bestSingle) * 1000) : null,
                ao5Ms: w.average ? Math.round(parseFloat(w.average) * 1000) : null,
              }]
            : [],
          isPodium: rank !== null && rank <= 3,
          podiumRank: rank !== null && rank <= 3 ? rank : undefined,
        };
        const pdf = generateCertificatePDF(data);
        const pdfName = `${data.participantName.replace(/[^a-zA-Z0-9_-]/g, "_")}_cert.pdf`;
        archive.append(pdf as Buffer, { name: pdfName });
      }

      archive.finalize();
      return reply.send(archive);
    },
  );

  // ── Promo codes (admin CRUD) ──────────────────────────────────────────────

  app.get("/api/v1/admin/promo-codes", adminOnly, async () => {
    return repo.promoCodes.findAll();
  });

  app.post<{
    Body: {
      code?: string;
      type?: "competition" | "welcome" | "general";
      discountType?: "percentage" | "flat";
      discountValue?: number;
      maxUses?: number;
      maxUsesPerUser?: number;
      competitionId?: string;
      competitionEventId?: string;
      validFrom?: string;
      validTo?: string;
    };
  }>("/api/v1/admin/promo-codes", adminOnly, async (req, reply) => {
    const { code, type, discountType, discountValue, maxUses, maxUsesPerUser, competitionId, competitionEventId, validFrom, validTo } = req.body ?? {};
    if (!code?.trim() || !discountType || discountValue == null || discountValue <= 0)
      return reply.code(400).send({ error: "code_type_and_value_required" });
    if (discountType === "percentage" && discountValue > 100)
      return reply.code(400).send({ error: "percentage_max_100" });

    const existing = await repo.promoCodes.findByCode(code);
    if (existing) return reply.code(409).send({ error: "code_already_exists" });

    const promoType = type ?? (competitionId ? "competition" : "general");

    const promo: PromoCode = {
      id: randomUUID(),
      code: code.toUpperCase().trim(),
      type: promoType,
      discountType,
      discountValue,
      maxUses: maxUses ?? 0,
      maxUsesPerUser: promoType === "welcome" ? (maxUsesPerUser ?? 1) : (maxUsesPerUser ?? 0),
      usedCount: 0,
      competitionId,
      competitionEventId,
      validFrom,
      validTo,
      active: true,
      createdAt: new Date().toISOString(),
    };
    await repo.promoCodes.create(promo);
    return reply.code(201).send(promo);
  });

  app.patch<{
    Params: { id: string };
    Body: Partial<Pick<PromoCode, "code" | "type" | "discountType" | "discountValue" | "maxUses" | "competitionId" | "competitionEventId" | "validFrom" | "validTo" | "active">>;
  }>("/api/v1/admin/promo-codes/:id", adminOnly, async (req, reply) => {
    const updated = await repo.promoCodes.update(req.params.id, req.body ?? {});
    if (!updated) return reply.code(404).send({ error: "promo_not_found" });
    return updated;
  });

  app.delete<{ Params: { id: string } }>(
    "/api/v1/admin/promo-codes/:id",
    adminOnly,
    async (req, reply) => {
      const promo = await repo.promoCodes.findById(req.params.id);
      if (!promo) return reply.code(404).send({ error: "promo_not_found" });
      await repo.promoCodes.delete(req.params.id);
      return { ok: true };
    },
  );

  // ── Promo code validation (public, auth required) ────────────────────────

  // Authenticated: the response confirms a code's validity, type and value, so
  // leaving it open allowed anyone to enumerate promo codes. The comment above
  // already claimed auth was required; there was no preHandler.
  app.post<{
    Body: { code?: string; competitionId?: string; eventIds?: string[] };
  }>("/api/v1/promo/validate", { preHandler: [promoLimiter, requireAuth] }, async (req, reply) => {
    const { code, competitionId, eventIds } = req.body ?? {};
    if (!code?.trim()) return reply.code(400).send({ error: "code_required" });

    const promo = await repo.promoCodes.findByCode(code.trim());
    if (!promo || !promo.active)
      return reply.code(404).send({ error: "invalid_code" });

    if (promo.maxUses > 0 && promo.usedCount >= promo.maxUses)
      return reply.code(409).send({ error: "code_exhausted" });

    const now = new Date().toISOString();
    if (promo.validFrom && now < promo.validFrom)
      return reply.code(409).send({ error: "code_not_yet_valid" });
    if (promo.validTo && now > promo.validTo)
      return reply.code(409).send({ error: "code_expired" });

    if (promo.competitionId && competitionId && promo.competitionId !== competitionId)
      return reply.code(409).send({ error: "code_not_for_this_competition" });

    if (promo.competitionEventId && eventIds && !eventIds.includes(promo.competitionEventId))
      return reply.code(409).send({ error: "code_not_for_selected_events" });

    return {
      valid: true,
      code: promo.code,
      discountType: promo.discountType,
      discountValue: promo.discountValue,
      competitionEventId: promo.competitionEventId,
    };
  });

  // ── Migration stats (admin) ───────────────────────────────────────────────

  app.get("/api/v1/admin/migration/stats", adminOnly, async () => {
    const users = await repo.users.findAll();
    const stubs = users.filter((u) => u.accountStage === "migrated_stub");
    const active = users.filter((u) => u.accountStage === "active");
    return {
      totalUsers: users.length,
      activeUsers: active.length,
      unclaimedStubs: stubs.length,
      stubs: stubs.map((u) => ({
        id: u.id, clId: u.clId, name: u.name, email: u.email, createdAt: u.createdAt,
      })),
    };
  });

  // ── Migration email campaign ─────────────────────────────────────────────

  app.post("/api/v1/admin/migration/send-emails", adminOnly, async (req) => {
    const users = await repo.users.findAll();
    const stubs = users.filter((u) => u.accountStage === "migrated_stub" && u.email);
    const messages = stubs.map((stub) => {
      const msg = migrationEmail(stub.name, stub.clId);
      return { to: stub.email, subject: msg.subject, html: msg.html };
    });
    const sentCount = await sendBulk(messages);

    const admin = await repo.users.findById((req as { authClaims?: { sub: string } }).authClaims!.sub);
    await repo.auditLog.create({
      id: randomUUID(),
      adminId: admin?.id ?? (req as { authClaims?: { sub: string } }).authClaims!.sub,
      action: "migration_email_campaign",
      reason: `Sent migration emails to ${sentCount}/${stubs.length} unclaimed stubs`,
      createdAt: new Date().toISOString(),
    });

    return { totalStubs: stubs.length, sentCount };
  });

  // ── Round advancement (shortlisting) ─────────────────────────────────────

  // Get advancement list for a round
  app.get<{ Params: { id: string } }>(
    "/api/v1/admin/rounds/:id/advanced",
    adminOrMod,
    async (req, reply) => {
      // Every other /admin/rounds/:id/* route makes this check.
      if (!(await ownedCompByRound(req, reply, req.params.id))) return;
      const round = await repo.rounds.findById(req.params.id);
      if (!round) return reply.code(404).send({ error: "round_not_found" });
      const advanced = await repo.advancements.findByRound(round.id);
      return Promise.all(
        advanced.map(async (a) => {
          const user = await repo.users.findById(a.userId);
          return { userId: a.userId, rank: a.rank, clId: user?.clId, name: user?.name };
        }),
      );
    },
  );

  // Public: who advanced from a round
  app.get<{ Params: { id: string } }>(
    "/api/v1/rounds/:id/advanced",
    async (req, reply) => {
      const round = await repo.rounds.findById(req.params.id);
      if (!round) return reply.code(404).send({ error: "round_not_found" });
      const rs = effectiveRoundStatus(round);
      if (rs !== "closed" && rs !== "advanced") {
        return reply.code(409).send({ error: "round_not_closed" });
      }
      const advanced = await repo.advancements.findByRound(round.id);
      return Promise.all(
        advanced.map(async (a) => {
          const user = await repo.users.findById(a.userId);
          return { userId: a.userId, rank: a.rank, clId: user?.clId, name: user?.name };
        }),
      );
    },
  );

  // ── Withdrawal requests ─────────────────────────────────────────────────
  //
  // A competitor on a paid competition cannot simply leave — money changed
  // hands. The API used to say "contact the organiser" and provide no way to do
  // so. This is the appeals flow applied to registrations, and deliberately
  // mirrors it route for route.

  app.post<{
    Body: { registrationId?: string; reason?: string };
  }>(
    "/api/v1/withdrawal-requests",
    { preHandler: requireRole(repo, "user", "admin", "moderator", "judge") },
    async (req, reply) => {
      const { registrationId, reason } = req.body ?? {};
      if (!registrationId || !reason?.trim())
        return reply.code(400).send({ error: "registration_id_and_reason_required" });

      const reg = await repo.registrations.findById(registrationId);
      if (!reg) return reply.code(404).send({ error: "registration_not_found" });
      if (reg.userId !== req.authClaims!.sub)
        return reply.code(403).send({ error: "can_only_withdraw_own_registration" });
      if (!isActiveRegistration(reg))
        return reply.code(409).send({ error: "registration_not_active" });

      const comp = await repo.competitions.findById(reg.competitionId);
      if (!comp) return reply.code(404).send({ error: "competition_not_found" });
      // Free competitions leave directly; a request would be a detour with no
      // decision to make.
      if (!isPaidCompetition(comp))
        return reply.code(409).send({ error: "withdraw_directly" });

      if (await hasResultsInCompetition(repo, reg.userId, comp.id))
        return reply.code(409).send({ error: "registration_has_results" });

      const open = await repo.withdrawalRequests.findPendingByRegistration(reg.id);
      if (open) return reply.code(409).send({ error: "request_already_submitted" });

      const request = {
        id: randomUUID(),
        registrationId: reg.id,
        userId: reg.userId,
        reason: reason.trim(),
        status: "pending" as const,
        createdAt: new Date().toISOString(),
      };
      await repo.withdrawalRequests.create(request);
      return reply.code(201).send(request);
    },
  );

  app.get(
    "/api/v1/me/withdrawal-requests",
    { preHandler: requireRole(repo, "user", "admin", "moderator", "judge") },
    async (req) => {
      const requests = await repo.withdrawalRequests.findByUser(req.authClaims!.sub);
      return Promise.all(
        requests.map(async (w) => {
          const reg = await repo.registrations.findById(w.registrationId);
          const comp = reg ? await repo.competitions.findById(reg.competitionId) : null;
          return {
            ...w,
            competitionId: comp?.id ?? null,
            competitionTitle: comp?.title ?? "Unknown",
            registrationStatus: reg?.status ?? null,
          };
        }),
      );
    },
  );

  // Admin: every request, with the payment detail needed to settle a refund by
  // hand. Moderators see only their own competitions, as with appeals.
  app.get<{ Querystring: { status?: string } }>(
    "/api/v1/admin/withdrawal-requests",
    adminOrMod,
    async (req) => {
      const caller = await repo.users.findById(req.authClaims!.sub);
      let all = await repo.withdrawalRequests.findAll();
      if (req.query.status) all = all.filter((w) => w.status === req.query.status);

      // `findByRegistration` returns only a *pending* payment despite its name,
      // so a settled one would come back empty — this is the same lookup the
      // participants list uses, which is the latest payment per registration.
      const paymentsByReg = await repo.payments.findByRegistrationIds(
        all.map((w) => w.registrationId),
      );

      const enriched = await Promise.all(
        all.map(async (w) => {
          const reg = await repo.registrations.findById(w.registrationId);
          const payment = paymentsByReg.get(w.registrationId) ?? null;
          const [user, comp, events] = await Promise.all([
            repo.users.findById(w.userId),
            reg ? repo.competitions.findById(reg.competitionId) : Promise.resolve(null),
            reg ? repo.registrations.findEvents(reg.id) : Promise.resolve([]),
          ]);
          const resolver = w.resolvedBy ? await repo.users.findById(w.resolvedBy) : null;
          return {
            ...w,
            userName: user?.name,
            userClId: user?.clId,
            userEmail: user?.email,
            competitionId: comp?.id ?? null,
            competitionTitle: comp?.title ?? "Unknown",
            competitionType: comp?.type ?? null,
            registrationStatus: reg?.status ?? null,
            registeredAt: reg?.createdAt ?? null,
            eventTypes: events.map((e) => e.eventType),
            paymentId: payment?.id ?? null,
            paymentStatus: payment?.status ?? reg?.paymentStatus ?? null,
            paymentAmount: payment?.amount ?? 0,
            paymentCurrency: payment?.currency ?? null,
            razorpayOrderId: payment?.razorpayOrderId ?? null,
            razorpayPaymentId: payment?.razorpayPaymentId ?? null,
            paymentCreatedAt: payment?.createdAt ?? null,
            resolvedByName: resolver?.name,
            _compCreatedBy: comp?.createdBy,
          };
        }),
      );

      const visible = caller?.role === "moderator"
        ? enriched.filter((w) => w._compCreatedBy === caller.id)
        : enriched;

      return { data: visible.map(({ _compCreatedBy, ...rest }) => rest), total: visible.length };
    },
  );

  app.post<{
    Params: { id: string };
    Body: { action?: "approved" | "rejected"; adminResponse?: string };
  }>("/api/v1/admin/withdrawal-requests/:id/resolve", adminOrMod, async (req, reply) => {
    const { action, adminResponse } = req.body ?? {};
    if (!action || !["approved", "rejected"].includes(action))
      return reply.code(400).send({ error: "action_required" });

    const request = await repo.withdrawalRequests.findById(req.params.id);
    if (!request) return reply.code(404).send({ error: "request_not_found" });
    if (request.status !== "pending")
      return reply.code(409).send({ error: "request_already_resolved" });

    const reg = await repo.registrations.findById(request.registrationId);
    if (!reg) return reply.code(404).send({ error: "registration_not_found" });
    // Same ownership rule as every other competition-scoped admin action.
    if (!(await ownedComp(req, reply, reg.competitionId))) return;

    // Approving is what actually removes them; rejecting leaves them in.
    if (action === "approved") {
      if (await hasResultsInCompetition(repo, reg.userId, reg.competitionId))
        return reply.code(409).send({ error: "registration_has_results" });
      await repo.registrations.update(reg.id, { status: "withdrawn" });
    }

    const updated = await repo.withdrawalRequests.update(request.id, {
      status: action,
      adminResponse: adminResponse?.trim(),
      resolvedBy: req.authClaims!.sub,
      resolvedAt: new Date().toISOString(),
    });

    await repo.auditLog.create({
      id: randomUUID(),
      adminId: req.authClaims!.sub,
      action: `withdrawal_${action}`,
      target: reg.id,
      reason: adminResponse?.trim(),
      createdAt: new Date().toISOString(),
    });

    return updated;
  });

  // ── Appeals (user-facing) ───────────────────────────────────────────────

  app.post<{
    Body: { resultId?: string; reason?: string };
  }>("/api/v1/appeals", { preHandler: requireRole(repo, "user", "admin", "moderator", "judge") }, async (req, reply) => {
    const { resultId, reason } = req.body ?? {};
    if (!resultId || !reason?.trim())
      return reply.code(400).send({ error: "result_id_and_reason_required" });

    const result = await repo.results.findById(resultId);
    if (!result) return reply.code(404).send({ error: "result_not_found" });
    if (result.userId !== req.authClaims!.sub)
      return reply.code(403).send({ error: "can_only_appeal_own_results" });

    const existing = await repo.appeals.findByResult(resultId);
    if (existing) return reply.code(409).send({ error: "appeal_already_submitted" });

    const appeal = {
      id: randomUUID(),
      resultId,
      userId: req.authClaims!.sub,
      reason: reason.trim(),
      status: "pending" as const,
      createdAt: new Date().toISOString(),
    };
    await repo.appeals.create(appeal);
    return reply.code(201).send(appeal);
  });

  app.get("/api/v1/me/appeals", { preHandler: requireRole(repo, "user", "admin", "moderator", "judge") }, async (req) => {
    const appeals = await repo.appeals.findByUser(req.authClaims!.sub);
    return Promise.all(
      appeals.map(async (a) => {
        const result = await repo.results.findById(a.resultId);
        let competitionName: string | undefined;
        let eventType: string | undefined;
        let roundNumber: number | undefined;
        if (result) {
          const round = await repo.rounds.findById(result.roundId);
          if (round) {
            const compEvent = await repo.competitionEvents.findByRound(round.id);
            if (compEvent) {
              eventType = compEvent.eventType;
              const comp = await repo.competitions.findById(compEvent.competitionId);
              competitionName = comp?.title;
            }
            roundNumber = round.roundNumber;
          }
        }
        const resolvedByName = a.resolvedBy ? (await repo.users.findById(a.resolvedBy))?.name : undefined;
        return { ...a, competitionName, eventType, roundNumber, resolvedByName };
      }),
    );
  });

  // Admin: list all appeals
  app.get<{ Querystring: { page?: string; limit?: string; status?: string } }>("/api/v1/admin/appeals", adminOrMod, async (req) => {
    const caller = await repo.users.findById(req.authClaims!.sub);
    const isMod = caller?.role === "moderator";
    let all = await repo.appeals.findAll();
    if (req.query.status) all = all.filter((a) => a.status === req.query.status);

    // Resolve competition ownership for each appeal (needed for moderator filtering + display)
    const enriched = await Promise.all(
      all.map(async (a) => {
        const user = await repo.users.findById(a.userId);
        const result = await repo.results.findById(a.resultId);
        let competitionName: string | undefined;
        let eventType: string | undefined;
        let roundNumber: number | undefined;
        let competitionId: string | undefined;
        let compCreatedBy: string | undefined;
        if (result) {
          const round = await repo.rounds.findById(result.roundId);
          if (round) {
            const compEvent = await repo.competitionEvents.findByRound(round.id);
            if (compEvent) {
              eventType = compEvent.eventType;
              competitionId = compEvent.competitionId;
              const comp = await repo.competitions.findById(compEvent.competitionId);
              competitionName = comp?.title;
              compCreatedBy = comp?.createdBy;
            }
            roundNumber = round.roundNumber;
          }
        }
        const resolverName = a.resolvedBy ? (await repo.users.findById(a.resolvedBy))?.name : undefined;
        return {
          ...a,
          userName: user?.name,
          userClId: user?.clId,
          flagStatus: result?.flagStatus,
          competitionId,
          competitionName,
          eventType,
          roundNumber,
          solves: result?.solves,
          ao5Ms: result?.ao5Ms,
          bestSingleMs: result?.bestSingleMs,
          videoUrl: result?.videoUrl,
          resolvedByName: resolverName,
          _compCreatedBy: compCreatedBy,
        };
      }),
    );

    // Moderators only see appeals for their own competitions
    const filtered = isMod
      ? enriched.filter((a) => a._compCreatedBy === caller!.id)
      : enriched;

    const total = filtered.length;
    const page = Math.max(1, Number(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const paginated = filtered.slice((page - 1) * limit, page * limit);
    // Strip internal field
    const data = paginated.map(({ _compCreatedBy, ...rest }) => rest);
    return { data, total, page, limit };
  });

  // Admin: resolve appeal
  app.post<{
    Params: { id: string };
    Body: { action?: "accepted" | "rejected"; adminResponse?: string };
  }>("/api/v1/admin/appeals/:id/resolve", adminOrMod, async (req, reply) => {
    const { action, adminResponse } = req.body ?? {};
    if (!action || !["accepted", "rejected"].includes(action))
      return reply.code(400).send({ error: "action_required" });

    // Moderator ownership check
    const appeal = await repo.appeals.findById(req.params.id);
    if (!appeal) return reply.code(404).send({ error: "appeal_not_found" });
    if (!(await ownedCompByResult(req, reply, appeal.resultId))) return;

    const updated = await repo.appeals.update(req.params.id, {
      status: action,
      adminResponse: adminResponse?.trim(),
      resolvedBy: req.authClaims!.sub,
      resolvedAt: new Date().toISOString(),
    });
    if (!updated) return reply.code(404).send({ error: "appeal_not_found" });

    const admin = await repo.users.findById(req.authClaims!.sub);
    await repo.auditLog.create({
      id: randomUUID(),
      adminId: admin?.id ?? req.authClaims!.sub,
      action: `appeal_${action}`,
      target: updated.resultId,
      reason: adminResponse?.trim(),
      createdAt: new Date().toISOString(),
    });

    return updated;
  });

  // ── WCA verification queue (admin) ──────────────────────────────────────

  app.get("/api/v1/admin/wca-queue", adminOnly, async () => {
    const users = await repo.users.findAll();
    return users
      .filter((u) => u.wcaId && !u.wcaVerified)
      .map((u) => ({
        id: u.id,
        clId: u.clId,
        name: u.name,
        email: u.email,
        wcaId: u.wcaId,
        wcaVerified: u.wcaVerified,
      }));
  });

  app.post<{
    Params: { id: string };
    Body: { action?: "verify" | "reject" };
  }>("/api/v1/admin/wca-queue/:id", adminOnly, async (req, reply) => {
    const { action } = req.body ?? {};
    if (!action) return reply.code(400).send({ error: "action_required" });

    const fields: Partial<import("../../db/types").User> = action === "verify"
      ? { wcaVerified: true }
      : { wcaId: undefined, wcaVerified: false };

    const updated = await repo.users.update(req.params.id, fields);
    if (!updated) return reply.code(404).send({ error: "user_not_found" });

    const admin = await repo.users.findById(req.authClaims!.sub);
    await repo.auditLog.create({
      id: randomUUID(),
      adminId: admin?.id ?? req.authClaims!.sub,
      action: `wca_${action}`,
      target: req.params.id,
      reason: `WCA ID: ${updated.wcaId ?? "removed"}`,
      createdAt: new Date().toISOString(),
    });

    return { id: updated.id, wcaId: updated.wcaId, wcaVerified: updated.wcaVerified };
  });

  // ── Rank tiers (admin CRUD) ─────────────────────────────────────────────

  app.get("/api/v1/admin/rank-tiers", adminOnly, async () => {
    return repo.rankTiers.findAll();
  });

  app.post<{
    Body: { name?: string; eventType?: string; maxAo5Ms?: number; color?: string };
  }>("/api/v1/admin/rank-tiers", adminOnly, async (req, reply) => {
    const { name, eventType, maxAo5Ms, color } = req.body ?? {};
    if (!name?.trim() || !eventType?.trim() || !maxAo5Ms || !color?.trim())
      return reply.code(400).send({ error: "all_fields_required" });

    const tier: RankTier = {
      id: randomUUID(),
      name: name.trim(),
      eventType: eventType.trim(),
      maxAo5Ms,
      color: color.trim(),
      createdAt: new Date().toISOString(),
    };
    await repo.rankTiers.create(tier);
    return reply.code(201).send(tier);
  });

  app.patch<{
    Params: { id: string };
    Body: Partial<Pick<RankTier, "name" | "maxAo5Ms" | "color">>;
  }>("/api/v1/admin/rank-tiers/:id", adminOnly, async (req, reply) => {
    const updated = await repo.rankTiers.update(req.params.id, req.body ?? {});
    if (!updated) return reply.code(404).send({ error: "tier_not_found" });
    return updated;
  });

  app.delete<{ Params: { id: string } }>(
    "/api/v1/admin/rank-tiers/:id",
    adminOnly,
    async (req, reply) => {
      const tier = await repo.rankTiers.findById(req.params.id);
      if (!tier) return reply.code(404).send({ error: "tier_not_found" });
      await repo.rankTiers.delete(req.params.id);
      return { ok: true };
    },
  );

  // Public: get rank tiers for an event
  app.get<{ Params: { eventType: string } }>(
    "/api/v1/rank-tiers/:eventType",
    async (req) => {
      return repo.rankTiers.findByEvent(req.params.eventType);
    },
  );

  // ── Audit log (admin) ─────────────────────────────────────────────────

  app.get<{ Querystring: { page?: string; limit?: string } }>(
    "/api/v1/admin/audit-log",
    adminOnly,
    async (req) => {
      const page = Math.max(1, Number(req.query.page) || 1);
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const entries = await repo.auditLog.findAll(limit, (page - 1) * limit);
      return { data: entries, page, limit };
    },
  );

  // ── Account merge (admin) ──────────────────────────────────────────────

  app.post<{
    Body: { keepUserId?: string; mergeUserId?: string };
  }>("/api/v1/admin/merge-accounts", adminOnly, async (req, reply) => {
    const { keepUserId, mergeUserId } = req.body ?? {};
    if (!keepUserId || !mergeUserId)
      return reply.code(400).send({ error: "keep_and_merge_user_ids_required" });
    if (keepUserId === mergeUserId)
      return reply.code(400).send({ error: "cannot_merge_same_account" });

    const keepUser = await repo.users.findById(keepUserId);
    const mergeUser = await repo.users.findById(mergeUserId);
    if (!keepUser) return reply.code(404).send({ error: "keep_user_not_found" });
    if (!mergeUser) return reply.code(404).send({ error: "merge_user_not_found" });

    // Move results, registrations, and payments; rebuild PBs. Rows that
    // would collide with the kept account's own history are skipped.
    const transferred = await transferUserData(repo, mergeUserId, keepUserId);

    // Deactivate the merged account
    await repo.users.update(mergeUserId, {
      accountStage: "suspended" as import("@cubers/types").AccountStage,
      name: `[MERGED → ${keepUser.clId}] ${mergeUser.name}`,
    });
    realtime.disconnectUser(mergeUserId);

    const admin = await repo.users.findById(req.authClaims!.sub);
    await repo.auditLog.create({
      id: randomUUID(),
      adminId: admin?.id ?? req.authClaims!.sub,
      action: "account_merge",
      target: `${mergeUser.clId} → ${keepUser.clId}`,
      reason: `Merged ${transferred.movedRegistrations} registrations, ${transferred.movedResults} results, ${transferred.movedPayments} payments (skipped ${transferred.skippedRegistrations} registrations, ${transferred.skippedResults} results already on kept account)`,
      createdAt: new Date().toISOString(),
    });

    return {
      kept: { id: keepUser.id, clId: keepUser.clId, name: keepUser.name },
      merged: { id: mergeUser.id, clId: mergeUser.clId, name: mergeUser.name },
      movedRegistrations: transferred.movedRegistrations,
      movedResults: transferred.movedResults,
      movedPayments: transferred.movedPayments,
      skippedRegistrations: transferred.skippedRegistrations,
      skippedResults: transferred.skippedResults,
    };
  });

  // ── Round notification (log-based) ──────────────────────────────────────

  app.post<{ Params: { id: string } }>(
    "/api/v1/admin/rounds/:id/notify",
    adminOrMod,
    async (req, reply) => {
      if (!(await ownedCompByRound(req, reply, req.params.id))) return;
      const round = await repo.rounds.findById(req.params.id);
      if (!round) return reply.code(404).send({ error: "round_not_found" });

      const event = await repo.competitionEvents.findById(round.competitionEventId);
      if (!event) return reply.code(404).send({ error: "event_not_found" });

      const comp = await repo.competitions.findById(event.competitionId);
      const regs = await repo.registrations.findByCompetition(event.competitionId);
      const userIds = [...new Set(regs.map((r) => r.userId))];
      const usersMap = await repo.users.findByIds(userIds);
      const recipients: { email: string; name: string }[] = [];
      for (const reg of regs) {
        const user = usersMap.get(reg.userId);
        if (user?.email) recipients.push({ email: user.email, name: user.name });
      }

      const compTitle = comp?.title ?? "Competition";
      const messages = recipients.map((r) => {
        const msg = roundNotificationEmail(r.name, compTitle, round.roundNumber, "opened");
        return { to: r.email, subject: msg.subject, html: msg.html };
      });
      const sentCount = await sendBulk(messages);

      return {
        sent: sentCount > 0,
        recipientCount: recipients.length,
        sentCount,
        roundNumber: round.roundNumber,
        eventType: event.eventType,
      };
    },
  );

  // ── Publish round results ──────────────────────────────────────────────────

  app.post<{ Params: { id: string } }>(
    "/api/v1/admin/rounds/:id/publish",
    adminOrMod,
    async (req, reply) => {
      if (!(await ownedCompByRound(req, reply, req.params.id))) return;
      const round = await repo.rounds.findById(req.params.id);
      if (!round) return reply.code(404).send({ error: "round_not_found" });
      if (round.resultsPublishedAt) return reply.code(409).send({ error: "already_published" });

      const event = await repo.competitionEvents.findById(round.competitionEventId);
      if (!event) return reply.code(404).send({ error: "event_not_found" });

      const comp = await repo.competitions.findById(event.competitionId);
      const regs = await repo.registrations.findByCompetition(event.competitionId);
      const userIds = [...new Set(regs.map((r) => r.userId))];
      const usersMap = await repo.users.findByIds(userIds);
      const recipients: { email: string; name: string }[] = [];
      for (const reg of regs) {
        const user = usersMap.get(reg.userId);
        if (user?.email) recipients.push({ email: user.email, name: user.name });
      }

      const compTitle = comp?.title ?? "Competition";
      const messages = recipients.map((r) => {
        const msg = roundNotificationEmail(r.name, compTitle, round.roundNumber, "results_published");
        return { to: r.email, subject: msg.subject, html: msg.html };
      });
      const sentCount = await sendBulk(messages);
      await repo.rounds.update(round.id, { resultsPublishedAt: new Date().toISOString() });

      // Auto-complete: if this is the last round of the event, check completion
      const allRounds = await repo.rounds.findByCompetition(event.competitionId);
      const eventRounds = allRounds.filter((r) => r.competitionEventId === event.id);
      const isLastRound = round.roundNumber === eventRounds.length;

      let eventCompleted = false;
      let competitionCompleted = false;

      if (isLastRound) {
        eventCompleted = true;

        // Check if all events of this competition are now complete
        const allEvents = await repo.competitionEvents.findByCompetition(event.competitionId);
        const allComplete = await Promise.all(allEvents.map(async (ev) => {
          const evRounds = allRounds.filter((r) => r.competitionEventId === ev.id);
          if (evRounds.length === 0) return false;
          const lastRound = evRounds.reduce((max, r) => r.roundNumber > max.roundNumber ? r : max);
          if (lastRound.status !== "closed" && lastRound.status !== "advanced") return false;
          const results = await repo.results.findByRound(lastRound.id);
          if (results.some((r) => r.flagStatus === "flagged")) return false;
          return true;
        }));

        if (allComplete.every(Boolean) && comp) {
          await repo.competitions.update(comp.id, { status: "completed" });
          competitionCompleted = true;
        }
      }

      return {
        sent: sentCount > 0,
        recipientCount: recipients.length,
        sentCount,
        roundNumber: round.roundNumber,
        eventType: event.eventType,
        eventCompleted,
        competitionCompleted,
      };
    },
  );

  // ── Banners (admin CRUD) ──────────────────────────────────────────────────

  app.get("/api/v1/admin/banners", adminOnly, async () => {
    return repo.banners.findAll();
  });

  app.post<{
    Body: { title?: string; imageUrl?: string; mobileImageUrl?: string; ctaText?: string; ctaLink?: string; linkUrl?: string; expiresAt?: string; active?: boolean; order?: number };
  }>("/api/v1/admin/banners", adminOnly, async (req, reply) => {
    const { title, imageUrl, mobileImageUrl, ctaText, ctaLink, linkUrl, expiresAt, active, order } = req.body ?? {};
    if (!title?.trim()) return reply.code(400).send({ error: "title_required" });

    const banner: Banner = {
      id: randomUUID(),
      title: title.trim(),
      imageUrl: imageUrl?.trim() || "",
      mobileImageUrl: mobileImageUrl?.trim() || undefined,
      ctaText: ctaText?.trim() || undefined,
      ctaLink: ctaLink?.trim() || undefined,
      linkUrl: linkUrl?.trim() || ctaLink?.trim() || undefined,
      expiresAt: expiresAt || undefined,
      active: active ?? true,
      order: order ?? 0,
      createdAt: new Date().toISOString(),
    };
    await repo.banners.create(banner);
    return reply.code(201).send(banner);
  });

  app.patch<{
    Params: { id: string };
    Body: Partial<Pick<Banner, "title" | "imageUrl" | "mobileImageUrl" | "ctaText" | "ctaLink" | "linkUrl" | "expiresAt" | "active" | "order">>;
  }>("/api/v1/admin/banners/:id", adminOnly, async (req, reply) => {
    const updated = await repo.banners.update(req.params.id, req.body ?? {});
    if (!updated) return reply.code(404).send({ error: "banner_not_found" });
    return updated;
  });

  app.delete<{ Params: { id: string } }>(
    "/api/v1/admin/banners/:id",
    adminOnly,
    async (req, reply) => {
      const banner = await repo.banners.findById(req.params.id);
      if (!banner) return reply.code(404).send({ error: "banner_not_found" });
      await repo.banners.delete(req.params.id);
      return { ok: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/admin/banners/:id/upload-image",
    adminOnly,
    async (req, reply) => {
      const banner = await repo.banners.findById(req.params.id);
      if (!banner) return reply.code(404).send({ error: "banner_not_found" });

      const data = await req.file();
      if (!data) return reply.code(400).send({ error: "no_file" });

      const ext = data.filename.split(".").pop()?.toLowerCase() ?? "png";
      if (!["jpg", "jpeg", "png", "gif", "webp"].includes(ext))
        return reply.code(400).send({ error: "invalid_file_type" });

      const chunks: Buffer[] = [];
      for await (const chunk of data.file) chunks.push(chunk as Buffer);
      const buffer = Buffer.concat(chunks);

      // @fastify/multipart enforces its 5 MB limit by *truncating* the stream,
      // not by throwing. Checking `buffer.length` therefore never fires — the
      // buffer is capped at the limit — and an oversized photo used to be stored
      // as a corrupt, half-written image with a 200 response. `truncated` is the
      // only signal that the file was cut short.
      if (data.file.truncated)
        return reply.code(413).send({ error: "file_too_large_max_5mb" });

      const { getStorage } = await import("../../lib/storage");
      const filename = `banners/${banner.id}_${randomUUID().slice(0, 8)}.${ext}`;
      const storage = getStorage();
      const imageUrl = await storage.upload(filename, buffer, `image/${ext === "jpg" ? "jpeg" : ext}`);

      const updated = await repo.banners.update(banner.id, { imageUrl });
      return updated;
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/admin/banners/:id/upload-mobile-image",
    adminOnly,
    async (req, reply) => {
      const banner = await repo.banners.findById(req.params.id);
      if (!banner) return reply.code(404).send({ error: "banner_not_found" });

      const data = await req.file();
      if (!data) return reply.code(400).send({ error: "no_file" });

      const ext = data.filename.split(".").pop()?.toLowerCase() ?? "png";
      if (!["jpg", "jpeg", "png", "gif", "webp"].includes(ext))
        return reply.code(400).send({ error: "invalid_file_type" });

      const chunks: Buffer[] = [];
      for await (const chunk of data.file) chunks.push(chunk as Buffer);
      const buffer = Buffer.concat(chunks);

      // @fastify/multipart enforces its 5 MB limit by *truncating* the stream,
      // not by throwing. Checking `buffer.length` therefore never fires — the
      // buffer is capped at the limit — and an oversized photo used to be stored
      // as a corrupt, half-written image with a 200 response. `truncated` is the
      // only signal that the file was cut short.
      if (data.file.truncated)
        return reply.code(413).send({ error: "file_too_large_max_5mb" });

      const { getStorage } = await import("../../lib/storage");
      const filename = `banners/${banner.id}_mobile_${randomUUID().slice(0, 8)}.${ext}`;
      const storage = getStorage();
      const mobileImageUrl = await storage.upload(filename, buffer, `image/${ext === "jpg" ? "jpeg" : ext}`);

      const updated = await repo.banners.update(banner.id, { mobileImageUrl });
      return updated;
    },
  );

  // Public: active banners
  app.get("/api/v1/banners", async () => {
    const all = await repo.banners.findAll();
    const now = Date.now();
    return all.filter((b) => b.active && (!b.expiresAt || new Date(b.expiresAt).getTime() > now));
  });

  // ── FAQ (admin CRUD) ──────────────────────────────────────────────────────

  app.get("/api/v1/admin/faq", adminOnly, async () => {
    return repo.faq.findAll(false);
  });

  app.post<{
    Body: { question?: string; answerMd?: string; order?: number; published?: boolean };
  }>("/api/v1/admin/faq", adminOnly, async (req, reply) => {
    const { question, answerMd, order, published } = req.body ?? {};
    if (!question?.trim() || !answerMd?.trim())
      return reply.code(400).send({ error: "question_and_answer_required" });

    const entry: FaqEntry = {
      id: randomUUID(),
      question: question.trim(),
      answerMd: answerMd.trim(),
      order: order ?? 0,
      published: published ?? false,
      createdAt: new Date().toISOString(),
    };
    await repo.faq.create(entry);
    return reply.code(201).send(entry);
  });

  app.patch<{
    Params: { id: string };
    Body: Partial<Pick<FaqEntry, "question" | "answerMd" | "order" | "published">>;
  }>("/api/v1/admin/faq/:id", adminOnly, async (req, reply) => {
    const updated = await repo.faq.update(req.params.id, req.body ?? {});
    if (!updated) return reply.code(404).send({ error: "faq_not_found" });
    return updated;
  });

  app.delete<{ Params: { id: string } }>(
    "/api/v1/admin/faq/:id",
    adminOnly,
    async (req, reply) => {
      const entry = await repo.faq.findById(req.params.id);
      if (!entry) return reply.code(404).send({ error: "faq_not_found" });
      await repo.faq.delete(req.params.id);
      return { ok: true };
    },
  );

  // Public: published FAQ entries
  app.get("/api/v1/faq", async () => {
    return repo.faq.findAll(true);
  });

  // ── Content Pages (admin CRUD) ─────────────────────────────────────────────

  app.get("/api/v1/admin/content-pages", adminOnly, async () => {
    return repo.contentPages.findAll(false);
  });

  app.post<{
    Body: { slug?: string; title?: string; bodyMd?: string; published?: boolean };
  }>("/api/v1/admin/content-pages", adminOnly, async (req, reply) => {
    const { slug, title, bodyMd, published } = req.body ?? {};
    if (!slug?.trim() || !title?.trim())
      return reply.code(400).send({ error: "slug_and_title_required" });

    const existing = await repo.contentPages.findBySlug(slug.trim());
    if (existing) return reply.code(409).send({ error: "slug_already_exists" });

    const now = new Date().toISOString();
    const page: ContentPage = {
      id: randomUUID(), slug: slug.trim(), title: title.trim(),
      bodyMd: bodyMd?.trim() ?? "", published: published ?? false,
      updatedAt: now, createdAt: now,
    };
    await repo.contentPages.create(page);
    return reply.code(201).send(page);
  });

  app.patch<{
    Params: { id: string };
    Body: Partial<Pick<ContentPage, "slug" | "title" | "bodyMd" | "published">>;
  }>("/api/v1/admin/content-pages/:id", adminOnly, async (req, reply) => {
    const updated = await repo.contentPages.update(req.params.id, req.body ?? {});
    if (!updated) return reply.code(404).send({ error: "content_page_not_found" });
    return updated;
  });

  app.delete<{ Params: { id: string } }>(
    "/api/v1/admin/content-pages/:id",
    adminOnly,
    async (req, reply) => {
      const page = await repo.contentPages.findById(req.params.id);
      if (!page) return reply.code(404).send({ error: "content_page_not_found" });
      await repo.contentPages.delete(req.params.id);
      return { ok: true };
    },
  );

  // Public: fetch a content page by slug
  app.get<{ Params: { slug: string } }>("/api/v1/pages/:slug", async (req, reply) => {
    const page = await repo.contentPages.findBySlug(req.params.slug);
    if (!page || !page.published) return reply.code(404).send({ error: "page_not_found" });
    return { slug: page.slug, title: page.title, bodyMd: page.bodyMd };
  });

  // ── Judge/Moderator creation (admin) ──────────────────────────────────────

  app.post<{
    Body: { email?: string; name?: string; role?: "judge" | "moderator" | "admin" };
  }>("/api/v1/admin/create-staff", adminOnly, async (req, reply) => {
    const { email, name, role } = req.body ?? {};
    if (!email?.trim() || !name?.trim())
      return reply.code(400).send({ error: "email_and_name_required" });
    if (!role || !["judge", "moderator", "admin"].includes(role))
      return reply.code(400).send({ error: "invalid_role" });

    // Promoting to admin requires super_admin
    if (role === "admin") {
      const caller = await repo.users.findById(req.authClaims!.sub);
      if (!isSuperAdmin(caller))
        return reply.code(403).send({ error: "super_admin_required_for_admin_promotion" });
    }

    const existing = await repo.users.findByEmail(email.trim());
    if (existing) {
      if (existing.role === role)
        return reply.code(409).send({ error: "user_already_has_role" });
      await repo.users.update(existing.id, { role: role as import("@cubers/types").UserRole });
      const admin = await repo.users.findById(req.authClaims!.sub);
      await repo.auditLog.create({
        id: randomUUID(),
        adminId: admin?.id ?? req.authClaims!.sub,
        action: "role_assign",
        target: existing.id,
        reason: `Role changed to ${role}`,
        createdAt: new Date().toISOString(),
      });
      return { id: existing.id, clId: existing.clId, name: existing.name, email: existing.email, role };
    }

    const clId = await repo.users.nextClId();
    const now = new Date().toISOString();
    const newUser = {
      id: randomUUID(),
      clId,
      email: email.trim(),
      name: name.trim(),
      role: role as "judge" | "moderator" | "admin",
      wcaVerified: false,
      emailVerified: false,
      mobileVerified: false,
      profilePrivacy: "public" as const,
      accountStage: "active" as const,
      createdAt: now,
    };
    await repo.users.create(newUser);

    const admin = await repo.users.findById(req.authClaims!.sub);
    await repo.auditLog.create({
      id: randomUUID(),
      adminId: admin?.id ?? req.authClaims!.sub,
      action: "staff_create",
      target: newUser.id,
      reason: `Created ${role} account for ${email}`,
      createdAt: now,
    });

    const welcome = staffWelcomeEmail(newUser.name, role);
    emailService.send({ to: newUser.email, subject: welcome.subject, html: welcome.html }).catch(() => {});

    return reply.code(201).send({ id: newUser.id, clId, name: newUser.name, email: newUser.email, role });
  });

  // ── System Settings ──────────────────────────────────────────────────

  app.get("/api/v1/admin/settings", { preHandler: requireRole(repo, "admin") }, async (_req, reply) => {
    const settings = await repo.systemSettings.get();
    return reply.send(settings);
  });

  app.put("/api/v1/admin/settings", { preHandler: requireRole(repo, "admin") }, async (req, reply) => {
    const body = req.body as Record<string, unknown>;
    const patch: Record<string, unknown> = {};
    if (body.eventDurations && typeof body.eventDurations === "object") {
      patch.eventDurations = body.eventDurations;
    }
    if (typeof body.registrationDurationDays === "number" && body.registrationDurationDays > 0) {
      patch.registrationDurationDays = body.registrationDurationDays;
    }
    if (typeof body.gapBetweenEventsMinutes === "number" && body.gapBetweenEventsMinutes >= 0) {
      patch.gapBetweenEventsMinutes = body.gapBetweenEventsMinutes;
    }
    if (typeof body.defaultRoundDurationMinutes === "number" && body.defaultRoundDurationMinutes > 0) {
      patch.defaultRoundDurationMinutes = body.defaultRoundDurationMinutes;
    }
    if (typeof body.videoDeadlineMinutes === "number" && body.videoDeadlineMinutes > 0) {
      patch.videoDeadlineMinutes = body.videoDeadlineMinutes;
    }
    if (body.flagRuleDefaults && typeof body.flagRuleDefaults === "object") {
      patch.flagRuleDefaults = body.flagRuleDefaults;
    }
    if (body.recordReferences && typeof body.recordReferences === "object") {
      patch.recordReferences = body.recordReferences;
    }
    const updated = await repo.systemSettings.update(patch);
    return reply.send(updated);
  });

  // ── Rule Sets ────────────────────────────────────────────────────────

  app.get("/api/v1/admin/rule-sets", adminOnly, async (_req, reply) => {
    const sets = await repo.ruleSets.findAll();
    return reply.send(sets);
  });

  app.post<{ Body: { name: string; content: string } }>(
    "/api/v1/admin/rule-sets",
    adminOnly,
    async (req, reply) => {
      const { name, content } = req.body ?? {};
      if (!name || typeof name !== "string") return reply.code(400).send({ error: "missing_name" });
      const now = new Date().toISOString();
      const rs = { id: randomUUID(), name: name.trim(), content: typeof content === "string" ? content : "", createdAt: now, updatedAt: now };
      try {
        await repo.ruleSets.create(rs);
      } catch {
        return reply.code(409).send({ error: "duplicate_name" });
      }
      return reply.code(201).send(rs);
    },
  );

  app.patch<{ Params: { id: string }; Body: { name?: string; content?: string } }>(
    "/api/v1/admin/rule-sets/:id",
    adminOnly,
    async (req, reply) => {
      const { name, content } = req.body ?? {};
      const fields: Record<string, unknown> = {};
      if (typeof name === "string") fields.name = name.trim();
      if (typeof content === "string") fields.content = content;
      const updated = await repo.ruleSets.update(req.params.id, fields);
      if (!updated) return reply.code(404).send({ error: "not_found" });
      return reply.send(updated);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/v1/admin/rule-sets/:id",
    adminOnly,
    async (req, reply) => {
      await repo.ruleSets.delete(req.params.id);
      return reply.send({ ok: true });
    },
  );

  // Public endpoint for fetching rule sets (for competition detail page)
  app.get("/api/v1/rule-sets", async (_req, reply) => {
    const sets = await repo.ruleSets.findAll();
    return reply.send(sets.map((s) => ({ id: s.id, name: s.name, content: s.content })));
  });

  // Public endpoint — no auth, used by create-competition form
  app.get("/api/v1/settings/scheduling", async (_req, reply) => {
    const settings = await repo.systemSettings.get();
    return reply.send({
      eventDurations: settings.eventDurations,
      registrationDurationDays: settings.registrationDurationDays,
      gapBetweenEventsMinutes: settings.gapBetweenEventsMinutes,
      defaultRoundDurationMinutes: settings.defaultRoundDurationMinutes,
      // The admin form shows this as the placeholder for a competition that has
      // not set its own video deadline.
      videoDeadlineMinutes: settings.videoDeadlineMinutes,
    });
  });

}
