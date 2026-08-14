import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import type { Repository } from "../../db/repo";
import { sanitizeUser } from "../../db/types";
import { requireAuth, resolveUser } from "../../auth/plugin";
import { isAdminOrMod } from "../../auth/ownership";
import type { Solve } from "@cubers/types";
import { env } from "../../config/env";
import { getStorage } from "../../lib/storage";

const EDITABLE_FIELDS = [
  "name",
  "lastName",
  "gender",
  "dob",
  "mobileNo",
  "city",
  "state",
  "country",
  "address",
  "landmark",
  "pincode",
  "instagram",
  "profilePrivacy",
] as const;

export async function registerUserRoutes(
  app: FastifyInstance,
  repo: Repository,
): Promise<void> {
  // Authenticated: a two-character query returns real names and CL IDs, so
  // leaving it open exposed the whole user directory to enumeration.
  app.get<{ Querystring: { q?: string } }>(
    "/api/v1/users/search",
    { preHandler: requireAuth },
    async (req, reply) => {
      const q = req.query.q?.trim();
      if (!q || q.length < 2)
        return reply.code(400).send({ error: "query_too_short" });
      const all = await repo.users.findAll(q);
      return all
        .slice(0, 20)
        .map((u) => ({
          clId: u.clId,
          name: u.name,
          avatarUrl: u.avatarUrl,
          city: u.city,
          country: u.country,
        }));
    },
  );

  app.get<{ Params: { clid: string } }>(
    "/api/v1/users/:clid",
    async (req, reply) => {
      const user = await repo.users.findByClId(req.params.clid);
      if (!user) return reply.code(404).send({ error: "user_not_found" });

      const isOwner = req.authClaims?.sub === user.id;
      if (user.profilePrivacy === "private" && !isOwner) {
        return {
          clId: user.clId,
          name: user.name,
          country: user.country ?? "India",
          avatarUrl: user.avatarUrl,
          profilePrivacy: "private",
          personalBests: {},
          stats: null,
          competitionHistory: [],
        };
      }

      const [userResults, regs] = await Promise.all([
        repo.results.findByUser(user.id),
        repo.registrations.findByUser(user.id),
      ]);

      // Batch: roundId → event mapping (1 query instead of N)
      const roundIds = [...new Set(userResults.map((r) => r.roundId))];
      const eventByRound = await repo.competitionEvents.findByRounds(roundIds);

      const getEventType = (roundId: string) => eventByRound.get(roundId)?.eventType ?? "unknown";

      // Batch: all competition IDs → titles (1 query instead of N)
      const compIds = new Set<string>();
      for (const e of eventByRound.values()) compIds.add(e.competitionId);
      for (const r of regs) compIds.add(r.competitionId);
      const compsMap = await repo.competitions.findByIds([...compIds]);

      // ── Personal bests (from dedicated table, consistent with rankings) ──
      const userPbs = await repo.personalBests.findByUser(user.id);
      const pbs: Record<string, { bestSingle: number | null; bestAo5: number | null }> = {};
      for (const pb of userPbs) {
        pbs[pb.eventType] = { bestSingle: pb.bestSingleMs, bestAo5: pb.bestAo5Ms };
      }

      // ── Stats ──
      const eventAo5s: Record<string, number[]> = {};
      const eventSolveCounts: Record<string, number> = {};
      let totalSolves = 0;
      for (const result of userResults) {
        const eventType = getEventType(result.roundId);
        totalSolves += result.solves.length;
        eventSolveCounts[eventType] = (eventSolveCounts[eventType] ?? 0) + result.solves.length;
        if (result.ao5Ms !== null) {
          if (!eventAo5s[eventType]) eventAo5s[eventType] = [];
          eventAo5s[eventType].push(result.ao5Ms);
        }
      }

      const eventStats: Record<
        string,
        { mean: number | null; stdDev: number | null; solveCount: number }
      > = {};
      for (const [et, ao5s] of Object.entries(eventAo5s)) {
        const n = ao5s.length;
        const mean = ao5s.reduce((a, b) => a + b, 0) / n;
        const variance = ao5s.reduce((sum, v) => sum + (v - mean) ** 2, 0) / n;
        eventStats[et] = {
          mean: Math.round(mean),
          stdDev: Math.round(Math.sqrt(variance)),
          solveCount: eventSolveCounts[et] ?? 0,
        };
      }

      // ── Solve timeline ──
      const timelineByEvent: Record<
        string,
        Array<{ timeMs: number; ao5Ms: number | null; date: string; compTitle: string }>
      > = {};
      for (const result of userResults) {
        const eventType = getEventType(result.roundId);
        if (!timelineByEvent[eventType]) timelineByEvent[eventType] = [];
        const compId = eventByRound.get(result.roundId)?.competitionId;
        const compTitle = compId ? (compsMap.get(compId)?.title ?? "Unknown") : "Unknown";
        for (const solve of result.solves) {
          const timeMs =
            solve.penalty === "dnf"
              ? null
              : solve.penalty === "plus2"
                ? solve.time_ms + 2000
                : solve.time_ms;
          if (timeMs !== null) {
            timelineByEvent[eventType].push({
              timeMs,
              ao5Ms: result.ao5Ms,
              date: result.submittedAt,
              compTitle,
            });
          }
        }
      }

      // ── Detailed competition history (no N+1 — reuse cached data) ──
      const resultsByRound = new Map<string, typeof userResults>();
      for (const r of userResults) {
        if (!resultsByRound.has(r.roundId)) resultsByRound.set(r.roundId, []);
        resultsByRound.get(r.roundId)!.push(r);
      }

      // Group rounds by competition from the event mapping
      const compEventRounds = new Map<string, Map<string, { eventType: string; rounds: Map<string, number> }>>();
      for (const [roundId, ev] of eventByRound) {
        if (!compEventRounds.has(ev.competitionId)) compEventRounds.set(ev.competitionId, new Map());
        const evMap = compEventRounds.get(ev.competitionId)!;
        if (!evMap.has(ev.id)) evMap.set(ev.id, { eventType: ev.eventType, rounds: new Map() });
      }
      // We need round numbers — fetch rounds for all relevant competitions in bulk
      const compRoundsMap = new Map<string, Awaited<ReturnType<typeof repo.rounds.findByCompetition>>>();
      await Promise.all(
        [...compIds].map(async (cid) => {
          compRoundsMap.set(cid, await repo.rounds.findByCompetition(cid));
        }),
      );

      const history = [...compIds].map((compId) => {
        const comp = compsMap.get(compId);
        const allRounds = compRoundsMap.get(compId) ?? [];

        // Group rounds by event
        const eventGroups = new Map<string, { eventType: string; rounds: typeof allRounds }>();
        for (const rd of allRounds) {
          const ev = eventByRound.get(rd.id) ?? [...eventByRound.values()].find(
            (e) => e.id === rd.competitionEventId,
          );
          if (!ev) continue;
          if (!eventGroups.has(rd.competitionEventId)) {
            eventGroups.set(rd.competitionEventId, { eventType: ev.eventType, rounds: [] });
          }
          eventGroups.get(rd.competitionEventId)!.rounds.push(rd);
        }

        const events = [...eventGroups.values()]
          .map(({ eventType, rounds: evRounds }) => {
            const sorted = evRounds.sort((a, b) => a.roundNumber - b.roundNumber);
            const roundResults = sorted
              .map((rd) => {
                const result = userResults.find((r) => r.roundId === rd.id);
                if (!result) return null;
                return {
                  roundNumber: rd.roundNumber,
                  rank: result.rank,
                  bestSingleMs: result.bestSingleMs,
                  ao5Ms: result.ao5Ms,
                  solves: result.solves as Solve[],
                };
              })
              .filter(Boolean);
            if (roundResults.length === 0) return null;
            return { eventType, rounds: roundResults };
          })
          .filter(Boolean);

        return {
          competitionId: compId,
          competitionTitle: comp?.title ?? "Unknown",
          status: comp?.status ?? "unknown",
          events,
        };
      });

      return {
        clId: user.clId,
        name: user.name,
        city: user.city,
        state: user.state,
        country: user.country ?? "India",
        avatarUrl: user.avatarUrl,
        instagram: user.instagram,
        wcaId: user.wcaId,
        wcaVerified: user.wcaVerified,
        profilePrivacy: user.profilePrivacy ?? "public",
        createdAt: user.createdAt,
        personalBests: pbs,
        stats: {
          totalCompetitions: compIds.size,
          totalSolves,
          eventStats,
          solveTimeline: timelineByEvent,
        },
        competitionHistory: history,
      };
    },
  );

  // WCA ID verification
  app.post<{ Body: { wcaId?: string } }>(
    "/api/v1/users/me/wca",
    { preHandler: requireAuth },
    async (req, reply) => {
      const { wcaId } = req.body ?? {};
      if (!wcaId || typeof wcaId !== "string")
        return reply.code(400).send({ error: "missing_wca_id" });

      const formatted = wcaId.trim().toUpperCase();

      // Call WCA API to verify the ID exists
      try {
        const res = await fetch(`${env.WCA_API_BASE}/persons/${formatted}`);
        if (res.status === 404)
          return reply.code(404).send({ error: "wca_id_not_found" });
        if (!res.ok)
          return reply.code(502).send({ error: "wca_api_unavailable" });
      } catch {
        return reply.code(502).send({ error: "wca_api_unavailable" });
      }

      const updated = await repo.users.update(req.authClaims!.sub, {
        wcaId: formatted,
        wcaVerified: false,
      });
      if (!updated) return reply.code(403).send({ error: "not_synced" });

      return { wcaId: updated.wcaId, wcaVerified: updated.wcaVerified, pendingReview: true };
    },
  );

  // Avatar upload — uses R2 when configured, local uploads/ dir otherwise
  app.post(
    "/api/v1/users/me/avatar",
    { preHandler: requireAuth },
    async (req, reply) => {
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

      const filename = `avatars/${req.authClaims!.sub}_${randomUUID().slice(0, 8)}.${ext}`;
      const storage = getStorage();
      const avatarUrl = await storage.upload(filename, buffer, `image/${ext === "jpg" ? "jpeg" : ext}`);

      const updated = await repo.users.update(req.authClaims!.sub, { avatarUrl });
      if (!updated) return reply.code(403).send({ error: "not_synced" });

      return { avatarUrl };
    },
  );

  app.patch<{ Body: Record<string, unknown> }>(
    "/api/v1/users/me",
    { preHandler: requireAuth },
    async (req, reply) => {
      const body = req.body ?? {};
      const fields: Record<string, string> = {};
      for (const field of EDITABLE_FIELDS) {
        if (field in body && typeof body[field] === "string") {
          if (field === "profilePrivacy" && !["public", "private"].includes(body[field] as string)) {
            return reply.code(400).send({ error: "invalid_profile_privacy" });
          }
          fields[field] = body[field] as string;
        }
      }
      const updated = await repo.users.update(req.authClaims!.sub, fields);
      if (!updated) return reply.code(403).send({ error: "not_synced" });
      return sanitizeUser(updated);
    },
  );

  // Global search across competitions, users, announcements, content pages
  app.get<{ Querystring: { q?: string } }>(
    "/api/v1/search",
    async (req, reply) => {
      const q = req.query.q?.trim()?.toLowerCase();
      if (!q || q.length < 2)
        return reply.code(400).send({ error: "query_too_short" });

      const caller = await resolveUser(repo, req);

      // Competitions, announcements and pages are public. People are not — a
      // signed-out visitor searching two characters could otherwise walk the
      // entire user directory.
      const [users, competitions, announcements, pages] = await Promise.all([
        caller ? repo.users.findAll(q) : Promise.resolve([]),
        repo.competitions.findAll(q),
        repo.announcements.findAll(true),
        repo.contentPages.findAll(true),
      ]);

      const matchedUsers = users.slice(0, 10).map((u) => ({
        type: "user" as const,
        id: u.clId,
        title: u.name,
        subtitle: u.clId,
        href: `/profile/${u.clId}`,
      }));

      const matchedComps = competitions.slice(0, 10).map((c) => ({
        type: "competition" as const,
        id: c.id,
        title: c.title,
        subtitle: c.type,
        href: `/competitions/${c.id}`,
      }));

      const matchedAnnouncements = announcements
        .filter((a) => a.title.toLowerCase().includes(q) || a.bodyMd.toLowerCase().includes(q))
        .slice(0, 5)
        .map((a) => ({
          type: "announcement" as const,
          id: a.id,
          title: a.title,
          subtitle: "Announcement",
          href: a.redirectUrl || null,
        }));

      const matchedPages = pages
        .filter((p) => p.title.toLowerCase().includes(q) || p.bodyMd.toLowerCase().includes(q))
        .slice(0, 5)
        .map((p) => ({
          type: "page" as const,
          id: p.slug,
          title: p.title,
          subtitle: "Page",
          href: `/pages/${p.slug}`,
        }));

      type SearchItem = { type: string; id: string; title: string; subtitle: string; href: string | null };
      const results: SearchItem[] = [...matchedComps, ...matchedUsers, ...matchedAnnouncements, ...matchedPages];

      // Admin pages only for admin/moderator
      if (isAdminOrMod(caller)) {
        const adminPages = [
          { slug: "competitions", title: "Admin: Competitions" },
          { slug: "users", title: "Admin: Users" },
          { slug: "payments", title: "Admin: Payments" },
          { slug: "announcements", title: "Admin: Announcements" },
          { slug: "content", title: "Admin: Content" },
          { slug: "faq", title: "Admin: Details" },
          { slug: "pages", title: "Admin: Pages" },
          { slug: "staff", title: "Admin: Staff" },
          { slug: "appeals", title: "Admin: Appeals" },
        ];
        const matchedAdmin = adminPages
          .filter((p) => p.title.toLowerCase().includes(q) || p.slug.includes(q))
          .map((p) => ({
            type: "admin" as const,
            id: p.slug,
            title: p.title,
            subtitle: "Admin",
            href: `/admin/${p.slug === "competitions" ? "" : p.slug}`,
          }));
        results.push(...matchedAdmin);
      }

      return results.slice(0, 25);
    },
  );

  // Delete own account (soft-delete: anonymize PII, set stage to deleted)
  app.delete(
    "/api/v1/me",
    { preHandler: [requireAuth] },
    async (req, reply) => {
      const userId = req.authClaims!.sub;
      const user = await repo.users.findById(userId);
      if (!user) return reply.code(404).send({ error: "user_not_found" });

      await repo.users.update(userId, {
        email: `deleted-${userId}@deleted.local`,
        name: "Deleted User",
        lastName: undefined,
        mobileNo: undefined,
        avatarUrl: undefined,
        instagram: undefined,
        passwordHash: undefined,
        accountStage: "deleted",
      });
      return reply.code(204).send();
    },
  );
}
