import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type { AddressInfo } from "node:net";
import type { FastifyInstance } from "fastify";
import { io as ioClient, type Socket } from "socket.io-client";
import { buildApp } from "../src/app";
import { createMemRepo } from "../src/db/mem-repo";
import type { Repository } from "../src/db/repo";
import { seed, SEED_DEMO_COMP_ID } from "../src/db/seed";
import { createRealtime, type AttachableRealtime } from "../src/sockets/realtime";
import { loginAndSync } from "./helpers";

let app: FastifyInstance;
let repo: Repository;
let realtime: AttachableRealtime;
let baseUrl: string;
let roundId: string;
let eventId: string;

beforeAll(async () => {
  repo = createMemRepo();
  await seed(repo);
  realtime = createRealtime();
  app = await buildApp(repo, realtime);
  await app.ready();
  realtime.attach(app, repo);
  await app.listen({ port: 0, host: "127.0.0.1" });

  const { port } = app.server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${port}`;

  const detail = (await (
    await fetch(`${baseUrl}/api/v1/competitions/${SEED_DEMO_COMP_ID}`)
  ).json()) as { events: { id: string; eventType: string; rounds: { id: string }[] }[] };
  const ev = detail.events.find((e) => e.eventType === "333")!;
  eventId = ev.id;
  roundId = ev.rounds[0]!.id;
});

afterAll(async () => {
  await realtime.close();
  await app.close();
});

function connectAndJoin(): Promise<Socket> {
  return new Promise((resolve) => {
    const socket = ioClient(baseUrl, { transports: ["websocket"] });
    socket.on("connect", () => {
      socket.emit("join", { roundId });
      setTimeout(() => resolve(socket), 50);
    });
  });
}

function nextLeaderboard(socket: Socket): Promise<{ roundId: string; board: unknown[] }> {
  return new Promise((resolve) => {
    socket.once("leaderboard:update", resolve);
  });
}

describe("live leaderboard over Socket.io", () => {
  it("broadcasts leaderboard:update to all clients in the round room on submit", async () => {
    const [a, b] = await Promise.all([connectAndJoin(), connectAndJoin()]);
    const updates = Promise.all([nextLeaderboard(a), nextLeaderboard(b)]);

    const { token, id: userId } = await loginAndSync(baseUrl, "socket@x.com");
    // Mark user email+mobile verified and register for the event
    const user = await repo.users.findById(userId);
    if (user) await repo.users.update(userId, { emailVerified: true, mobileVerified: true });
    await fetch(`${baseUrl}/api/v1/competitions/${SEED_DEMO_COMP_ID}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ eventIds: [eventId] }),
    });

    const res = await fetch(`${baseUrl}/api/v1/rounds/${roundId}/results`, {
      method: "POST",
      headers: { "Content-Type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({
        solves: [8000, 9000, 7000, 10000, 8500].map((t) => ({
          time_ms: t,
          inspectionPenalty: "none",
          penalty: "none",
        })),
      }),
    });
    expect(res.status).toBe(201);

    const [updateA, updateB] = await updates;
    expect(updateA.roundId).toBe(roundId);
    expect(updateA.board.length).toBe(1);
    expect((updateA.board[0] as { userId: string }).userId).toBe(userId);
    expect(updateB.board.length).toBe(1);

    a.disconnect();
    b.disconnect();
  });
});
