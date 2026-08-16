import type { Repository } from "./repo";
import type {
  User,
  Competition,
  CompetitionEvent,
  Round,
  ScrambleSet,
  Result,
  Registration,
  RegistrationEvent,
  Payment,
  AuditLogEntry,
  PersonalBest,
  PracticeSession,
  PracticeSolve,
  DailyChallenge,
  DailyChallengeResult,
  Announcement,
  RoundAdvancement,
  PromoCode,
  Appeal,
  WithdrawalRequest,
  RankTier,
  Banner,
  FaqEntry,
  ContentPage,
  JudgeAssignment,
  SystemSettings,
  RuleSet,
} from "./types";

/**
 * In-memory Repository — zero dependencies, instant startup.
 * Used when DATABASE_URL is not set (local dev / CI without Postgres).
 * All data is lost on process restart.
 */
export function createMemRepo(): Repository {
  const users = new Map<string, User>();
  const competitions = new Map<string, Competition>();
  const competitionEvents = new Map<string, CompetitionEvent>();
  const rounds = new Map<string, Round>();
  const scrambleSets = new Map<string, ScrambleSet>();
  const results = new Map<string, Result>();
  const registrations = new Map<string, Registration>();
  const registrationEvents: RegistrationEvent[] = [];
  const payments = new Map<string, Payment>();
  const auditLogEntries: AuditLogEntry[] = [];
  const verificationTokenStore = new Map<string, { id: string; userId: string; type: string; token: string; identifier?: string; expiresAt: number }>();
  const announcements = new Map<string, Announcement>();
  const roundAdvancements = new Map<string, RoundAdvancement[]>();
  const personalBests = new Map<string, PersonalBest>();
  const practiceSessions = new Map<string, PracticeSession>();
  const practiceSolves: PracticeSolve[] = [];
  const dailyChallenges = new Map<string, DailyChallenge>();
  const dailyChallengeResults: DailyChallengeResult[] = [];
  const appeals = new Map<string, Appeal>();
  const withdrawalRequests = new Map<string, WithdrawalRequest>();
  const rankTiers = new Map<string, RankTier>();
  const promoCodes = new Map<string, PromoCode>();
  /** One entry per redemption — counting them is the whole point. */
  const promoCodeUsages: { promoCodeId: string; userId: string }[] = [];
  const bannerStore = new Map<string, Banner>();
  const faqStore = new Map<string, FaqEntry>();
  const contentPageStore = new Map<string, ContentPage>();
  const judgeAssignmentStore = new Map<string, JudgeAssignment>();
  const roster = new Map<string, Map<string, string>>();
  const clSeq = new Map<number, number>();

  function nextClIdSync(): string {
    const year = new Date().getFullYear();
    const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    for (let attempt = 0; attempt < 20; attempt++) {
      let code = "";
      for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
      const clId = `CL-${year}-${code}`;
      if (![...users.values()].some((u) => u.clId === clId)) return clId;
    }
    throw new Error("Failed to generate unique CL ID");
  }

  return {
    users: {
      async findAll(search) {
        const all = [...users.values()];
        if (!search) return all;
        const q = search.toLowerCase();
        return all.filter(
          (u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q) || u.clId.toLowerCase().includes(q),
        );
      },
      async findPaginated({ search, limit, offset }) {
        const all = await this.findAll(search);
        return { rows: all.slice(offset, offset + limit), total: all.length };
      },
      async findById(id) { return users.get(id) ?? null; },
      async findByIds(ids) {
        const map = new Map<string, import("./types").User>();
        for (const id of ids) {
          const u = users.get(id);
          if (u) map.set(id, u);
        }
        return map;
      },
      async findByEmail(email) {
        return [...users.values()].find((u) => u.email === email) ?? null;
      },
      async findByMobileNo(mobileNo) {
        return [...users.values()].find((u) => u.mobileNo === mobileNo) ?? null;
      },
      async findByClId(clId) {
        return [...users.values()].find((u) => u.clId === clId) ?? null;
      },
      async create(user) { users.set(user.id, user); },
      async update(id, fields) {
        const user = users.get(id);
        if (!user) return null;
        Object.assign(user, fields);
        return user;
      },
      async migrateId(oldId, newId) {
        const user = users.get(oldId);
        if (user) {
          user.supabaseId = newId;
        }
      },
      async findBySupabaseId(supabaseId) {
        return [...users.values()].find((u) => u.supabaseId === supabaseId) ?? null;
      },
      async delete(id) { users.delete(id); },
      async nextClId() { return nextClIdSync(); },
    },

    competitions: {
      async findAll(search) {
        const all = [...competitions.values()];
        if (!search) return all;
        const q = search.toLowerCase();
        return all.filter((c) => c.title.toLowerCase().includes(q) || c.description?.toLowerCase().includes(q));
      },
      async findById(id) { return competitions.get(id) ?? null; },
      async findByTitle(title) {
        const t = title.toLowerCase();
        return [...competitions.values()].find((c) => c.title.toLowerCase() === t && c.status !== "cancelled") ?? null;
      },
      async findByIds(ids) {
        const map = new Map<string, Competition>();
        for (const id of ids) {
          const c = competitions.get(id);
          if (c) map.set(id, c);
        }
        return map;
      },
      async create(comp) { competitions.set(comp.id, comp); },
      async update(id, fields) {
        const comp = competitions.get(id);
        if (!comp) return null;
        Object.assign(comp, fields);
        return comp;
      },
      async delete(id) { competitions.delete(id); },
      async countRegistrations(compId) {
        return [...registrations.values()].filter((r) => r.competitionId === compId).length;
      },
      async countRegistrationsBatch(ids) {
        const map = new Map<string, number>();
        for (const id of ids) map.set(id, 0);
        for (const r of registrations.values()) {
          if (map.has(r.competitionId)) map.set(r.competitionId, (map.get(r.competitionId) ?? 0) + 1);
        }
        return map;
      },
    },

    competitionEvents: {
      async findById(id) { return competitionEvents.get(id) ?? null; },
      async findByCompetition(compId) {
        return [...competitionEvents.values()].filter((e) => e.competitionId === compId);
      },
      async findByCompetitions(compIds) {
        const set = new Set(compIds);
        const map = new Map<string, import("./types").CompetitionEvent[]>();
        for (const id of compIds) map.set(id, []);
        for (const e of competitionEvents.values()) {
          if (set.has(e.competitionId)) map.get(e.competitionId)!.push(e);
        }
        return map;
      },
      async findByRound(roundId) {
        const round = rounds.get(roundId);
        if (!round) return null;
        return competitionEvents.get(round.competitionEventId) ?? null;
      },
      async findByRounds(roundIds) {
        const map = new Map<string, import("./types").CompetitionEvent>();
        for (const rid of roundIds) {
          const round = rounds.get(rid);
          if (!round) continue;
          const ev = competitionEvents.get(round.competitionEventId);
          if (ev) map.set(rid, ev);
        }
        return map;
      },
      async create(event) { competitionEvents.set(event.id, event); },
      async update(id, fields) {
        const ev = competitionEvents.get(id);
        if (!ev) return null;
        Object.assign(ev, fields);
        return ev;
      },
      async delete(id) { competitionEvents.delete(id); },
    },

    rounds: {
      async findById(id) { return rounds.get(id) ?? null; },
      async findAll() { return [...rounds.values()]; },
      async findActive() {
        return [...rounds.values()].filter((r) => r.status !== "advanced" && r.status !== "cancelled");
      },
      async findByCompetition(compId) {
        const eventIds = new Set(
          [...competitionEvents.values()]
            .filter((e) => e.competitionId === compId)
            .map((e) => e.id),
        );
        return [...rounds.values()].filter((r) => eventIds.has(r.competitionEventId));
      },
      async create(round) { rounds.set(round.id, round); },
      async update(id, fields) {
        const round = rounds.get(id);
        if (!round) return null;
        Object.assign(round, fields);
        return round;
      },
      async delete(id) { rounds.delete(id); },
      async compareAndUpdateStatus(id, expectedStatus, newStatus) {
        const round = rounds.get(id);
        if (!round || round.status !== expectedStatus) return false;
        round.status = newStatus as typeof round.status;
        return true;
      },
    },

    scrambleSets: {
      async findByRound(roundId) {
        return [...scrambleSets.values()].find((s) => s.roundId === roundId) ?? null;
      },
      async findByRounds(roundIds) {
        const wanted = new Set(roundIds);
        const map = new Map<string, ScrambleSet>();
        for (const s of scrambleSets.values()) {
          if (wanted.has(s.roundId)) map.set(s.roundId, s);
        }
        return map;
      },
      async upsert(set) { scrambleSets.set(set.id, set); },
    },

    results: {
      async findById(id) { return results.get(id) ?? null; },
      async findByRound(roundId) {
        return [...results.values()].filter((r) => r.roundId === roundId);
      },
      async findByRoundSlim(roundId) {
        return [...results.values()]
          .filter((r) => r.roundId === roundId)
          .map((r) => ({ id: r.id, userId: r.userId, ao5Ms: r.ao5Ms, bestSingleMs: r.bestSingleMs, rank: r.rank, flagStatus: r.flagStatus }));
      },
      async findByUser(userId) {
        return [...results.values()].filter((r) => r.userId === userId);
      },
      async findByRounds(roundIds) {
        const wanted = new Set(roundIds);
        return [...results.values()].filter((r) => wanted.has(r.roundId));
      },
      async countByUsers(userIds) {
        const map = new Map<string, number>();
        const wanted = new Set(userIds);
        for (const r of results.values()) {
          if (wanted.has(r.userId)) map.set(r.userId, (map.get(r.userId) ?? 0) + 1);
        }
        return map;
      },
      async create(result) { results.set(result.id, result); },
      async createIfAbsent(result) {
        // Single-threaded, so the check-then-set is already atomic here; the
        // semantics match the advisory-locked Postgres path.
        const duplicate = [...results.values()].some(
          (r) => r.roundId === result.roundId && r.userId === result.userId,
        );
        if (duplicate) return false;
        results.set(result.id, result);
        return true;
      },
      async update(id, fields) {
        const result = results.get(id);
        if (!result) return null;
        Object.assign(result, fields);
        return result;
      },
      async updateRanks(rankings) {
        for (const { id, rank } of rankings) {
          const r = results.get(id);
          if (r) r.rank = rank;
        }
      },
    },

    registrations: {
      async findById(id) { return registrations.get(id) ?? null; },
      async findByIds(ids) {
        const map = new Map<string, Registration>();
        for (const id of ids) {
          const r = registrations.get(id);
          if (r) map.set(id, r);
        }
        return map;
      },
      async findByUser(userId) {
        return [...registrations.values()].filter((r) => r.userId === userId);
      },
      async findByCompetition(compId) {
        return [...registrations.values()].filter((r) => r.competitionId === compId);
      },
      async findByUserAndComp(userId, compId) {
        return (
          [...registrations.values()].find(
            (r) => r.userId === userId && r.competitionId === compId,
          ) ?? null
        );
      },
      async create(reg) { registrations.set(reg.id, reg); },
      async update(id, fields) {
        const reg = registrations.get(id);
        if (reg) Object.assign(reg, fields);
      },
      async delete(id) { registrations.delete(id); },
      async addEvent(registrationId, competitionEventId) {
        registrationEvents.push({ registrationId, competitionEventId });
      },
      async removeEvents(registrationId) {
        for (let i = registrationEvents.length - 1; i >= 0; i--) {
          if (registrationEvents[i]!.registrationId === registrationId) registrationEvents.splice(i, 1);
        }
      },
      async countEvents(registrationId) {
        return registrationEvents.filter((re) => re.registrationId === registrationId).length;
      },
      async findEvents(registrationId) {
        const eventIds = registrationEvents
          .filter((re) => re.registrationId === registrationId)
          .map((re) => re.competitionEventId);
        return eventIds
          .map((id) => competitionEvents.get(id))
          .filter((e): e is CompetitionEvent => e !== undefined);
      },
      async findEventsForAll(registrationIds) {
        const map = new Map<string, CompetitionEvent[]>();
        const wanted = new Set(registrationIds);
        for (const re of registrationEvents) {
          if (!wanted.has(re.registrationId)) continue;
          const event = competitionEvents.get(re.competitionEventId);
          if (!event) continue;
          const list = map.get(re.registrationId) ?? [];
          list.push(event);
          map.set(re.registrationId, list);
        }
        return map;
      },
      // Mirrors the pg-repo query, which is `isActiveRegistration`
      // (lib/registrationStatus.ts) expressed in SQL.
      async isRegisteredForEvent(userId, competitionEventId) {
        const userRegs = [...registrations.values()].filter((r) => r.userId === userId && r.status === "active");
        return userRegs.some((r) =>
          registrationEvents.some((re) => re.registrationId === r.id && re.competitionEventId === competitionEventId),
        );
      },
    },

    payments: {
      async findAll() { return [...payments.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt)); },
      async findById(id) { return payments.get(id) ?? null; },
      async findByOrderId(orderId) {
        return [...payments.values()].find((p) => p.razorpayOrderId === orderId) ?? null;
      },
      async findByRegistration(registrationId) {
        return [...payments.values()].find((p) => p.registrationId === registrationId && p.status === "pending") ?? null;
      },
      async findPendingByUserAndComp(userId, competitionId) {
        return [...payments.values()].find(
          (p) => p.userId === userId && p.competitionId === competitionId && p.status === "pending",
        ) ?? null;
      },
      async hasCompletedPayment(userId) {
        return [...payments.values()].some((p) => p.userId === userId && p.status === "paid");
      },
      async findByRegistrationIds(registrationIds) {
        const set = new Set(registrationIds);
        const map = new Map<string, import("./types").Payment>();
        for (const p of payments.values()) {
          if (p.registrationId && set.has(p.registrationId)) {
            const existing = map.get(p.registrationId);
            if (!existing || p.createdAt > existing.createdAt) map.set(p.registrationId, p);
          }
        }
        return map;
      },
      async create(payment) { payments.set(payment.id, payment); },
      async update(id, fields) {
        const payment = payments.get(id);
        if (payment) Object.assign(payment, fields);
      },
    },

    auditLog: {
      async findAll(limit = 100, offset = 0) {
        return auditLogEntries.sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(offset, offset + limit);
      },
      async findByAdmin(adminId) {
        return auditLogEntries.filter((e) => e.adminId === adminId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      },
      async findByTarget(target) {
        return auditLogEntries.filter((e) => e.target === target).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      },
      async create(entry) { auditLogEntries.push(entry); },
    },

    verificationTokens: {
      async create(t) { verificationTokenStore.set(t.id, t); },
      async findByToken(token, type) {
        for (const v of verificationTokenStore.values()) {
          if (v.token === token && v.type === type) return v;
        }
        return null;
      },
      async findByIdentifier(identifier, type) {
        for (const v of verificationTokenStore.values()) {
          if (v.identifier === identifier && v.type === type) return v;
        }
        return null;
      },
      async delete(id) { verificationTokenStore.delete(id); },
      async deleteExpired() {
        const now = Date.now();
        for (const [k, v] of verificationTokenStore.entries()) {
          if (v.expiresAt < now) verificationTokenStore.delete(k);
        }
      },
    },

    announcements: {
      async findAll(publishedOnly) {
        const all = [...announcements.values()];
        return publishedOnly ? all.filter((a) => a.published) : all;
      },
      async findById(id) { return announcements.get(id) ?? null; },
      async create(a) { announcements.set(a.id, a); },
      async update(id, fields) {
        const a = announcements.get(id);
        if (!a) return null;
        Object.assign(a, fields);
        return a;
      },
      async delete(id) { announcements.delete(id); },
    },

    advancements: {
      async save(roundId, entries) { roundAdvancements.set(roundId, entries); },
      async isAdvanced(destRoundId, userId) {
        // Advancement records are keyed by SOURCE round; callers pass the DESTINATION round
        const dst = rounds.get(destRoundId);
        if (!dst) return false;
        for (const [srcId, advs] of roundAdvancements.entries()) {
          const src = rounds.get(srcId);
          if (src && src.competitionEventId === dst.competitionEventId && src.roundNumber === dst.roundNumber - 1) {
            return advs.some((e) => e.userId === userId);
          }
        }
        return false;
      },
      async findByRound(roundId) { return roundAdvancements.get(roundId) ?? []; },
      async findByRounds(roundIds) {
        const map = new Map<string, RoundAdvancement[]>();
        for (const id of roundIds) {
          const entries = roundAdvancements.get(id);
          if (entries && entries.length > 0) map.set(id, entries);
        }
        return map;
      },
    },

    personalBests: {
      async findAll() {
        return [...personalBests.values()];
      },
      async findByUser(userId) {
        return [...personalBests.values()].filter((pb) => pb.userId === userId);
      },
      async findRanked(eventType, limit, offset) {
        const ranked = [...personalBests.values()]
          .filter((pb) =>
            (pb.bestAo5Ms !== null || pb.bestSingleMs !== null) &&
            (!eventType || pb.eventType === eventType))
          .sort((a, b) =>
            (a.bestAo5Ms ?? a.bestSingleMs ?? Infinity) -
            (b.bestAo5Ms ?? b.bestSingleMs ?? Infinity));
        return { rows: ranked.slice(offset, offset + limit), total: ranked.length };
      },
      async upsert(pb) {
        // Min-merge, matching the PG backend's LEAST() semantics.
        const key = `${pb.userId}:${pb.eventType}`;
        const prev = personalBests.get(key);
        const least = (a: number | null, b: number | null) =>
          a === null ? b : b === null ? a : Math.min(a, b);
        personalBests.set(key, prev ? {
          ...prev,
          bestSingleMs: least(prev.bestSingleMs, pb.bestSingleMs),
          bestAo5Ms: least(prev.bestAo5Ms, pb.bestAo5Ms),
          bestMeanMs: least(prev.bestMeanMs, pb.bestMeanMs),
          bestMedianMs: least(prev.bestMedianMs, pb.bestMedianMs),
          bestRank: least(prev.bestRank, pb.bestRank),
          updatedAt: pb.updatedAt,
        } : pb);
      },
      async replace(pb) {
        const key = `${pb.userId}:${pb.eventType}`;
        const prev = personalBests.get(key);
        personalBests.set(key, prev ? { ...pb, id: prev.id } : pb);
      },
    },

    practice: {
      async createSession(session) { practiceSessions.set(session.id, session); },
      async findSession(id) { return practiceSessions.get(id) ?? null; },
      async findSessionsByUser(userId) {
        return [...practiceSessions.values()]
          .filter((s) => s.userId === userId)
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      },
      async updateSession(id, fields) {
        const s = practiceSessions.get(id);
        if (!s) return null;
        Object.assign(s, fields);
        return s;
      },
      async deleteSession(id) {
        practiceSessions.delete(id);
        for (let i = practiceSolves.length - 1; i >= 0; i--) {
          if (practiceSolves[i]!.sessionId === id) practiceSolves.splice(i, 1);
        }
      },
      async endSession(id) {
        const s = practiceSessions.get(id);
        if (s) s.endedAt = new Date().toISOString();
      },
      async addSolve(solve) { practiceSolves.push(solve); },
      async findSolve(id) {
        return practiceSolves.find((s) => s.id === id) ?? null;
      },
      async findSolvesBySession(sessionId) {
        return practiceSolves.filter((s) => s.sessionId === sessionId);
      },
      async findSolvesBySessionIds(sessionIds) {
        const idSet = new Set(sessionIds);
        return practiceSolves.filter((s) => idSet.has(s.sessionId));
      },
      async deleteSolve(id) {
        const idx = practiceSolves.findIndex((s) => s.id === id);
        if (idx >= 0) practiceSolves.splice(idx, 1);
      },
    },

    dailyChallenge: {
      async findByDate(date) {
        return [...dailyChallenges.values()].find((c) => c.date === date) ?? null;
      },
      async create(challenge) { dailyChallenges.set(challenge.id, challenge); },
      async submitResult(result) { dailyChallengeResults.push(result); },
      async findResultByUserAndChallenge(userId, challengeId) {
        return dailyChallengeResults.find(
          (r) => r.userId === userId && r.challengeId === challengeId,
        ) ?? null;
      },
      async findResultsByChallenge(challengeId) {
        return dailyChallengeResults.filter((r) => r.challengeId === challengeId);
      },
      async findUserStreak(userId) {
        const userResults = dailyChallengeResults.filter((r) => r.userId === userId);
        if (userResults.length === 0) return 0;
        const dates = new Set<string>();
        for (const r of userResults) {
          const ch = [...dailyChallenges.values()].find((c) => c.id === r.challengeId);
          if (ch) dates.add(ch.date);
        }
        let streak = 0;
        const d = new Date();
        while (true) {
          const dateStr = d.toISOString().slice(0, 10);
          if (dates.has(dateStr)) {
            streak++;
            d.setDate(d.getDate() - 1);
          } else if (streak === 0) {
            d.setDate(d.getDate() - 1);
            if (!dates.has(d.toISOString().slice(0, 10))) break;
          } else {
            break;
          }
        }
        return streak;
      },
    },

    appeals: {
      async findAll() { return [...appeals.values()]; },
      async findById(id) { return appeals.get(id) ?? null; },
      async findByResult(resultId) {
        return [...appeals.values()].find((a) => a.resultId === resultId) ?? null;
      },
      async findByUser(userId) {
        return [...appeals.values()].filter((a) => a.userId === userId);
      },
      async create(appeal) { appeals.set(appeal.id, appeal); },
      async update(id, fields) {
        const existing = appeals.get(id);
        if (!existing) return null;
        const updated = { ...existing, ...fields };
        appeals.set(id, updated);
        return updated;
      },
    },

    withdrawalRequests: {
      async findAll() { return [...withdrawalRequests.values()]; },
      async findById(id) { return withdrawalRequests.get(id) ?? null; },
      async findPendingByRegistration(registrationId) {
        return [...withdrawalRequests.values()].find(
          (w) => w.registrationId === registrationId && w.status === "pending",
        ) ?? null;
      },
      async findByUser(userId) {
        return [...withdrawalRequests.values()].filter((w) => w.userId === userId);
      },
      async create(request) { withdrawalRequests.set(request.id, request); },
      async update(id, fields) {
        const existing = withdrawalRequests.get(id);
        if (!existing) return null;
        const updated = { ...existing, ...fields };
        if (fields.status === "approved" || fields.status === "rejected") {
          updated.resolvedAt = updated.resolvedAt ?? new Date().toISOString();
        }
        withdrawalRequests.set(id, updated);
        return updated;
      },
    },

    rankTiers: {
      async findAll() { return [...rankTiers.values()]; },
      async findById(id) { return rankTiers.get(id) ?? null; },
      async findByEvent(eventType) {
        return [...rankTiers.values()]
          .filter((t) => t.eventType === eventType)
          .sort((a, b) => a.maxAo5Ms - b.maxAo5Ms);
      },
      async create(tier) { rankTiers.set(tier.id, tier); },
      async update(id, fields) {
        const existing = rankTiers.get(id);
        if (!existing) return null;
        const updated = { ...existing, ...fields };
        rankTiers.set(id, updated);
        return updated;
      },
      async delete(id) { rankTiers.delete(id); },
    },

    promoCodes: {
      async findAll() { return [...promoCodes.values()]; },
      async findById(id) { return promoCodes.get(id) ?? null; },
      async findByCode(code) {
        return [...promoCodes.values()].find((p) => p.code.toUpperCase() === code.toUpperCase()) ?? null;
      },
      async create(promo) { promoCodes.set(promo.id, promo); },
      async update(id, fields) {
        const existing = promoCodes.get(id);
        if (!existing) return null;
        const updated = { ...existing, ...fields };
        promoCodes.set(id, updated);
        return updated;
      },
      async delete(id) { promoCodes.delete(id); },
      async incrementUsed(id) {
        const existing = promoCodes.get(id);
        if (!existing || (existing.maxUses > 0 && existing.usedCount >= existing.maxUses)) return false;
        promoCodes.set(id, { ...existing, usedCount: existing.usedCount + 1 });
        return true;
      },
      // These were stubs returning nothing and zero, which meant per-user promo
      // limits were silently unenforced in memory and untestable. pg-repo counts
      // rows in promo_code_usages; this mirrors it.
      async recordUsage(promoCodeId, userId) {
        promoCodeUsages.push({ promoCodeId, userId });
      },
      async userUsageCount(promoCodeId, userId) {
        return promoCodeUsages.filter(
          (u) => u.promoCodeId === promoCodeId && u.userId === userId,
        ).length;
      },
    },

    banners: {
      async findAll() {
        return [...bannerStore.values()].sort((a, b) => a.order - b.order);
      },
      async findById(id) { return bannerStore.get(id) ?? null; },
      async create(banner) { bannerStore.set(banner.id, banner); },
      async update(id, fields) {
        const existing = bannerStore.get(id);
        if (!existing) return null;
        const updated = { ...existing, ...fields };
        bannerStore.set(id, updated);
        return updated;
      },
      async delete(id) { bannerStore.delete(id); },
    },

    faq: {
      async findAll(publishedOnly) {
        const all = [...faqStore.values()].sort((a, b) => a.order - b.order);
        return publishedOnly ? all.filter((f) => f.published) : all;
      },
      async findById(id) { return faqStore.get(id) ?? null; },
      async create(entry) { faqStore.set(entry.id, entry); },
      async update(id, fields) {
        const existing = faqStore.get(id);
        if (!existing) return null;
        const updated = { ...existing, ...fields };
        faqStore.set(id, updated);
        return updated;
      },
      async delete(id) { faqStore.delete(id); },
    },

    contentPages: {
      async findAll(publishedOnly) {
        const all = [...contentPageStore.values()].sort((a, b) => a.title.localeCompare(b.title));
        return publishedOnly ? all.filter((p) => p.published) : all;
      },
      async findBySlug(slug) {
        return [...contentPageStore.values()].find((p) => p.slug === slug) ?? null;
      },
      async findById(id) { return contentPageStore.get(id) ?? null; },
      async create(page) { contentPageStore.set(page.id, page); },
      async update(id, fields) {
        const existing = contentPageStore.get(id);
        if (!existing) return null;
        const updated = { ...existing, ...fields, updatedAt: new Date().toISOString() };
        contentPageStore.set(id, updated);
        return updated;
      },
      async delete(id) { contentPageStore.delete(id); },
    },

    ruleSets: (() => {
      const store = new Map<string, RuleSet>();
      return {
        async findAll() { return [...store.values()].sort((a, b) => a.name.localeCompare(b.name)); },
        async findById(id: string) { return store.get(id) ?? null; },
        async findByIds(ids: string[]) {
          const map = new Map<string, RuleSet>();
          for (const id of ids) {
            const rs = store.get(id);
            if (rs) map.set(id, rs);
          }
          return map;
        },
        async create(rs: RuleSet) {
          // PG enforces `unique index on lower(name)` (migration 036) and the
          // route maps the throw to 409 duplicate_name. Without this the mem
          // backend silently accepted duplicates and that path was never tested.
          const clash = [...store.values()].some(
            (existing) => existing.name.toLowerCase() === rs.name.toLowerCase(),
          );
          if (clash) throw new Error("duplicate rule set name");
          store.set(rs.id, rs);
        },
        async update(id: string, fields: Partial<RuleSet>) {
          const rs = store.get(id);
          if (!rs) return null;
          Object.assign(rs, fields, { updatedAt: new Date().toISOString() });
          return rs;
        },
        async delete(id: string) { store.delete(id); },
      };
    })(),

    competitionRuleSets: (() => {
      /** competitionId → ordered rule set ids. */
      const store = new Map<string, string[]>();
      return {
        async findByCompetition(competitionId: string) {
          return [...(store.get(competitionId) ?? [])];
        },
        async findByCompetitions(competitionIds: string[]) {
          const map = new Map<string, string[]>();
          for (const id of competitionIds) {
            const ids = store.get(id);
            if (ids?.length) map.set(id, [...ids]);
          }
          return map;
        },
        async replace(competitionId: string, ruleSetIds: string[]) {
          // Mirror the PG primary key: a rule set can appear once per
          // competition, and order is the order given.
          const deduped = [...new Set(ruleSetIds)];
          if (deduped.length === 0) store.delete(competitionId);
          else store.set(competitionId, deduped);
        },
      };
    })(),

    systemSettings: (() => {
      let settings: SystemSettings = {
        eventDurations: {
          "222": 15, "333": 20, "444": 25, "555": 30, "666": 35, "777": 40,
          pyram: 15, skewb: 15, minx: 30, "333oh": 20, "333bf": 25, sq1: 20,
          clock: 15, "444bf": 40, "555bf": 50, "333mbf": 60, fto: 25, "333fm": 60,
        },
        registrationDurationDays: 5,
        gapBetweenEventsMinutes: 0,
        defaultRoundDurationMinutes: 20,
        videoDeadlineMinutes: 1440,
        autoPublishLeadMinutes: 30,
        publishWarningLeadHours: 5,
        flagRuleDefaults: {
          nearRecordPct: 5,
          personalDeviationPct: 30,
          missingVideo: true,
          borderlineCutoffMargin: 3,
        },
        recordReferences: {},
      };
      return {
        async get() { return settings; },
        async update(fields: Partial<SystemSettings>) {
          settings = { ...settings, ...fields };
          if (fields.eventDurations) {
            settings.eventDurations = { ...settings.eventDurations, ...fields.eventDurations };
          }
          if (fields.flagRuleDefaults) {
            settings.flagRuleDefaults = { ...settings.flagRuleDefaults, ...fields.flagRuleDefaults };
          }
          if (fields.recordReferences) {
            settings.recordReferences = { ...settings.recordReferences, ...fields.recordReferences };
          }
          return settings;
        },
      };
    })(),

    async ping() { return null; },

    judgeAssignments: {
      async findById(id) {
        return judgeAssignmentStore.get(id) ?? null;
      },
      async findByRound(roundId) {
        return [...judgeAssignmentStore.values()].filter((a) => a.roundId === roundId);
      },
      async findByJudge(judgeId) {
        return [...judgeAssignmentStore.values()].filter((a) => a.judgeId === judgeId);
      },
      async create(assignment) {
        // Mirror the PG `ON CONFLICT (judge_id, round_id) DO NOTHING`, which this
        // previously lacked — the same judge could be assigned to a round N times
        // in memory but only once against Postgres.
        const duplicate = [...judgeAssignmentStore.values()].some(
          (a) => a.judgeId === assignment.judgeId && a.roundId === assignment.roundId,
        );
        if (duplicate) return;
        judgeAssignmentStore.set(assignment.id, assignment);
      },
      async delete(id) {
        judgeAssignmentStore.delete(id);
      },
    },

    roster: {
      async join(roundId, userId, name) {
        if (!roster.has(roundId)) roster.set(roundId, new Map());
        roster.get(roundId)!.set(userId, name);
      },
      async leave(roundId, userId) {
        roster.get(roundId)?.delete(userId);
      },
      async snapshot(roundId) {
        const r = roster.get(roundId);
        if (!r) return [];
        return [...r.entries()].map(([userId, name]) => ({ userId, name }));
      },
    },
  };
}
