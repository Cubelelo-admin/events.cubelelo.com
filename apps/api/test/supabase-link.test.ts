import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll } from "vitest";
import { SignJWT } from "jose";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app";
import { createMemRepo } from "../src/db/mem-repo";
import type { Repository } from "../src/db/repo";
import { env } from "../src/config/env";
import { seed } from "../src/db/seed";
import { bearer, devToken } from "./helpers";

let app: FastifyInstance;
let repo: Repository;

beforeAll(async () => {
  repo = createMemRepo();
  await seed(repo);
  app = await buildApp(repo);
});

async function tokenWithSub(sub: string, email: string): Promise<string> {
  const secret = new TextEncoder().encode(env.DEV_AUTH_SECRET);
  return new SignJWT({ email, name: email.split("@")[0] })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(sub)
    .setJti(randomUUID())
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(secret);
}

describe("Supabase OAuth account linking", () => {
  const EMAIL = "oauth-test@example.com";
  let localId: string;
  let googleSub: string;

  it("registers a user via local auth", async () => {
    const localToken = await devToken(app, EMAIL, "OAuth Test");
    const sync = await app.inject({
      method: "POST",
      url: "/api/v1/auth/sync",
      headers: bearer(localToken),
    });
    expect(sync.statusCode).toBe(200);
    localId = sync.json().id;
  });

  it("links on first Google sign-in (different sub, same email)", async () => {
    googleSub = randomUUID();
    const googleToken = await tokenWithSub(googleSub, EMAIL);

    const sync = await app.inject({
      method: "POST",
      url: "/api/v1/auth/sync",
      headers: bearer(googleToken),
    });
    expect(sync.statusCode).toBe(200);
    expect(sync.json().id).toBe(localId);

    const linked = await repo.users.findBySupabaseId(googleSub);
    expect(linked).not.toBeNull();
    expect(linked!.id).toBe(localId);
  });

  it("auth hook resolves Google sub on subsequent requests", async () => {
    const googleToken = await tokenWithSub(googleSub, EMAIL);

    const me = await app.inject({
      method: "GET",
      url: "/api/v1/users/me",
      headers: bearer(googleToken),
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().id).toBe(localId);
  });

  it("all routes work with the Google OAuth token (sub != internal id)", async () => {
    const googleToken = await tokenWithSub(googleSub, EMAIL);

    const profile = await app.inject({
      method: "PATCH",
      url: "/api/v1/users/me",
      payload: { city: "Mumbai" },
      headers: bearer(googleToken),
    });
    expect(profile.statusCode).toBe(200);
    expect(profile.json().city).toBe("Mumbai");

    const practice = await app.inject({
      method: "POST",
      url: "/api/v1/practice/sessions",
      payload: { eventType: "333" },
      headers: bearer(googleToken),
    });
    // Creates return 201, matching every other create in the API.
    expect(practice.statusCode).toBe(201);
  });
});
