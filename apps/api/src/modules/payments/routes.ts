import { randomUUID, createHmac, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Repository } from "../../db/repo";
import type { Payment, Registration } from "../../db/types";
import { requireAuth } from "../../auth/plugin";
import { isAdmin, isAdminOrMod } from "../../auth/ownership";
import { env } from "../../config/env";
import { generateInvoicePDF, type InvoiceData } from "../../lib/invoice";
import { submitLimiter } from "../../lib/rateLimiter";
import { effectiveCompStatus } from "../../lib/statusUtils";
import { isActiveRegistration } from "../../lib/registrationStatus";

async function getRazorpay() {
  if (!env.RAZORPAY_KEY_ID || !env.RAZORPAY_KEY_SECRET) return null;
  const { default: Razorpay } = await import("razorpay");
  return new Razorpay({ key_id: env.RAZORPAY_KEY_ID, key_secret: env.RAZORPAY_KEY_SECRET });
}

/**
 * Create registration + registration_events after payment is confirmed.
 * Called from both verify (frontend) and webhook (Razorpay).
 * Idempotent — if the registration already exists, it returns it.
 */
async function fulfillRegistration(
  repo: Repository,
  payment: Payment,
): Promise<Registration> {
  // Already fulfilled?
  if (payment.registrationId) {
    const existing = await repo.registrations.findById(payment.registrationId);
    if (existing) return existing;
  }

  const competitionId = payment.competitionId;
  const eventIdsCsv = payment.eventIds;
  if (!competitionId || !eventIdsCsv) {
    throw new Error("Payment missing checkout intent (competitionId/eventIds)");
  }

  const eventIds = eventIdsCsv.split(",").filter(Boolean);

  // Already fulfilled and still standing (idempotent — webhook + verify may race).
  // The test is `status`, not `paymentStatus`: every row is marked paid, so the
  // old check also matched a registration the competitor had withdrawn from and
  // handed it back without reactivating it.
  const existingReg = await repo.registrations.findByUserAndComp(payment.userId, competitionId);
  if (isActiveRegistration(existingReg)) {
    if (!payment.registrationId) {
      await repo.payments.update(payment.id, { registrationId: existingReg!.id } as Partial<Payment>);
    }
    return existingReg!;
  }

  // Someone who withdrew and paid again reuses their row — unique
  // (user_id, competition_id) leaves no other option.
  let registration: Registration;
  if (existingReg) {
    await repo.registrations.update(existingReg.id, { status: "active", paymentStatus: "paid" });
    await repo.registrations.removeEvents(existingReg.id);
    registration = { ...existingReg, status: "active", paymentStatus: "paid" };
  } else {
    registration = {
      id: randomUUID(),
      userId: payment.userId,
      competitionId,
      paymentStatus: "paid",
      status: "active",
      createdAt: new Date().toISOString(),
    };
    await repo.registrations.create(registration);
  }

  for (const eid of eventIds) {
    await repo.registrations.addEvent(registration.id, eid);
  }

  await repo.payments.update(payment.id, { registrationId: registration.id } as Partial<Payment>);

  return registration;
}

export async function registerPaymentRoutes(
  app: FastifyInstance,
  repo: Repository,
): Promise<void> {
  // Create a Razorpay order (payment intent).
  // No registration is created yet — just stores the checkout intent on the payment record.
  app.post<{ Body: { competitionId?: string; eventIds?: string[]; promoCode?: string } }>(
    "/api/v1/payments/order",
    { preHandler: [submitLimiter, requireAuth] },
    async (req, reply) => {
      const { competitionId, eventIds: rawEventIds, promoCode } = req.body ?? {};
      if (!competitionId) return reply.code(400).send({ error: "missing_competition_id" });
      if (!Array.isArray(rawEventIds) || rawEventIds.length === 0) {
        return reply.code(400).send({ error: "no_events_selected" });
      }

      const comp = await repo.competitions.findById(competitionId);
      if (!comp) return reply.code(404).send({ error: "competition_not_found" });

      const status = effectiveCompStatus(comp);
      if (status !== "registration_open") {
        return reply.code(409).send({ error: "registration_not_open" });
      }

      const user = await repo.users.findById(req.authClaims!.sub);
      if (!user) return reply.code(403).send({ error: "not_synced" });

      // Already registered and paid?
      const existingReg = await repo.registrations.findByUserAndComp(user.id, comp.id);
      if (isActiveRegistration(existingReg)) {
        return reply.code(409).send({ error: "already_paid" });
      }

      const eventIds = [...new Set(rawEventIds as string[])];

      // Validate event IDs
      const compEvents = await repo.competitionEvents.findByCompetition(comp.id);
      const compEventIds = new Set(compEvents.map((e) => e.id));
      const compEventMap = new Map(compEvents.map((e) => [e.id, e]));
      for (const eid of eventIds) {
        if (!compEventIds.has(eid)) {
          return reply.code(400).send({ error: "invalid_event_id" });
        }
      }

      // Reuse existing pending payment order if one exists
      const pendingPayment = await repo.payments.findPendingByUserAndComp(user.id, comp.id);
      if (pendingPayment) {
        return reply.send({
          orderId: pendingPayment.razorpayOrderId,
          amount: pendingPayment.amount,
          currency: pendingPayment.currency,
          paymentId: pendingPayment.id,
          keyId: env.RAZORPAY_KEY_ID || null,
        });
      }

      // Calculate fee
      const eventFeeSum = eventIds.reduce((sum, eid) => {
        const ev = compEventMap.get(eid);
        return sum + (ev?.fee ?? comp.perEventFee);
      }, 0);
      let amount = comp.baseFee + eventFeeSum;

      let appliedPromoId: string | undefined;
      if (promoCode) {
        const promo = await repo.promoCodes.findByCode(promoCode.trim().toUpperCase());
        if (!promo || !promo.active) {
          return reply.code(400).send({ error: "invalid_promo_code" });
        }
        if (promo.competitionId && promo.competitionId !== comp.id) {
          return reply.code(400).send({ error: "promo_not_valid_for_competition" });
        }
        if (promo.competitionEventId && !eventIds.includes(promo.competitionEventId)) {
          return reply.code(400).send({ error: "promo_not_for_selected_events" });
        }
        if (promo.type === "competition") {
          const regOpen = status === "registration_open" || status === "published";
          if (!regOpen) {
            return reply.code(400).send({ error: "promo_registration_closed" });
          }
        }
        if (promo.type === "welcome") {
          // Asked of payments, not registrations: free competitions write
          // `payment_status = 'paid'` on their registrations, so the old check
          // treated joining a free competition as a first purchase and burned
          // the welcome promo the user had never used.
          const hasPaid = await repo.payments.hasCompletedPayment(user.id);
          if (hasPaid) {
            return reply.code(400).send({ error: "promo_welcome_only" });
          }
        }
        if (promo.type !== "competition") {
          const now = new Date().toISOString();
          if ((promo.validFrom && now < promo.validFrom) || (promo.validTo && now > promo.validTo)) {
            return reply.code(400).send({ error: "promo_expired" });
          }
        }
        if (promo.maxUsesPerUser > 0) {
          const userUses = await repo.promoCodes.userUsageCount(promo.id, user.id);
          if (userUses >= promo.maxUsesPerUser) {
            return reply.code(409).send({ error: "promo_already_used" });
          }
        }
        if (promo.competitionEventId) {
          const targetEvent = compEvents.find((e) => e.id === promo.competitionEventId);
          const eventFee = targetEvent?.fee ?? comp.perEventFee ?? 0;
          const discount = promo.discountType === "percentage"
            ? Math.round(eventFee * promo.discountValue / 100)
            : Math.min(promo.discountValue, eventFee);
          amount = Math.max(0, amount - discount);
        } else if (promo.discountType === "percentage") {
          amount = Math.max(0, Math.round(amount * (1 - promo.discountValue / 100)));
        } else {
          amount = Math.max(0, amount - promo.discountValue);
        }
        appliedPromoId = promo.id;
      }

      // If promo brings amount to 0, register immediately (same as free)
      if (amount === 0) {
        const payment: Payment = {
          id: randomUUID(),
          userId: user.id,
          competitionId: comp.id,
          eventIds: eventIds.join(","),
          amount: 0,
          currency: "INR",
          promoCodeId: appliedPromoId,
          status: "paid",
          createdAt: new Date().toISOString(),
        };
        if (appliedPromoId) {
          const redeemed = await repo.promoCodes.incrementUsed(appliedPromoId);
          if (!redeemed) throw Object.assign(new Error("promo_fully_redeemed"), { statusCode: 409 });
          await repo.promoCodes.recordUsage(appliedPromoId, user.id);
        }
        await repo.payments.create(payment);
        const reg = await fulfillRegistration(repo, payment);
        return reply.code(201).send({
          orderId: null,
          amount: 0,
          currency: "INR",
          paymentId: payment.id,
          registrationId: reg.id,
          status: "paid",
        });
      }

      // Create Razorpay order
      let orderId: string;
      const rzp = await getRazorpay();
      if (rzp) {
        try {
          const order = await rzp.orders.create({
            amount,
            currency: "INR",
            receipt: `${comp.id}_${user.id}`.slice(0, 40),
          });
          orderId = order.id as string;
        } catch (err) {
          req.log.error({ err, competitionId: comp.id }, "Razorpay order creation failed");
          return reply.code(502).send({ error: "payment_gateway_unavailable" });
        }
      } else {
        orderId = `order_${randomUUID().slice(0, 12)}`;
      }

      const payment: Payment = {
        id: randomUUID(),
        userId: user.id,
        competitionId: comp.id,
        eventIds: eventIds.join(","),
        amount,
        currency: "INR",
        razorpayOrderId: orderId,
        promoCodeId: appliedPromoId,
        status: "pending",
        createdAt: new Date().toISOString(),
      };
      if (appliedPromoId) {
        const redeemed = await repo.promoCodes.incrementUsed(appliedPromoId);
        if (!redeemed) throw Object.assign(new Error("promo_fully_redeemed"), { statusCode: 409 });
        await repo.promoCodes.recordUsage(appliedPromoId, user.id);
      }
      await repo.payments.create(payment);

      return reply.code(201).send({
        orderId,
        amount,
        currency: "INR",
        paymentId: payment.id,
        keyId: env.RAZORPAY_KEY_ID || null,
      });
    },
  );

  // Client-side checkout verification — creates the registration on success.
  app.post<{
    Body: {
      razorpay_order_id?: string;
      razorpay_payment_id?: string;
      razorpay_signature?: string;
    };
  }>(
    "/api/v1/payments/verify",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body ?? {};
      if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature)
        return reply.code(400).send({ error: "missing_fields" });

      if (!env.RAZORPAY_KEY_SECRET)
        return reply.code(500).send({ error: "razorpay_not_configured" });

      const expected = createHmac("sha256", env.RAZORPAY_KEY_SECRET)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest("hex");
      const sigBuf = Buffer.from(razorpay_signature);
      const expBuf = Buffer.from(expected);
      if (sigBuf.length !== expBuf.length || !timingSafeEqual(expBuf, sigBuf))
        return reply.code(400).send({ error: "invalid_signature" });

      const payment = await repo.payments.findByOrderId(razorpay_order_id);
      if (!payment) return reply.code(404).send({ error: "payment_not_found" });

      if (payment.userId !== req.authClaims!.sub)
        return reply.code(403).send({ error: "forbidden" });

      if (payment.status === "paid")
        return reply.send({ status: "already_confirmed", registrationId: payment.registrationId });

      const now = new Date().toISOString();
      await repo.payments.update(payment.id, { razorpayPaymentId: razorpay_payment_id, status: "paid" });

      // Create the registration now that payment is confirmed
      const reg = await fulfillRegistration(repo, { ...payment, status: "paid" });

      await repo.auditLog.create({
        id: randomUUID(), adminId: null as unknown as string, action: "payment_confirmed",
        target: payment.id, reason: `checkout verified: order=${razorpay_order_id} payment=${razorpay_payment_id}`,
        createdAt: now,
      });

      return { status: "confirmed", registrationId: reg.id };
    },
  );

  // Razorpay webhook — verify X-Razorpay-Signature header against raw body.
  app.register(async (scope) => {
    let rawBodyStore = "";
    scope.addHook("preParsing", async (req, _reply, payload) => {
      const chunks: Buffer[] = [];
      for await (const chunk of payload) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const buf = Buffer.concat(chunks);
      rawBodyStore = buf.toString("utf8");
      (req as unknown as { rawBody: string }).rawBody = rawBodyStore;
      const { Readable } = await import("node:stream");
      return Readable.from(buf);
    });

    scope.post("/api/v1/payments/webhook", async (req, reply) => {
      const rawBody = (req as unknown as { rawBody: string }).rawBody;
      const body = req.body as Record<string, unknown> | undefined;
      if (!body) return reply.code(400).send({ error: "missing_body" });

      const headerSig = req.headers["x-razorpay-signature"] as string | undefined;

      if (!env.RAZORPAY_WEBHOOK_SECRET) {
        return reply.code(500).send({ error: "webhook_secret_not_configured" });
      }

      if (!headerSig) return reply.code(400).send({ error: "missing_signature" });

      const expected = createHmac("sha256", env.RAZORPAY_WEBHOOK_SECRET)
        .update(rawBody ?? "")
        .digest("hex");
      const whSigBuf = Buffer.from(headerSig);
      const whExpBuf = Buffer.from(expected);
      if (whSigBuf.length !== whExpBuf.length || !timingSafeEqual(whExpBuf, whSigBuf))
        return reply.code(400).send({ error: "invalid_signature" });

      const event = body.event as string | undefined;
      const paymentEntity = (body.payload as Record<string, unknown>)?.payment as Record<string, unknown> | undefined;
      const entity = paymentEntity?.entity as Record<string, unknown> | undefined;

      if (!entity) return reply.code(400).send({ error: "invalid_payload" });

      const rzpOrderId = entity.order_id as string | undefined;
      const rzpPaymentId = entity.id as string | undefined;

      if (!rzpOrderId || !rzpPaymentId)
        return reply.code(400).send({ error: "missing_fields" });

      const payment = await repo.payments.findByOrderId(rzpOrderId);
      if (!payment) return reply.code(404).send({ error: "payment_not_found" });

      if (event === "payment.captured" || event === "order.paid") {
        if (payment.status === "paid") return { status: "already_confirmed" };

        const now = new Date().toISOString();
        await repo.payments.update(payment.id, { razorpayPaymentId: rzpPaymentId, status: "paid" });

        // Create registration (idempotent — safe if verify already did it)
        await fulfillRegistration(repo, { ...payment, status: "paid" });

        await repo.auditLog.create({
          id: randomUUID(), adminId: null as unknown as string, action: "payment_confirmed",
          target: payment.id, reason: `webhook ${event}: order=${rzpOrderId} payment=${rzpPaymentId}`,
          createdAt: now,
        });
        return { status: "confirmed" };
      }

      if (event === "payment.failed") {
        if (payment.status === "paid") return { status: "already_paid_ignoring_failure" };
        await repo.payments.update(payment.id, { razorpayPaymentId: rzpPaymentId, status: "failed" });
        // No registration to update — it was never created
        return { status: "marked_failed" };
      }

      return { status: "ignored", event };
    });
  });

  // GST Invoice PDF download
  app.get<{ Params: { id: string } }>(
    "/api/v1/payments/:id/invoice",
    { preHandler: requireAuth },
    async (req, reply) => {
      const payment = await repo.payments.findById(req.params.id);
      if (!payment) return reply.code(404).send({ error: "payment_not_found" });

      if (payment.status !== "paid")
        return reply.code(409).send({ error: "payment_not_completed" });

      const user = await repo.users.findById(payment.userId);
      if (!user) return reply.code(404).send({ error: "user_not_found" });

      const requester = await repo.users.findById(req.authClaims!.sub);
      // `role !== "admin"` omitted super_admin, so a super admin could not
      // download another user's invoice.
      if (!requester || (requester.id !== user.id && !isAdmin(requester)))
        return reply.code(403).send({ error: "forbidden" });

      const reg = payment.registrationId ? await repo.registrations.findById(payment.registrationId) : null;
      const comp = reg ? await repo.competitions.findById(reg.competitionId) : (payment.competitionId ? await repo.competitions.findById(payment.competitionId) : null);
      const regEvents = reg ? await repo.registrations.findEvents(reg.id) : [];

      const hasCustomFees = regEvents.some((e) => e.fee != null);
      const data: InvoiceData = {
        invoiceNumber: `INV-${payment.createdAt.slice(0, 10).replace(/-/g, "")}-${payment.id.slice(0, 8).toUpperCase()}`,
        date: new Date(payment.createdAt).toLocaleDateString("en-IN", {
          year: "numeric", month: "long", day: "numeric",
        }),
        buyerName: user.name,
        buyerEmail: user.email,
        buyerClId: user.clId,
        competitionTitle: comp?.title ?? "Unknown",
        events: regEvents.map((e) => e.eventType),
        baseFee: comp?.baseFee ?? 0,
        perEventFee: comp?.perEventFee ?? 0,
        eventCount: regEvents.length,
        eventFees: hasCustomFees
          ? regEvents.map((e) => ({ name: e.eventType, fee: e.fee ?? comp?.perEventFee ?? 0 }))
          : undefined,
        totalAmount: payment.amount,
        paymentId: payment.id,
        razorpayPaymentId: payment.razorpayPaymentId,
      };

      const pdf = generateInvoicePDF(data);
      const filename = `invoice_${data.invoiceNumber}.pdf`;

      reply
        .header("Content-Type", "application/pdf")
        .header("Content-Disposition", `attachment; filename="${filename}"`);

      return reply.send(pdf);
    },
  );
}
