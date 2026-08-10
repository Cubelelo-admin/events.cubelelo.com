import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Repository } from "../../db/repo";
import type { Registration } from "../../db/types";
import { requireAuth } from "../../auth/plugin";
import { effectiveCompStatus } from "../../lib/statusUtils";

export async function registerRegistrationRoutes(
  app: FastifyInstance,
  repo: Repository,
): Promise<void> {
  app.post<{
    Params: { id: string };
    Body: { eventIds?: string[] };
  }>(
    "/api/v1/competitions/:id/register",
    { preHandler: requireAuth },
    async (req, reply) => {
      const comp = await repo.competitions.findById(req.params.id);
      if (!comp) return reply.code(404).send({ error: "competition_not_found" });

      if (effectiveCompStatus(comp) !== "registration_open") {
        return reply.code(409).send({ error: "registration_not_open" });
      }

      const user = await repo.users.findById(req.authClaims!.sub);
      if (!user) return reply.code(403).send({ error: "not_synced" });

      const rawEventIds = req.body?.eventIds;
      if (!Array.isArray(rawEventIds) || rawEventIds.length === 0) {
        return reply.code(400).send({ error: "no_events_selected" });
      }
      const eventIds = [...new Set(rawEventIds as string[])];

      if (!user.emailVerified) {
        return reply.code(403).send({ error: "email_not_verified" });
      }

      // Check registration capacity
      if (comp.registrationLimit != null && comp.registrationLimit > 0) {
        const currentRegs = await repo.registrations.findByCompetition(comp.id);
        const activeCount = currentRegs.filter((r) => r.paymentStatus !== "failed").length;
        if (activeCount >= comp.registrationLimit) {
          return reply.code(409).send({ error: "registration_full" });
        }
      }

      const existing = await repo.registrations.findByUserAndComp(user.id, comp.id);
      if (existing && existing.paymentStatus !== "failed") {
        return reply.code(409).send({ error: "already_registered" });
      }
      if (existing && existing.paymentStatus === "failed") {
        await repo.registrations.removeEvents(existing.id);
        await repo.registrations.delete(existing.id);
      }

      // Validate event IDs belong to this competition and have at least one non-cancelled round
      const compEvents = await repo.competitionEvents.findByCompetition(comp.id);
      const compEventIds = new Set(compEvents.map((e) => e.id));
      const compEventMap = new Map(compEvents.map((e) => [e.id, e]));
      const rounds = await repo.rounds.findByCompetition(comp.id);
      const eventsWithRounds = new Set(
        rounds.filter((r) => r.status !== "cancelled").map((r) => r.competitionEventId),
      );
      for (const eid of eventIds) {
        if (!compEventIds.has(eid)) {
          return reply.code(400).send({ error: "invalid_event_id" });
        }
        if (!eventsWithRounds.has(eid)) {
          return reply.code(400).send({ error: "event_not_available" });
        }
      }

      const eventFeeSum = eventIds.reduce((sum, eid) => {
        const ev = compEventMap.get(eid);
        return sum + (ev?.fee ?? comp.perEventFee);
      }, 0);
      const totalFee = comp.baseFee + eventFeeSum;
      const isFree = totalFee === 0;

      const registration: Registration = {
        id: randomUUID(),
        userId: user.id,
        competitionId: comp.id,
        paymentStatus: isFree ? "paid" : "pending",
        createdAt: new Date().toISOString(),
      };
      await repo.registrations.create(registration);
      for (const eid of eventIds) {
        await repo.registrations.addEvent(registration.id, eid);
      }

      return reply.code(201).send({
        registrationId: registration.id,
        totalFee,
        paymentStatus: registration.paymentStatus,
      });
    },
  );

  app.delete<{ Params: { regId: string } }>(
    "/api/v1/registrations/:regId",
    { preHandler: requireAuth },
    async (req, reply) => {
      const reg = await repo.registrations.findById(req.params.regId);
      if (!reg) return reply.code(404).send({ error: "registration_not_found" });

      const user = await repo.users.findById(req.authClaims!.sub);
      if (!user || reg.userId !== user.id)
        return reply.code(403).send({ error: "forbidden" });

      const comp = await repo.competitions.findById(reg.competitionId);
      if (!comp) return reply.code(404).send({ error: "competition_not_found" });

      const status = effectiveCompStatus(comp);
      if (status !== "registration_open" && status !== "published") {
        return reply.code(409).send({ error: "registration_closed_cannot_withdraw" });
      }

      if (reg.paymentStatus === "paid") {
        return reply.code(409).send({ error: "paid_registration_contact_admin" });
      }

      await repo.registrations.removeEvents(reg.id);
      await repo.registrations.delete(reg.id);

      return { ok: true };
    },
  );

  app.get(
    "/api/v1/me/registrations",
    { preHandler: requireAuth },
    async (req, reply) => {
      const user = await repo.users.findById(req.authClaims!.sub);
      if (!user) return reply.code(403).send({ error: "not_synced" });

      const regs = await repo.registrations.findByUser(user.id);

      return Promise.all(
        regs.map(async (r) => {
          const [comp, events] = await Promise.all([
            repo.competitions.findById(r.competitionId),
            repo.registrations.findEvents(r.id),
          ]);
          return {
            id: r.id,
            competitionId: r.competitionId,
            competitionTitle: comp?.title ?? "Unknown",
            paymentStatus: r.paymentStatus,
            events: events.map((e) => ({ id: e.id, eventType: e.eventType })),
            createdAt: r.createdAt,
          };
        }),
      );
    },
  );
}
