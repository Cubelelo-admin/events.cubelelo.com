import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Repository } from "../../db/repo";
import type { Registration } from "../../db/types";
import { requireAuth } from "../../auth/plugin";
import { effectiveCompStatus } from "../../lib/statusUtils";
import {
  isActiveRegistration,
  isPaidCompetition,
  hasResultsInCompetition,
} from "../../lib/registrationStatus";

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
        const activeCount = currentRegs.filter(isActiveRegistration).length;
        if (activeCount >= comp.registrationLimit) {
          return reply.code(409).send({ error: "registration_full" });
        }
      }

      const existing = await repo.registrations.findByUserAndComp(user.id, comp.id);
      if (isActiveRegistration(existing)) {
        return reply.code(409).send({ error: "already_registered" });
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

      if (!isFree) {
        // Paid competitions: don't create registration yet — return fee info
        // so the frontend can proceed to payment. Registration is created
        // only after payment is verified (standard payment flow).
        return reply.code(200).send({
          registrationId: null,
          totalFee,
          paymentStatus: "requires_payment",
          competitionId: comp.id,
          eventIds,
        });
      }

      // Free competition: register immediately.
      //
      // Someone who withdrew earlier already has a row, and the unique
      // (user_id, competition_id) constraint means it has to be reused rather
      // than replaced. Reactivating keeps the history and the original join date.
      let registrationId: string;
      if (existing) {
        registrationId = existing.id;
        await repo.registrations.update(existing.id, { status: "active" });
        await repo.registrations.removeEvents(existing.id);
      } else {
        const registration: Registration = {
          id: randomUUID(),
          userId: user.id,
          competitionId: comp.id,
          paymentStatus: "paid",
          status: "active",
          createdAt: new Date().toISOString(),
        };
        await repo.registrations.create(registration);
        registrationId = registration.id;
      }

      for (const eid of eventIds) {
        await repo.registrations.addEvent(registrationId, eid);
      }

      return reply.code(201).send({
        registrationId,
        totalFee: 0,
        paymentStatus: "paid",
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

      if (!isActiveRegistration(reg)) {
        return reply.code(409).send({ error: "registration_not_active" });
      }

      const status = effectiveCompStatus(comp);
      if (status !== "registration_open" && status !== "published") {
        return reply.code(409).send({ error: "registration_closed_cannot_withdraw" });
      }

      // Money changed hands, so a human settles it — through a withdrawal
      // request, not this endpoint. This used to test the registration's payment
      // status, which is `paid` on free competitions too, so it rejected
      // everyone and left no way out of any competition at all.
      if (isPaidCompetition(comp)) {
        return reply.code(409).send({ error: "paid_registration_contact_admin" });
      }

      if (await hasResultsInCompetition(repo, reg.userId, comp.id)) {
        return reply.code(409).send({ error: "registration_has_results" });
      }

      // Soft: `unique (user_id, competition_id)` means deleting is the only way
      // to let someone register again, and the row is worth keeping.
      await repo.registrations.update(reg.id, { status: "withdrawn" });

      return { ok: true, status: "withdrawn" };
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
            status: r.status,
            events: events.map((e) => ({ id: e.id, eventType: e.eventType })),
            createdAt: r.createdAt,
          };
        }),
      );
    },
  );
}
