import type { FastifyReply, FastifyRequest } from "fastify";
import type { Repository } from "../db/repo";
import type { Competition, User } from "../db/types";

/**
 * Role predicates and competition-ownership checks.
 *
 * These used to be duplicated: `admin/routes.ts` and `rounds/routes.ts` each had
 * their own `ownedCompByRound` with different return contracts, and the
 * "super_admin inherits admin" rule was re-implemented inline at roughly fifteen
 * call sites — one of which omitted `super_admin` entirely, so a super admin
 * could not download another user's invoice. Every authorization decision should
 * go through this module.
 */

/** Admin or super admin. Super admin inherits every admin permission. */
export function isAdmin(user: Pick<User, "role"> | null | undefined): boolean {
  return user?.role === "admin" || user?.role === "super_admin";
}

/** Admin, super admin, or moderator — anyone who can run a competition. */
export function isAdminOrMod(user: Pick<User, "role"> | null | undefined): boolean {
  return isAdmin(user) || user?.role === "moderator";
}

/** Anyone with a staff role, including judges. */
export function isStaff(user: Pick<User, "role"> | null | undefined): boolean {
  return isAdminOrMod(user) || user?.role === "judge";
}

/** Super admin only — the roles that may act on other admins. */
export function isSuperAdmin(user: Pick<User, "role"> | null | undefined): boolean {
  return user?.role === "super_admin";
}

/**
 * Ownership checks. Each replies with the appropriate error and returns null
 * when the caller may not act on the competition, so callers can `if (!comp) return;`.
 */
export function createOwnershipChecks(repo: Repository) {
  /** The competition, if the caller is an admin or the moderator who created it. */
  async function ownedComp(
    req: FastifyRequest,
    reply: FastifyReply,
    compId: string,
  ): Promise<Competition | null> {
    const comp = await repo.competitions.findById(compId);
    if (!comp) {
      await reply.code(404).send({ error: "competition_not_found" });
      return null;
    }
    const user = await repo.users.findById(req.authClaims!.sub);
    if (!user) {
      await reply.code(403).send({ error: "forbidden" });
      return null;
    }
    if (isAdmin(user)) return comp;
    if (user.role === "moderator" && comp.createdBy === user.id) return comp;
    await reply.code(403).send({ error: "forbidden" });
    return null;
  }

  /** Ownership via round → competition event → competition. */
  async function ownedCompByRound(
    req: FastifyRequest,
    reply: FastifyReply,
    roundId: string,
  ): Promise<Competition | null> {
    const round = await repo.rounds.findById(roundId);
    if (!round) {
      await reply.code(404).send({ error: "round_not_found" });
      return null;
    }
    const ev = await repo.competitionEvents.findById(round.competitionEventId);
    if (!ev) {
      await reply.code(404).send({ error: "event_not_found" });
      return null;
    }
    return ownedComp(req, reply, ev.competitionId);
  }

  /** Ownership via competition event → competition. */
  async function ownedCompByEvent(
    req: FastifyRequest,
    reply: FastifyReply,
    eventId: string,
  ): Promise<Competition | null> {
    const ev = await repo.competitionEvents.findById(eventId);
    if (!ev) {
      await reply.code(404).send({ error: "event_not_found" });
      return null;
    }
    return ownedComp(req, reply, ev.competitionId);
  }

  /** Ownership via result → round → event → competition. */
  async function ownedCompByResult(
    req: FastifyRequest,
    reply: FastifyReply,
    resultId: string,
  ): Promise<Competition | null> {
    const result = await repo.results.findById(resultId);
    if (!result) {
      await reply.code(404).send({ error: "result_not_found" });
      return null;
    }
    return ownedCompByRound(req, reply, result.roundId);
  }

  return { ownedComp, ownedCompByRound, ownedCompByEvent, ownedCompByResult };
}
