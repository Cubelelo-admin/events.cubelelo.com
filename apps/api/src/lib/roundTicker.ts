import type { RoundStatus } from "@cubers/types";
import type { Repository } from "../db/repo";
import type { Realtime } from "../sockets/realtime";
import { effectiveRoundStatus } from "./statusUtils";
import { closeRound } from "./roundLifecycle";
import { publishRound, autoPublishAt } from "./roundPublish";
import { scheduleRoundJobs } from "./roundScheduler";

const TICK_INTERVAL_MS = 60_000;

/**
 * Recovery for round transitions, not the primary mechanism.
 *
 * Opening and closing are driven by delayed jobs (`roundScheduler`). This poll
 * exists so a round still opens and closes if a job is lost — a Redis restart,
 * a deploy mid-delay — by re-deriving status from the clock and reconciling.
 * The two are deliberately redundant; the jobs also fire side effects a derived
 * status cannot, such as generating scrambles.
 *
 * It does not shortlist on its own. Advancement happens when a round is
 * published — by the verifier, or by the deadline before the next round opens.
 * The one thing this recovers is a *missed* deadline, which is the same
 * lost-job case it recovers open and close for.
 */

export function startRoundTicker(repo: Repository, realtime: Realtime): () => void {
  let running = false;

  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const rounds = await repo.rounds.findActive();
      for (const round of rounds) {
        if (!round.opensAt) continue;

        const effective = effectiveRoundStatus(round);
        if (effective === round.status) continue;

        if (effective === "open" && round.status === "pending") {
          await repo.rounds.update(round.id, { status: "open" });
          realtime.emitRoundStatus(round.id, "open" as RoundStatus, round.opensAt);
          await scheduleRoundJobs(round);
          console.log(`⏱ Round ${round.id} recovery-opened`);
        }

        if (effective === "closed" && (round.status === "open" || round.status === "pending")) {
          await closeRound(repo, realtime, round);
          console.log(`⏱ Round ${round.id} recovery-closed`);
        }
      }

      await recoverMissedAutoPublish(repo, realtime, rounds);
    } catch (err) {
      console.error("Round ticker error:", err);
    } finally {
      running = false;
    }
  };

  tick();
  const handle = setInterval(tick, TICK_INTERVAL_MS);
  return () => clearInterval(handle);
}


/**
 * Publish a round whose deadline passed while nothing was listening.
 *
 * The deadline is a delayed job, and a Redis restart or a deploy across the
 * moment would otherwise mean the round never publishes and the next one opens
 * admitting nobody. Late is better than never.
 */
async function recoverMissedAutoPublish(
  repo: Repository,
  realtime: Realtime,
  rounds: Awaited<ReturnType<typeof repo.rounds.findActive>>,
): Promise<void> {
  const now = Date.now();

  for (const round of rounds) {
    if (round.resultsPublishedAt) continue;
    if (effectiveRoundStatus(round) !== "closed") continue;

    const at = await autoPublishAt(repo, round);
    if (!at || at.getTime() > now) continue;

    const outcome = await publishRound(repo, realtime, round, {
      actorId: "system:auto-publish",
      auto: true,
    });
    if (outcome.ok) {
      console.log(
        `⏱ Round ${round.id} auto-published on recovery — ${outcome.result.advancedCount} advanced`,
      );
    }
  }
}
