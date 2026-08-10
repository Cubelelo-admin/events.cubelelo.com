import type { FastifyInstance } from "fastify";
import type { Repository } from "../../db/repo";
import { resolveUser, requireAuth } from "../../auth/plugin";
import { effectiveCompStatus, effectiveRoundStatus } from "../../lib/statusUtils";

export async function registerCompetitionRoutes(
  app: FastifyInstance,
  repo: Repository,
): Promise<void> {
  // Public announcements
  app.get("/api/v1/announcements", async () => {
    return repo.announcements.findAll(true);
  });

  // Featured competitions for the homepage
  app.get("/api/v1/competitions/featured", async () => {
    const all = await repo.competitions.findAll();
    return all
      .filter((c) => {
        const s = effectiveCompStatus(c);
        return c.featured && s !== "draft" && s !== "cancelled";
      })
      .sort((a, b) => (a.featuredOrder ?? 99) - (b.featuredOrder ?? 99))
      .map((c) => ({
        id: c.id, title: c.title, type: c.type,
        status: effectiveCompStatus(c),
        description: c.description,
        coverUrl: c.coverUrl, coverCaption: c.coverCaption, bannerUrl: c.bannerUrl, mobileBannerUrl: c.mobileBannerUrl,
        registrationOpensAt: c.registrationOpensAt ?? null,
        registrationDeadline: c.registrationDeadline ?? null,
        startsAt: c.startsAt ?? null,
        endsAt: c.endsAt ?? null,
        featuredOrder: c.featuredOrder,
      }));
  });

  // List competitions with optional status filter.
  app.get<{ Querystring: { status?: string } }>(
    "/api/v1/competitions",
    async (req) => {
      const caller = await resolveUser(repo, req);
      const isFullAdmin = caller?.role === "admin" || caller?.role === "super_admin";
      const isMod = caller?.role === "moderator";
      const isAdmin = isFullAdmin || isMod;

      let comps = await repo.competitions.findAll();

      if (!isAdmin) {
        comps = comps.filter((c) => {
          const s = effectiveCompStatus(c);
          return s !== "draft" && s !== "cancelled" && s !== "published";
        });
      }

      // Moderators only see their own competitions for admin-level views (draft filter)
      if (isMod && caller) {
        comps = comps.filter((c) => {
          const s = effectiveCompStatus(c);
          // Show published/live/completed competitions to everyone, but drafts only if owned
          if (s === "draft" || s === "cancelled" || s === "published") {
            return c.createdBy === caller.id;
          }
          return true;
        });
      }

      const filter = req.query?.status;
      if (filter === "upcoming") {
        comps = comps.filter((c) => {
          const s = effectiveCompStatus(c);
          return s === "upcoming" || s === "registration_open" || s === "registration_closed";
        });
      } else if (filter === "live") {
        comps = comps.filter((c) => effectiveCompStatus(c) === "live");
      } else if (filter === "past") {
        comps = comps.filter((c) => {
          const s = effectiveCompStatus(c);
          return s === "completed" || s === "results_pending";
        });
      } else if (filter === "draft" && isAdmin) {
        comps = comps.filter((c) => c.status === "draft");
      }

      const compIds = comps.map((c) => c.id);
      const [eventsMap, regCountMap] = await Promise.all([
        repo.competitionEvents.findByCompetitions(compIds),
        repo.competitions.countRegistrationsBatch(compIds),
      ]);

      return comps.map((c) => ({
        id: c.id,
        title: c.title,
        type: c.type,
        status: effectiveCompStatus(c),
        description: c.description,
        baseFee: c.baseFee,
        perEventFee: c.perEventFee,
        registrationOpensAt: c.registrationOpensAt ?? null,
        registrationDeadline: c.registrationDeadline ?? null,
        startsAt: c.startsAt ?? null,
        endsAt: c.endsAt ?? null,
        coverUrl: c.coverUrl, bannerUrl: c.bannerUrl, mobileBannerUrl: c.mobileBannerUrl,
        featured: c.featured,
        featuredOrder: c.featuredOrder,
        createdAt: c.createdAt,
        createdBy: c.createdBy ?? null,
        eventTypes: (eventsMap.get(c.id) ?? []).filter((e) => !e.archived).map((e) => e.eventType),
        registrationCount: regCountMap.get(c.id) ?? 0,
        registrationLimit: c.registrationLimit ?? null,
        cancellationReason: c.cancellationReason ?? null,
      }));
    },
  );

  // Competition detail with events and rounds.
  app.get<{ Params: { id: string } }>(
    "/api/v1/competitions/:id",
    async (req, reply) => {
      const competition = await repo.competitions.findById(req.params.id);
      if (!competition) return reply.code(404).send({ error: "competition_not_found" });

      const caller = await resolveUser(repo, req);
      const isAdmin = caller?.role === "admin" || caller?.role === "super_admin" || caller?.role === "moderator";
      const effStatus = effectiveCompStatus(competition);

      // Non-admins cannot see draft competitions
      if (!isAdmin && effStatus === "draft") {
        return reply.code(404).send({ error: "competition_not_found" });
      }

      const [events, rounds, regCount, publisher] = await Promise.all([
        repo.competitionEvents.findByCompetition(competition.id),
        repo.rounds.findByCompetition(competition.id),
        repo.competitions.countRegistrations(competition.id),
        competition.publishedBy ? repo.users.findById(competition.publishedBy) : null,
      ]);

      // Batch fetch all scramble sets for this competition's rounds (eliminates N+1)
      const scrambleMap = await repo.scrambleSets.findByRounds(rounds.map((r) => r.id));

      return {
        id: competition.id,
        title: competition.title,
        type: competition.type,
        status: effStatus,
        description: competition.description,
        rulesMd: competition.rulesMd,
        baseFee: competition.baseFee,
        perEventFee: competition.perEventFee,
        registrationOpensAt: competition.registrationOpensAt ?? null,
        registrationDeadline: competition.registrationDeadline ?? null,
        startsAt: competition.startsAt ?? null,
        endsAt: competition.endsAt ?? null,
        coverUrl: competition.coverUrl,
        bannerUrl: competition.bannerUrl,
        mobileBannerUrl: competition.mobileBannerUrl,
        featured: competition.featured,
        createdBy: competition.createdBy,
        publishedBy: competition.publishedBy ?? null,
        publishedByName: publisher?.name ?? null,
        createdAt: competition.createdAt,
        registrationCount: regCount,
        registrationLimit: competition.registrationLimit ?? null,
        cancellationReason: competition.cancellationReason ?? null,
        videoDeadlineMinutes: competition.videoDeadlineMinutes,
        events: events.filter((e) => isAdmin || !e.archived).map((e) => {
          const eventRounds = rounds
            .filter((r) => r.competitionEventId === e.id)
            .sort((a, b) => a.roundNumber - b.roundNumber);

          return {
            id: e.id,
            eventType: e.eventType,
            roundCount: e.roundCount,
            cutoffMs: e.cutoffMs,
            timeLimitMs: e.timeLimitMs,
            fee: e.fee,
            archived: e.archived ?? false,
            rounds: eventRounds.map((r) => ({
              id: r.id,
              roundNumber: r.roundNumber,
              status: effectiveRoundStatus(r),
              eventType: e.eventType,
              opensAt: r.opensAt ?? null,
              closesAt: r.closesAt ?? null,
              advancementCount: r.advancementCount ?? null,
              advancementCriteria: r.advancementCriteria ?? null,
              scrambleLocked: Boolean(scrambleMap.get(r.id)?.lockedAt),
              resultsPublishedAt: r.resultsPublishedAt ?? null,
            })),
          };
        }),
      };
    },
  );

  // User's progression status for a competition
  app.get<{ Params: { id: string } }>(
    "/api/v1/competitions/:id/my-progress",
    { preHandler: requireAuth },
    async (req, reply) => {
      const competition = await repo.competitions.findById(req.params.id);
      if (!competition) return reply.code(404).send({ error: "competition_not_found" });

      const user = await repo.users.findById(req.authClaims!.sub);
      if (!user) return reply.code(403).send({ error: "not_synced" });

      const reg = await repo.registrations.findByUserAndComp(user.id, competition.id);
      if (!reg) return { registered: false, rounds: [] };

      const events = await repo.competitionEvents.findByCompetition(competition.id);
      const rounds = await repo.rounds.findByCompetition(competition.id);
      const userResults = await repo.results.findByUser(user.id);

      const roundProgress = await Promise.all(
        rounds
          .sort((a, b) => a.roundNumber - b.roundNumber)
          .map(async (r) => {
            const event = events.find((e) => e.id === r.competitionEventId);
            const status = effectiveRoundStatus(r);
            const result = userResults.find((res) => res.roundId === r.id);
            const advanced = r.roundNumber > 1
              ? await repo.advancements.isAdvanced(r.id, user.id)
              : true;

            let userStatus: string;
            if (result) {
              if (status === "closed" || status === "advanced") {
                const adv = await repo.advancements.findByRound(r.id);
                const qualified = adv.some((a) => a.userId === user.id);
                userStatus = qualified ? "qualified" : (adv.length > 0 ? "eliminated" : "result_pending");
              } else {
                userStatus = "submitted";
              }
            } else if (status === "cancelled") {
              userStatus = "cancelled";
            } else if (status === "open" && advanced) {
              userStatus = "active";
            } else if (status === "pending") {
              userStatus = advanced ? "upcoming" : "locked";
            } else {
              userStatus = advanced ? "not_submitted" : "locked";
            }

            return {
              roundId: r.id,
              roundNumber: r.roundNumber,
              eventType: event?.eventType ?? null,
              status,
              userStatus,
              result: result ? { id: result.id, rank: result.rank, ao5Ms: result.ao5Ms, bestSingleMs: result.bestSingleMs, videoUrl: result.videoUrl, solves: result.solves } : null,
            };
          }),
      );

      return { registered: true, rounds: roundProgress };
    },
  );

  // Live ranking for a competition event's active round
  app.get<{ Params: { id: string }; Querystring: { event?: string } }>(
    "/api/v1/competitions/:id/live-ranking",
    async (req, reply) => {
      const competition = await repo.competitions.findById(req.params.id);
      if (!competition) return reply.code(404).send({ error: "competition_not_found" });

      const events = await repo.competitionEvents.findByCompetition(competition.id);
      const eventFilter = req.query.event;
      const targetEvent = eventFilter
        ? events.find((e) => e.eventType === eventFilter)
        : events[0];
      if (!targetEvent) return reply.code(404).send({ error: "event_not_found" });

      const rounds = await repo.rounds.findByCompetition(competition.id);
      const eventRounds = rounds
        .filter((r) => r.competitionEventId === targetEvent.id)
        .sort((a, b) => a.roundNumber - b.roundNumber);

      // Find the latest round with results (active or closed)
      let activeRound = eventRounds.find((r) => effectiveRoundStatus(r) === "open");
      if (!activeRound) {
        activeRound = [...eventRounds].reverse().find((r) => {
          const s = effectiveRoundStatus(r);
          return s === "closed" || s === "advanced";
        });
      }
      if (!activeRound) return { roundId: null, roundNumber: null, ranking: [] };

      const results = await repo.results.findByRound(activeRound.id);
      const userIds = [...new Set(results.map((r) => r.userId))];
      const usersMap = await repo.users.findByIds(userIds);
      const ranking = results.map((r) => {
        const u = usersMap.get(r.userId);
        return {
          resultId: r.id,
          userId: r.userId,
          clId: u?.clId ?? r.userId,
          name: u?.name ?? "Unknown",
          rank: r.rank,
          ao5Ms: r.ao5Ms,
          bestSingleMs: r.bestSingleMs,
          flagStatus: r.flagStatus,
        };
      });

      ranking.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));

      return {
        roundId: activeRound.id,
        roundNumber: activeRound.roundNumber,
        eventType: targetEvent.eventType,
        ranking,
      };
    },
  );

  // Live competition view — comp metadata + active round + leaderboard in one request.
  // Designed for 500 concurrent competitors: minimal queries, no N+1.
  app.get<{ Params: { id: string } }>(
    "/api/v1/competitions/:id/live",
    async (req, reply) => {
      const competition = await repo.competitions.findById(req.params.id);
      if (!competition) return reply.code(404).send({ error: "competition_not_found" });

      const effStatus = effectiveCompStatus(competition);
      if (effStatus === "draft") return reply.code(404).send({ error: "competition_not_found" });

      const [events, rounds] = await Promise.all([
        repo.competitionEvents.findByCompetition(competition.id),
        repo.rounds.findByCompetition(competition.id),
      ]);

      // Find the single active round across the entire competition
      let activeRound = rounds.find((r) => effectiveRoundStatus(r) === "open");
      // Fallback: most recently closed/advanced round (for viewing results after close)
      if (!activeRound) {
        activeRound = [...rounds]
          .filter((r) => {
            const s = effectiveRoundStatus(r);
            return s === "closed" || s === "advanced";
          })
          .sort((a, b) => {
            const ta = a.closesAt ? new Date(a.closesAt).getTime() : 0;
            const tb = b.closesAt ? new Date(b.closesAt).getTime() : 0;
            return tb - ta;
          })[0];
      }

      const activeEvent = activeRound
        ? events.find((e) => e.id === activeRound!.competitionEventId)
        : null;

      // Build leaderboard + user progress for the active round only
      let leaderboard: { userId: string; userName: string; userClId: string; rank: number | null; ao5Ms: number | null; bestSingleMs: number | null; flagStatus: string }[] = [];
      let userResult: { id: string; rank: number | null; ao5Ms: number | null; bestSingleMs: number | null; flagStatus: string } | null = null;

      if (activeRound) {
        const results = await repo.results.findByRound(activeRound.id);
        const userIds = [...new Set(results.map((r) => r.userId))];
        const usersMap = await repo.users.findByIds(userIds);

        leaderboard = results
          .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity))
          .map((r) => {
            const u = usersMap.get(r.userId);
            return {
              userId: r.userId,
              userName: u?.name ?? "Unknown",
              userClId: u?.clId ?? r.userId,
              rank: r.rank,
              ao5Ms: r.ao5Ms,
              bestSingleMs: r.bestSingleMs,
              flagStatus: r.flagStatus,
            };
          });

        // Caller's own result (if authenticated)
        if (req.authClaims?.sub) {
          const caller = await repo.users.findById(req.authClaims.sub);
          if (caller) {
            const myResult = results.find((r) => r.userId === caller.id);
            if (myResult) {
              userResult = {
                id: myResult.id,
                rank: myResult.rank,
                ao5Ms: myResult.ao5Ms,
                bestSingleMs: myResult.bestSingleMs,
                flagStatus: myResult.flagStatus,
              };
            }
          }
        }
      }

      // Round summary — minimal metadata per round (no scramble lookups, no result counts)
      const eventSummaries = events.filter((e) => !e.archived).map((e) => {
        const eventRounds = rounds
          .filter((r) => r.competitionEventId === e.id)
          .sort((a, b) => a.roundNumber - b.roundNumber);
        return {
          id: e.id,
          eventType: e.eventType,
          roundCount: e.roundCount,
          rounds: eventRounds.map((r) => ({
            id: r.id,
            roundNumber: r.roundNumber,
            status: effectiveRoundStatus(r),
            opensAt: r.opensAt ?? null,
            closesAt: r.closesAt ?? null,
          })),
        };
      });

      return {
        competition: {
          id: competition.id,
          title: competition.title,
          type: competition.type,
          status: effStatus,
          startsAt: competition.startsAt ?? null,
          endsAt: competition.endsAt ?? null,
          videoDeadlineMinutes: competition.videoDeadlineMinutes,
          cancellationReason: competition.cancellationReason ?? null,
        },
        events: eventSummaries,
        activeRound: activeRound ? {
          id: activeRound.id,
          roundNumber: activeRound.roundNumber,
          status: effectiveRoundStatus(activeRound),
          eventId: activeRound.competitionEventId,
          eventType: activeEvent?.eventType ?? null,
          opensAt: activeRound.opensAt ?? null,
          closesAt: activeRound.closesAt ?? null,
        } : null,
        leaderboard,
        userResult,
      };
    },
  );

  // Event detail page — combines competition, event, rounds, and user progress
  app.get<{ Params: { id: string; eventId: string } }>(
    "/api/v1/competitions/:id/event/:eventId",
    async (req, reply) => {
      const competition = await repo.competitions.findById(req.params.id);
      if (!competition) return reply.code(404).send({ error: "competition_not_found" });

      const effComp = effectiveCompStatus(competition);
      if (effComp === "draft") return reply.code(404).send({ error: "competition_not_found" });

      const events = await repo.competitionEvents.findByCompetition(competition.id);
      const event = events.find((e) => e.id === req.params.eventId);
      if (!event) return reply.code(404).send({ error: "event_not_found" });

      const allRounds = await repo.rounds.findByCompetition(competition.id);
      const eventRounds = allRounds
        .filter((r) => r.competitionEventId === event.id)
        .sort((a, b) => a.roundNumber - b.roundNumber);

      const roundIds = eventRounds.map((r) => r.id);

      // Batch fetch results, advancements, and registrations (eliminates N+1)
      const [allResults, advMap, regs] = await Promise.all([
        repo.results.findByRounds(roundIds),
        repo.advancements.findByRounds(roundIds),
        repo.registrations.findByCompetition(competition.id),
      ]);

      const paidRegs = regs.filter((r) => r.paymentStatus === "paid" || competition.type === "free" || competition.type === "practice");
      const eventsByReg = await repo.registrations.findEventsForAll(paidRegs.map((r) => r.id));
      const r1Participants = paidRegs.filter((r) =>
        (eventsByReg.get(r.id) ?? []).some((e) => e.id === event.id),
      ).length;

      // Group results by round
      const resultsByRound = new Map<string, typeof allResults>();
      for (const r of allResults) {
        const list = resultsByRound.get(r.roundId);
        if (list) list.push(r);
        else resultsByRound.set(r.roundId, [r]);
      }

      const rounds = eventRounds.map((r) => {
        const results = resultsByRound.get(r.id) ?? [];
        const advancements = advMap.get(r.id) ?? [];
        return {
          id: r.id,
          roundNumber: r.roundNumber,
          status: effectiveRoundStatus(r),
          opensAt: r.opensAt ?? null,
          closesAt: r.closesAt ?? null,
          advancementCriteria: r.advancementCriteria ?? null,
          resultCount: results.length,
          participantCount: r.roundNumber === 1 ? r1Participants : advancements.length,
        };
      });

      // User progress (if authenticated)
      let userStatus: { registered: boolean; rounds: unknown[] } | null = null;
      if (req.authClaims?.sub) {
        const user = await repo.users.findById(req.authClaims.sub);
        if (user) {
          const reg = await repo.registrations.findByUserAndComp(user.id, competition.id);
          if (reg) {
            const userResults = await repo.results.findByUser(user.id);
            const roundProgress = eventRounds.map((r) => {
              const status = effectiveRoundStatus(r);
              const result = userResults.find((res) => res.roundId === r.id);
              const adv = advMap.get(r.id) ?? [];
              const advanced = r.roundNumber > 1
                ? adv.some((a) => a.userId === user.id)
                : true;

              let userRoundStatus: string;
              if (result) {
                if (status === "closed" || status === "advanced") {
                  const qualified = adv.some((a) => a.userId === user.id);
                  userRoundStatus = qualified ? "qualified" : (adv.length > 0 ? "eliminated" : "result_pending");
                } else {
                  userRoundStatus = "submitted";
                }
              } else if (status === "cancelled") {
                userRoundStatus = "cancelled";
              } else if (status === "open" && advanced) {
                userRoundStatus = "active";
              } else if (status === "pending") {
                userRoundStatus = advanced ? "upcoming" : "locked";
              } else {
                userRoundStatus = advanced ? "not_submitted" : "locked";
              }

              return {
                roundId: r.id,
                roundNumber: r.roundNumber,
                userStatus: userRoundStatus,
                result: result
                  ? { id: result.id, rank: result.rank, ao5Ms: result.ao5Ms, bestSingleMs: result.bestSingleMs, videoUrl: result.videoUrl }
                  : null,
              };
            });
            userStatus = { registered: true, rounds: roundProgress };
          } else {
            userStatus = { registered: false, rounds: [] };
          }
        }
      }

      // Final standings for the last round (top finishers / winners)
      let finalStandings: { rank: number; userId: string; displayName: string }[] | null = null;
      const lastRound = eventRounds[eventRounds.length - 1];
      if (lastRound && effectiveRoundStatus(lastRound) === "advanced") {
        const adv = advMap.get(lastRound.id) ?? [];
        if (adv.length > 0) {
          const usersMap = await repo.users.findByIds(adv.map((a) => a.userId));
          const entries = adv.map((a) => {
            const u = usersMap.get(a.userId);
            return { rank: a.rank, userId: a.userId, displayName: u?.name ?? u?.wcaId ?? "Unknown" };
          });
          finalStandings = entries.sort((a, b) => a.rank - b.rank);
        }
      }

      return {
        competition: {
          id: competition.id,
          title: competition.title,
          status: effComp,
          rulesMd: competition.rulesMd ?? null,
          startsAt: competition.startsAt ?? null,
          endsAt: competition.endsAt ?? null,
          type: competition.type,
          cancellationReason: competition.cancellationReason ?? null,
          videoDeadlineMinutes: competition.videoDeadlineMinutes,
        },
        event: {
          id: event.id,
          eventType: event.eventType,
          roundCount: event.roundCount,
          cutoffMs: event.cutoffMs ?? null,
          timeLimitMs: event.timeLimitMs ?? null,
          fee: event.fee,
        },
        rounds,
        userStatus,
        finalStandings,
      };
    },
  );

  // Participant list for a competition
  app.get<{ Params: { id: string } }>(
    "/api/v1/competitions/:id/participants",
    async (req, reply) => {
      const competition = await repo.competitions.findById(req.params.id);
      if (!competition) return reply.code(404).send({ error: "competition_not_found" });

      const regs = (await repo.registrations.findByCompetition(competition.id))
        .filter((r) => r.paymentStatus === "paid" || competition.type === "free" || competition.type === "practice");

      const [usersMap, eventsByReg] = await Promise.all([
        repo.users.findByIds([...new Set(regs.map((r) => r.userId))]),
        repo.registrations.findEventsForAll(regs.map((r) => r.id)),
      ]);

      const participants = regs.map((reg) => {
        const u = usersMap.get(reg.userId);
        return {
          userId: reg.userId,
          clId: u?.clId ?? reg.userId,
          name: u?.name ?? "Unknown",
          city: u?.city ?? null,
          country: u?.country ?? null,
          eventTypes: (eventsByReg.get(reg.id) ?? []).map((e) => e.eventType),
          registeredAt: reg.createdAt,
        };
      });

      return { count: participants.length, participants };
    },
  );

  // Public rankings — personal bests grouped by event
  app.get<{ Querystring: { event?: string; page?: string; limit?: string } }>(
    "/api/v1/rankings",
    async (req) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 100, 1), 500);
      const page = Math.max(Number(req.query.page) || 1, 1);

      const { rows: paged, total } = await repo.personalBests.findRanked(
        req.query.event,
        limit,
        (page - 1) * limit,
      );

      const userIds = [...new Set(paged.map((pb) => pb.userId))];
      const usersMap = await repo.users.findByIds(userIds);

      const entries = paged.map((pb) => {
        const u = usersMap.get(pb.userId);
        return {
          userId: pb.userId,
          clId: u?.clId ?? pb.userId,
          name: u?.name ?? "Unknown",
          eventType: pb.eventType,
          bestSingleMs: pb.bestSingleMs,
          bestAo5Ms: pb.bestAo5Ms,
        };
      });

      return { rankings: entries, total, page, limit };
    },
  );
}
