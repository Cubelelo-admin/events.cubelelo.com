# API conventions

The contract every endpoint in `apps/api` follows. New routes must match it.
Older routes that predate it are noted at the end — leave them alone unless you
are already changing them for another reason, and bring them into line when you do.

## Error responses

One shape, everywhere:

```jsonc
{ "error": "round_not_found" }
```

`error` is a **machine-readable snake_case code**, never a human sentence. The
client switches on it and maps it to copy (see `FRIENDLY_ERRORS` in
[`apps/web/src/lib/api.ts`](../web/src/lib/api.ts)). Use `fail()` from
[`src/lib/httpError.ts`](src/lib/httpError.ts):

```ts
return fail(reply, 404, "round_not_found");
```

Two optional fields may accompany it, and nothing else:

| Field        | When                                                             |
| ------------ | ---------------------------------------------------------------- |
| `errors`     | `string[]` of field-level messages, for `*_validation_failed`     |
| `retryAfter` | seconds, on 429 responses                                        |

When you add a code, add its user-facing message to `FRIENDLY_ERRORS` too —
an unmapped code surfaces to the user as raw text.

In helpers with no `reply` in scope, `throw httpError(409, "code")`. The central
handler in [`src/app.ts`](src/app.ts) renders it. That handler only passes a
thrown message through when it matches `^[a-z][a-z0-9_]*$`; anything else
becomes `invalid_request`, so a library throwing a 4xx with prose cannot leak it.

## Status codes

| Code | Meaning                                                                       |
| ---- | ----------------------------------------------------------------------------- |
| 200  | successful read or update                                                     |
| 201  | **created** — every endpoint that creates a row returns this, with the entity  |
| 204  | successful delete with no body                                                |
| 400  | malformed or invalid input (validation failures are 400, never 422)           |
| 401  | no valid token                                                                |
| 403  | authenticated but not permitted — including `not_synced`                      |
| 404  | the addressed resource does not exist                                         |
| 409  | conflicts with current state (duplicate, wrong status, exhausted)             |
| 410  | a token or code that existed and has expired                                  |
| 429  | rate limited                                                                  |
| 502  | an upstream provider failed (payments, WCA, SMS, email)                       |
| 503  | a dependency is unavailable or unconfigured                                   |

One condition maps to one status across the whole API. `not_synced` is 403
everywhere; it used to be 403 in five modules and 404 in two.

## Success responses

- **Lists**: `{ data, total, page, limit }`. Every new list endpoint is paginated
  — no unbounded reads. Cap `limit` at 100.
- **Single entity**: the entity object, unwrapped.
- **Mutations with nothing to return**: 204, no body.

## Naming and representation

- **JSON fields are camelCase.** The Postgres mappers in
  [`src/db/pg-repo.ts`](src/db/pg-repo.ts) convert `snake_case` columns; never
  return a raw row.
- **Timestamps are ISO-8601 strings** (`new Date().toISOString()`), never epoch
  milliseconds, and never locale-formatted.
- **Durations are milliseconds**, with an `Ms` suffix: `cutoffMs`, `timeLimitMs`.
- **URL segments are kebab-case**; path parameters are `:id` for the addressed
  resource and `:<thing>Id` only for a second identifier in the same path.

## Authorization

- Declare guards in `preHandler`: `requireAuth`, or `requireRole(repo, ...roles)`
  from [`src/auth/plugin.ts`](src/auth/plugin.ts).
- Never compare role strings inline. Use `isAdmin`, `isAdminOrMod`, `isStaff`,
  `isSuperAdmin` from [`src/auth/ownership.ts`](src/auth/ownership.ts) — they
  encode the rule that `super_admin` inherits `admin`.
- Any route acting on a competition, round, event or result must run the matching
  ownership check from `createOwnershipChecks(repo)`. A moderator may only act on
  competitions they created.
- Endpoints returning personal data (names, cities, registrations) require auth
  even when the surrounding resource is public.

## Data access

All database access goes through the `Repository` interface in
[`src/db/repo.ts`](src/db/repo.ts). Routes must not import `db/pool` or issue
SQL. When an operation needs transactional or locking behaviour, add a repository
method that both `pg-repo` and `mem-repo` implement with the same observable
semantics — `results.createIfAbsent` is the worked example.

`mem-repo` is what the test suite runs against. If Postgres enforces something
(a unique index, an `ON CONFLICT`), `mem-repo` must enforce it too, or the tests
pass against behaviour production does not have.

## WCA domain rules

Round format, attempt counts, ranking metrics and cutoff attempt counts come from
[`packages/types/src/wca.ts`](../../packages/types/src/wca.ts). Do not re-derive
them from the event type. `src/lib/roundFormat.ts` resolves a round's format,
cutoff and time limit, including the pre-migration fallback.

Client-side enforcement of a competition rule is a convenience, not the rule. Any
constraint that affects a result — cutoff, time limit, attempt count — is enforced
in the submit handler as well.

## Known deviations

These predate the conventions above and are not yet migrated:

- ~28 list endpoints return a bare array with no pagination; several admin lists
  are unbounded reads.
- Envelope keys vary on older endpoints (`{rankings}`, `{participants}`,
  `{competitions}`, `{sessions}`) instead of `{data}`.
- No route declares a Fastify JSON schema; validation is hand-rolled. New routes
  should add schemas.
- `solves[].time_ms` is snake_case inside an otherwise camelCase object, and is
  part of the stored `solves_json` shape, so renaming it needs a migration.
- Some id parameters are `:regId`, `:clid`, `:roundId` where `:id` would do.
