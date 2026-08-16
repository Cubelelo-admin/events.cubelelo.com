import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { createMemRepo } from "../src/db/mem-repo";
import type { Repository } from "../src/db/repo";
import { seed } from "../src/db/seed";
import { adminToken, bearer, devToken, syncVerifiedUser } from "./helpers";
import type { Realtime } from "../src/sockets/realtime";
import { noopRealtime } from "../src/sockets/realtime";

/**
 * Every path that changes the standings broadcasts the same board.
 *
 * Submitting a result used to build an enriched board — names joined in — while
 * judge verdicts, appeals and re-shortlists emitted the raw results with no
 * names and cleared the cache instead of refilling it. The client replaces the
 * board wholesale, so one +2 wiped every competitor's name off the live
 * leaderboard until the page refetched.
 */

let app: FastifyInstance;
let repo: Repository;
let admin: string;
let emitted: { roundId: string; board: unknown[] }[];

/** Captures what the socket layer is handed, without needing a real socket. */
function recordingRealtime(): Realtime {
  return {
    ...noopRealtime,
    emitLeaderboard(roundId: string, board: unknown) {
      emitted.push({ roundId, board: board as unknown[] });
    },
  };
}

async function roundWithOneResult() {
  const compId = randomUUID();
  const eventId = randomUUID();
  const roundId = randomUUID();
  const now = new Date().toISOString();

  await repo.competitions.create({
    id: compId,
    title: `Board Test ${randomUUID().slice(0, 8)}`,
    type: "free",
    status: "live",
    baseFee: 0,
    perEventFee: 0,
    featured: false,
    videoDeadlineMinutes: 1440,
    createdAt: now,
  });
  await repo.competitionEvents.create({
    id: eventId,
    competitionId: compId,
    eventType: "333",
    roundCount: 1,
  });
  await repo.rounds.create({
    id: roundId,
    competitionEventId: eventId,
    roundNumber: 1,
    status: "open",
  });

  const token = await devToken(app, `board-${compId.slice(0, 6)}@test.com`, "Named Cuber");
  const { id: userId } = await syncVerifiedUser(app, repo, token);

  const resultId = randomUUID();
  await repo.results.create({
    id: resultId,
    roundId,
    userId,
    solves: [9000, 9000, 9000, 9000, 9000].map((ms) => ({
      time_ms: ms,
      penalty: "none" as const,
      inspectionPenalty: "none" as const,
    })),
    bestSingleMs: 9000,
    ao5Ms: 9000,
    meanMs: 9000,
    medianMs: 9000,
    stdMs: 0,
    rank: 1,
    videoUrl: null,
    flagStatus: "clean",
    flagReasons: [],
    submittedAt: now,
  });

  return { roundId, resultId, userId };
}

beforeEach(async () => {
  emitted = [];
  repo = createMemRepo();
  await seed(repo);
  app = await buildApp(repo, recordingRealtime());
  admin = await adminToken(app);
  await app.inject({ method: "POST", url: "/api/v1/auth/sync", headers: bearer(admin) });
});

describe("the broadcast board", () => {
  it("still carries competitor names after a judge verdict", async () => {
    const { resultId } = await roundWithOneResult();

    const res = await app.inject({
      method: "POST",
      url: `/api/v1/admin/results/${resultId}/verify`,
      payload: { action: "plus2", reason: "inspection", solvePenalties: ["plus2", null, null, null, null] },
      headers: bearer(admin),
    });
    expect(res.statusCode).toBe(200);

    expect(emitted.length).toBeGreaterThan(0);
    const board = emitted[emitted.length - 1]!.board as { userName?: string }[];
    expect(board.length).toBe(1);
    // Before the fix this was undefined — the raw result carries no name.
    expect(board[0]!.userName).toBe("Named Cuber");
  });

  it("refills the cache rather than dropping it", async () => {
    const { roundId, resultId } = await roundWithOneResult();

    await app.inject({
      method: "POST",
      url: `/api/v1/admin/results/${resultId}/verify`,
      payload: { action: "verified" },
      headers: bearer(admin),
    });

    // The read path returns the same shape the socket sent.
    const read = await app.inject({ method: "GET", url: `/api/v1/rounds/${roundId}/results` });
    expect(read.statusCode).toBe(200);
    const rows = read.json() as { userName?: string }[];
    expect(rows[0]!.userName).toBe("Named Cuber");
  });
});
