import { io, type Socket } from "socket.io-client";

// `||` not `??`: NEXT_PUBLIC_API_URL is set to "" in local dev (HTTP goes through
// the Next rewrite proxy), but a socket cannot be proxied that way — Next only
// rewrites /api, not /socket.io. So an empty value must fall back to the API's
// own origin, or the socket connects to the web origin and silently never
// reaches the server. In production NEXT_PUBLIC_API_URL is the real API URL.
const BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
const TOKEN_KEY = "cubers_token";

let instance: Socket | null = null;
let refCount = 0;
let connectedWithToken: string | null = null;

// Rooms this client is in, refcounted so overlapping subscribers do not evict
// each other. Competitions are tracked alongside rounds because the competition
// page watches every round through one `comp:` room.
const joinedRooms = new Map<string, number>();
const joinedComps = new Map<string, number>();

function rejoinRooms(socket: Socket): void {
  for (const roundId of joinedRooms.keys()) {
    socket.emit("join", { roundId });
  }
  for (const compId of joinedComps.keys()) {
    socket.emit("join", { compId });
  }
}

function bump(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function drop(map: Map<string, number>, key: string): void {
  const count = map.get(key) ?? 0;
  if (count <= 1) map.delete(key);
  else map.set(key, count - 1);
}

export function trackJoin(roundId: string): void {
  bump(joinedRooms, roundId);
}

export function trackLeave(roundId: string): void {
  drop(joinedRooms, roundId);
}

export function trackCompJoin(compId: string): void {
  bump(joinedComps, compId);
}

export function trackCompLeave(compId: string): void {
  drop(joinedComps, compId);
}

export function acquireSocket(): Socket {
  const token =
    typeof window !== "undefined"
      ? localStorage.getItem(TOKEN_KEY)
      : null;

  if (instance && !instance.disconnected && connectedWithToken !== token) {
    instance.disconnect();
    instance = null;
    refCount = 0;
  }

  if (!instance || instance.disconnected) {
    connectedWithToken = token;
    instance = io(BASE_URL, {
      transports: ["websocket"],
      auth: (cb) => {
        cb(token ? { token } : {});
      },
    });
    instance.on("connect", () => {
      if (instance) rejoinRooms(instance);
    });
  }
  refCount++;
  return instance;
}

export function releaseSocket(): void {
  refCount = Math.max(0, refCount - 1);
  if (refCount === 0 && instance) {
    instance.disconnect();
    instance = null;
    connectedWithToken = null;
    refCount = 0;
    joinedRooms.clear();
    joinedComps.clear();
  }
}

export function reconnectSocket(): void {
  if (instance) {
    const token =
      typeof window !== "undefined"
        ? localStorage.getItem(TOKEN_KEY)
        : null;
    connectedWithToken = token;
    instance.disconnect();
    instance.connect();
  }
}
