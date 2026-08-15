import type { Repository } from "../db/repo";
import type { Competition, Registration } from "../db/types";

/**
 * The single definition of "this registration counts".
 *
 * There used to be two. The gate on scrambles and submission
 * (`isRegisteredForEvent`) required `payment_status = 'paid'`, while the
 * `registered` flag the UI renders came straight from `findByUserAndComp` with
 * no status check at all. A registration awaiting payment therefore read as
 * registered on the competition page and unregistered at the timer — the
 * "Not Registered" report from the team.
 *
 * The deeper cause was that `payment_status` answered two different questions:
 * "did money arrive" and "is this registration valid". Free competitions have no
 * payment, so their rows were written as `paid` to make the second work, which
 * made the first false — and left the withdraw endpoint, which refuses anything
 * marked paid, rejecting every user in the system.
 *
 * Validity now lives in `registrations.status` (migration 045) and nothing else
 * decides it. `payment_status` is back to meaning only what it says.
 *
 * `isRegisteredForEvent` keeps its own SQL/in-memory filter for the same rule,
 * because that check has to run inside the query — see the comment at each
 * implementation.
 */
export function isActiveRegistration(
  reg: Pick<Registration, "status"> | null | undefined,
): boolean {
  return reg?.status === "active";
}

/**
 * Did this competition actually charge anyone?
 *
 * The fees decide, not `type`. The register endpoint already works this way —
 * it computes `isFree = totalFee === 0` and only takes the payment path when
 * money is owed — so keying on type here would let the two disagree about the
 * same competition. Practice competitions are free ones with no rewards, their
 * fees zeroed by the duplication route, and fall out of this correctly without
 * being named.
 *
 * This is what separates a competitor who may simply leave from one who has to
 * ask the organiser, and that difference is entirely about money.
 */
export function isPaidCompetition(
  comp: Pick<Competition, "baseFee" | "perEventFee">,
): boolean {
  return comp.baseFee > 0 || comp.perEventFee > 0;
}

/**
 * Has this competitor already submitted anything in this competition?
 *
 * `results` has no foreign key to `registrations`, so ending a registration does
 * not remove the results attached to it — it would leave times on the board from
 * someone the competition says is not taking part. Withdrawal and removal both
 * refuse in that case, the same way deleting an event with results is refused.
 */
export async function hasResultsInCompetition(
  repo: Repository,
  userId: string,
  competitionId: string,
): Promise<boolean> {
  const [rounds, results] = await Promise.all([
    repo.rounds.findByCompetition(competitionId),
    repo.results.findByUser(userId),
  ]);
  const roundIds = new Set(rounds.map((r) => r.id));
  return results.some((r) => roundIds.has(r.roundId));
}
