import { Server } from "socket.io";
import type { FastifyInstance } from "fastify";
import type { RoundStatus } from "@cubers/types";
import type { Repository } from "../db/repo";
import { env } from "../config/env";
import { type AuthClaims, createVerifier } from "../auth/verifier";
import { isTokenBlocked } from "../lib/tokenBlocklist";

const REAUTH_INTERVAL_MS = 5 * 60 * 1000;
const LEADERBOARD_DEBOUNCE_MS = 300;
const MAX_ROOMS_PER_SOCKET = 10;

// ── Per-socket rate limiter (token bucket) ────────────────────────────────

interface RateBucket {
  tokens: number;
  lastRefill: number;
}

function checkRate(
  buckets: Map<string, RateBucket>,
  event: string,
  maxTokens: number,
  refillPerSec: number,
): boolean {
  const now = Date.now();
  let bucket = buckets.get(event);
  if (!bucket) {
    bucket = { tokens: maxTokens, lastRefill: now };
    buckets.set(event, bucket);
  }
  const elapsed = (now - bucket.lastRefill) / 1000;
  bucket.tokens = Math.min(maxTokens, bucket.tokens + elapsed * refillPerSec);
  bucket.lastRefill = now;
  if (bucket.tokens < 1) return false;
  bucket.tokens -= 1;
  return true;
}

// ── Leaderboard payload slimming ──────────────────────────────────────────

interface SlimResult {
  id: string;
  userId: string;
  userName?: string;
  userClId?: string;
  ao5Ms: number | null;
  bestSingleMs: number | null;
  rank: number | null;
  flagStatus: string;
}

function slimBoard(board: unknown): SlimResult[] {
  if (!Array.isArray(board)) return [];
  return board.map((r: Record<string, unknown>) => ({
    id: r.id as string,
    userId: r.userId as string,
    userName: r.userName as string | undefined,
    userClId: r.userClId as string | undefined,
    ao5Ms: r.ao5Ms as number | null,
    bestSingleMs: r.bestSingleMs as number | null,
    rank: r.rank as number | null,
    flagStatus: (r.flagStatus as string) ?? "clean",
  }));
}

function boardFingerprint(board: SlimResult[]): string {
  return board.map((r) => `${r.userId}:${r.rank}:${r.ao5Ms}:${r.bestSingleMs}:${r.flagStatus}`).join("|");
}

// ── Realtime interface ────────────────────────────────────────────────────

export interface RealtimeStats {
  connections: number;
  uniqueUsers: number;
  rooms: number;
}

export interface Realtime {
  emitLeaderboard(roundId: string, board: unknown): void;
  emitRoundStatus(roundId: string, status: RoundStatus, opensAt?: string): void;
  emitCompStatus(compId: string, status: string): void;
  disconnectUser(userId: string): void;
  stats(): RealtimeStats;
}

export const noopRealtime: Realtime = {
  emitLeaderboard() {},
  emitRoundStatus() {},
  emitCompStatus() {},
  disconnectUser() {},
  stats() { return { connections: 0, uniqueUsers: 0, rooms: 0 }; },
};

export interface AttachableRealtime extends Realtime {
  attach(app: FastifyInstance, repo: Repository): Promise<Server>;
  close(): Promise<void>;
}

export function createRealtime(): AttachableRealtime {
  let io: Server | null = null;
  const roomOf = (roundId: string) => `round:${roundId}`;

  // userId → set of socket IDs for instant revocation
  const userSockets = new Map<string, Set<string>>();

  // Leaderboard debounce: roundId → pending timer + latest board
  const leaderboardPending = new Map<string, { timer: ReturnType<typeof setTimeout>; board: unknown }>();
  // Last emitted fingerprint per round — skip broadcast if unchanged
  const lastBoardFingerprint = new Map<string, string>();

  // Round → competition, so a status change can also reach viewers watching the
  // whole competition. Resolved lazily and cached: a round never changes owner.
  const compIdByRound = new Map<string, string>();
  let repoRef: Repository | null = null;

  async function competitionIdOf(roundId: string): Promise<string | null> {
    const cached = compIdByRound.get(roundId);
    if (cached) return cached;
    if (!repoRef) return null;
    const ev = await repoRef.competitionEvents.findByRound(roundId);
    if (!ev) return null;
    compIdByRound.set(roundId, ev.competitionId);
    return ev.competitionId;
  }

  // Roster debounce: coalesce rapid check-ins into a single broadcast
  const ROSTER_DEBOUNCE_MS = 300;
  const rosterPending = new Map<string, ReturnType<typeof setTimeout>>();

  function trackSocket(userId: string, socketId: string) {
    let set = userSockets.get(userId);
    if (!set) {
      set = new Set();
      userSockets.set(userId, set);
    }
    set.add(socketId);
  }

  function untrackSocket(userId: string | undefined, socketId: string) {
    if (!userId) return;
    const set = userSockets.get(userId);
    if (!set) return;
    set.delete(socketId);
    if (set.size === 0) userSockets.delete(userId);
  }

  return {
    stats() {
      const connections = io?.sockets.sockets.size ?? 0;
      const uniqueUsers = userSockets.size;
      const rooms = io ? io.sockets.adapter.rooms.size - connections : 0;
      return { connections, uniqueUsers, rooms: Math.max(0, rooms) };
    },

    emitLeaderboard(roundId, board) {
      const flush = (b: unknown) => {
        const slim = slimBoard(b);
        const fp = boardFingerprint(slim);
        if (lastBoardFingerprint.get(roundId) === fp) return;
        lastBoardFingerprint.set(roundId, fp);
        io?.to(roomOf(roundId)).emit("leaderboard:update", { roundId, board: slim });
      };

      const existing = leaderboardPending.get(roundId);
      if (existing) {
        clearTimeout(existing.timer);
        existing.board = board;
        existing.timer = setTimeout(() => {
          leaderboardPending.delete(roundId);
          flush(existing.board);
        }, LEADERBOARD_DEBOUNCE_MS);
      } else {
        const entry = {
          board,
          timer: setTimeout(() => {
            leaderboardPending.delete(roundId);
            flush(entry.board);
          }, LEADERBOARD_DEBOUNCE_MS),
        };
        leaderboardPending.set(roundId, entry);
      }
    },

    emitRoundStatus(roundId, status, opensAt) {
      const payload = { roundId, status, opensAt };
      io?.to(roomOf(roundId)).emit("round:status", payload);

      // The competition page shows every round at once, and a socket may join
      // only MAX_ROOMS_PER_SOCKET rooms — joining one room per round silently
      // stops working past the tenth. Fanning the same event out to the
      // competition room lets that page watch all of them with one join.
      void competitionIdOf(roundId).then((compId) => {
        if (compId) io?.to(`comp:${compId}`).emit("round:status", payload);
      });
    },

    emitCompStatus(compId, status) {
      io?.to(`comp:${compId}`).emit("comp:status", { compId, status });
    },

    disconnectUser(userId) {
      const set = userSockets.get(userId);
      if (!set || !io) return;
      for (const socketId of set) {
        const socket = io.sockets.sockets.get(socketId);
        socket?.emit("auth:revoked", { reason: "session_invalidated" });
        socket?.disconnect(true);
      }
      userSockets.delete(userId);
    },

    async attach(app, repo) {
      repoRef = repo;
      const corsOrigin = process.env.CORS_ORIGINS
        ? process.env.CORS_ORIGINS.split(",")
        : true;
      io = new Server(app.server, {
        cors: { origin: corsOrigin },
        maxHttpBufferSize: 64 * 1024,
        pingInterval: 25000,
        pingTimeout: 20000,
      });

      // Use Redis pub/sub adapter for horizontal scaling when REDIS_URL is set
      if (env.REDIS_URL) {
        try {
          const { createAdapter } = await import("@socket.io/redis-adapter");
          const { default: Redis } = await import("ioredis");
          const pub = new Redis(env.REDIS_URL);
          const sub = pub.duplicate();
          io.adapter(createAdapter(pub, sub));
          console.log("Socket.io using Redis adapter");
        } catch (err) {
          console.error("Socket.io Redis adapter failed:", err);
        }
      }

      const userNameCache = new Map<string, Map<string, { name: string; clId?: string }>>();

      const doBroadcastRoster = async (roundId: string) => {
        const raw = await repo.roster.snapshot(roundId);
        let cache = userNameCache.get(roundId);
        const uncachedIds = raw.filter((r) => !cache?.has(r.userId)).map((r) => r.userId);
        if (uncachedIds.length > 0) {
          const fetched = await repo.users.findByIds(uncachedIds);
          if (!cache) { cache = new Map(); userNameCache.set(roundId, cache); }
          for (const [id, u] of fetched) cache.set(id, { name: u.name, clId: u.clId });
        }
        const competitors = raw.map((r) => {
          const u = cache?.get(r.userId);
          return { userId: r.userId, name: r.name, clId: u?.clId ?? undefined };
        });
        io?.to(roomOf(roundId)).emit("lobby:roster", { roundId, competitors });
      };

      const broadcastRoster = (roundId: string) => {
        const existing = rosterPending.get(roundId);
        if (existing) clearTimeout(existing);
        rosterPending.set(roundId, setTimeout(() => {
          rosterPending.delete(roundId);
          doBroadcastRoster(roundId).catch((err) => console.error("Roster broadcast error:", err));
        }, ROSTER_DEBOUNCE_MS));
      };

      const verifier = createVerifier();

      io.use(async (socket, next) => {
        const token = socket.handshake.auth?.token as string | undefined;
        if (!token) {
          socket.data.authClaims = null;
          return next();
        }
        try {
          const claims = await verifier.verify(token);

          if (claims.jti && await isTokenBlocked(claims.jti)) {
            return next(new Error("token_revoked"));
          }

          const linked = await repo.users.findBySupabaseId(claims.sub);
          if (linked) {
            if (linked.accountStage === "deleted" || linked.accountStage === "suspended" || linked.accountStage === "banned") {
              return next(new Error("account_inactive"));
            }
            claims.sub = linked.id;
          }

          socket.data.authClaims = claims;
          socket.data.rawToken = token;
        } catch {
          socket.data.authClaims = null;
        }
        next();
      });

      io.on("connection", (socket) => {
        const claims = socket.data.authClaims as AuthClaims | null;
        if (claims) {
          trackSocket(claims.sub, socket.id);
        }

        // Per-socket rate limit state
        const rateBuckets = new Map<string, RateBucket>();
        let joinedRoomCount = 0;

        // Periodic re-auth: verify token is still valid every 5 minutes
        const reauthTimer = claims ? setInterval(async () => {
          const c = socket.data.authClaims as AuthClaims | null;
          if (!c) { clearInterval(reauthTimer!); return; }

          if (c.jti && await isTokenBlocked(c.jti)) {
            socket.emit("auth:revoked", { reason: "token_blocked" });
            socket.disconnect(true);
            return;
          }

          const user = await repo.users.findById(c.sub);
          if (!user || user.accountStage === "deleted" || user.accountStage === "suspended" || user.accountStage === "banned") {
            socket.emit("auth:revoked", { reason: "account_inactive" });
            socket.disconnect(true);
          }
        }, REAUTH_INTERVAL_MS) : null;

        socket.on("join", async (payload: { roundId?: string; compId?: string }) => {
          // Rate limit: 5 joins/sec, burst of 10
          if (!checkRate(rateBuckets, "join", 10, 5)) return;

          if (joinedRoomCount >= MAX_ROOMS_PER_SOCKET) return;

          if (payload?.roundId) {
            const round = await repo.rounds.findById(payload.roundId);
            if (!round) return;
            socket.join(roomOf(payload.roundId));
            joinedRoomCount++;
          }
          if (payload?.compId) {
            if (joinedRoomCount >= MAX_ROOMS_PER_SOCKET) return;
            const comp = await repo.competitions.findById(payload.compId);
            if (!comp) return;
            socket.join(`comp:${payload.compId}`);
            joinedRoomCount++;
          }
        });

        socket.on(
          "lobby:checkin",
          async (payload: { roundId?: string; name?: string }) => {
            if (!claims) return;

            // Rate limit: 1 checkin/sec, burst of 3
            if (!checkRate(rateBuckets, "lobby:checkin", 3, 1)) return;

            const { roundId } = payload ?? {};
            if (!roundId) return;

            // Validate round exists
            const round = await repo.rounds.findById(roundId);
            if (!round) return;

            // Idempotent: skip if already checked into this round
            const existingLobby = socket.data.lobby as { roundId: string; userId: string } | undefined;
            if (existingLobby?.roundId === roundId) return;

            socket.join(roomOf(roundId));
            socket.data.lobby = { roundId, userId: claims.sub };
            const user = await repo.users.findById(claims.sub);
            await repo.roster.join(roundId, claims.sub, payload.name?.trim() || user?.name || claims.name || claims.sub.slice(0, 8));
            broadcastRoster(roundId);
          },
        );

        socket.on("lobby:checkout", async (payload: { roundId?: string }) => {
          if (!claims) return;
          if (!checkRate(rateBuckets, "lobby:checkout", 3, 1)) return;
          const lobby = socket.data.lobby as { roundId: string; userId: string } | undefined;
          if (!lobby || lobby.roundId !== payload?.roundId) return;
          socket.data.lobby = undefined;
          socket.leave(roomOf(lobby.roundId));
          await repo.roster.leave(lobby.roundId, lobby.userId);
          broadcastRoster(lobby.roundId);
        });

        socket.on("disconnect", async () => {
          if (reauthTimer) clearInterval(reauthTimer);
          const c = socket.data.authClaims as AuthClaims | null;
          if (c) untrackSocket(c.sub, socket.id);

          const lobby = socket.data.lobby as
            | { roundId: string; userId: string }
            | undefined;
          if (!lobby) return;
          await repo.roster.leave(lobby.roundId, lobby.userId);
          broadcastRoster(lobby.roundId);
        });
      });

      return io;
    },

    async close() {
      for (const entry of leaderboardPending.values()) clearTimeout(entry.timer);
      leaderboardPending.clear();
      for (const timer of rosterPending.values()) clearTimeout(timer);
      rosterPending.clear();
      await io?.close();
      io = null;
    },
  };
}
