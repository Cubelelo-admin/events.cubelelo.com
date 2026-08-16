import type { RoundStatus } from "@cubers/types";
import type { Repository } from "../db/repo";
import type { Realtime } from "../sockets/realtime";
import type { Round } from "../db/types";
import { getQueue } from "./jobQueue";
import { registerWorker } from "./jobQueue";
import { closeRound } from "./roundLifecycle";
import { publishRound, autoPublishAt, previousRoundOf } from "./roundPublish";
import { publishReminderEmail, sendBulk } from "./email";

let _repo: Repository | null = null;
let _realtime: Realtime | null = null;

/** Actor recorded in the audit log when the deadline publishes, not a person. */
const SYSTEM_ACTOR = "system:auto-publish";

export function initRoundScheduler(repo: Repository, realtime: Realtime): void {
  _repo = repo;
  _realtime = realtime;

  registerWorker("round:open", async (data) => {
    const { roundId } = data as { roundId: string };
    const repo = _repo!;
    const realtime = _realtime!;

    const round = await repo.rounds.findById(roundId);
    if (!round) return;
    if (round.status !== "pending") return;

    // Scrambles are pre-generated for every round when the competition is
    // published, so there is nothing to generate here. The scramble endpoint
    // keeps a last-resort fallback if a set ever goes missing.
    await repo.rounds.update(round.id, { status: "open" });
    realtime.emitRoundStatus(round.id, "open" as RoundStatus, round.opensAt);
    console.log(`⏱ Round ${round.id} scheduled-open`);
  });

  // Publishing is what advances competitors, and rounds open on the clock
  // regardless — so a round nobody published leaves the next one admitting
  // nobody. These two workers are the backstop: a reminder, then the deadline.
  registerWorker("round:publish-warn", async (data) => {
    const { roundId } = data as { roundId: string };
    const repo = _repo!;

    const round = await repo.rounds.findById(roundId);
    if (!round || round.resultsPublishedAt) return;

    // Re-read the deadline at fire time — the setting may have changed, or been
    // switched off, since this job was queued.
    const at = await autoPublishAt(repo, round);
    if (!at) return;

    const event = await repo.competitionEvents.findById(round.competitionEventId);
    if (!event) return;
    const comp = await repo.competitions.findById(event.competitionId);

    // The organiser and the judges who can actually finish the verification.
    const assignments = await repo.judgeAssignments.findByRound(round.id);
    const ids = [...new Set([comp?.createdBy, ...assignments.map((a) => a.judgeId)])].filter(
      (id): id is string => Boolean(id),
    );
    const users = await repo.users.findByIds(ids);

    const messages = ids
      .map((id) => users.get(id))
      .filter((u): u is NonNullable<typeof u> => Boolean(u?.email))
      .map((u) => {
        const msg = publishReminderEmail(u.name, comp?.title ?? "Competition", round.roundNumber, at);
        return { to: u.email, subject: msg.subject, html: msg.html };
      });

    if (messages.length === 0) return;
    const sent = await sendBulk(messages);
    console.log(`📧 Round ${round.id} publish reminder sent to ${sent}/${messages.length}`);
  });

  registerWorker("round:auto-publish", async (data) => {
    const { roundId } = data as { roundId: string };
    const repo = _repo!;
    const realtime = _realtime!;

    const round = await repo.rounds.findById(roundId);
    if (!round || round.resultsPublishedAt) return;
    // Still switched on?
    if (!(await autoPublishAt(repo, round))) return;

    const outcome = await publishRound(repo, realtime, round, {
      actorId: SYSTEM_ACTOR,
      auto: true,
    });
    if (outcome.ok) {
      console.log(
        `⏱ Round ${round.id} auto-published — ${outcome.result.advancedCount} advanced`,
      );
    } else if (outcome.error !== "round_not_closed") {
      // A round still running simply has not reached its own close yet.
      console.warn(`⏱ Round ${round.id} auto-publish skipped: ${outcome.error}`);
    }
  });

  registerWorker("round:close", async (data) => {
    const { roundId } = data as { roundId: string };
    const repo = _repo!;
    const realtime = _realtime!;

    const round = await repo.rounds.findById(roundId);
    if (!round) return;
    if (round.status !== "open" && round.status !== "pending") return;

    await closeRound(repo, realtime, round);
    console.log(`⏱ Round ${round.id} scheduled-close`);
  });
}

export async function scheduleRoundJobs(round: Round): Promise<void> {
  const queue = await getQueue();
  const now = Date.now();

  await scheduleAutoPublishJobs(round, queue, now);

  // This round's opening time is what sets the *previous* round's publish
  // deadline, so moving round 2 has to requeue round 1's.
  if (_repo) {
    const prev = await previousRoundOf(_repo, round);
    if (prev) await scheduleAutoPublishJobs(prev, queue, now);
  }

  if (round.opensAt) {
    const openAt = new Date(round.opensAt).getTime();
    const delay = Math.max(0, openAt - now);
    await queue.remove(`round:open:${round.id}`);
    if (round.status === "pending" && openAt > now) {
      await queue.add("round:open", { roundId: round.id }, {
        delay,
        jobId: `round:open:${round.id}`,
      });
    }
  }

  if (round.closesAt) {
    const closeAt = new Date(round.closesAt).getTime();
    const delay = Math.max(0, closeAt - now);
    await queue.remove(`round:close:${round.id}`);
    if ((round.status === "pending" || round.status === "open") && closeAt > now) {
      await queue.add("round:close", { roundId: round.id }, {
        delay,
        jobId: `round:close:${round.id}`,
      });
    }
  }
}

export async function cancelRoundJobs(roundId: string): Promise<void> {
  const queue = await getQueue();
  await queue.remove(`round:open:${roundId}`);
  await queue.remove(`round:close:${roundId}`);
  await queue.remove(`round:auto-publish:${roundId}`);
  await queue.remove(`round:publish-warn:${roundId}`);
}

/**
 * Queue the deadline that publishes this round, and the reminder before it.
 *
 * The timing comes from the *next* round's opening — this round's results have
 * to exist before competitors arrive for the one after it. A final round has
 * nothing following it, so it is never scheduled and stays manual.
 */
async function scheduleAutoPublishJobs(
  round: Round,
  queue: Awaited<ReturnType<typeof getQueue>>,
  now: number,
): Promise<void> {
  // Always clear first: the schedule may have moved, or the deadline been
  // switched off, since these were last queued.
  await queue.remove(`round:auto-publish:${round.id}`);
  await queue.remove(`round:publish-warn:${round.id}`);

  if (round.resultsPublishedAt) return;
  if (!_repo) return;

  const at = await autoPublishAt(_repo, round);
  if (!at) return;

  const publishAt = at.getTime();
  if (publishAt > now) {
    await queue.add("round:auto-publish", { roundId: round.id }, {
      delay: publishAt - now,
      jobId: `round:auto-publish:${round.id}`,
    });
  }

  const settings = await _repo.systemSettings.get();
  const warnAt = publishAt - settings.publishWarningLeadHours * 3_600_000;
  if (settings.publishWarningLeadHours > 0 && warnAt > now) {
    await queue.add("round:publish-warn", { roundId: round.id }, {
      delay: warnAt - now,
      jobId: `round:publish-warn:${round.id}`,
    });
  }
}
