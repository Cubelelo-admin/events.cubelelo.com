/**
 * The API's error contract — documentation, not machinery.
 *
 * `fail()` and `httpError()` helpers once lived here and were never adopted by a
 * single route; every handler writes `reply.code(n).send({ error: "..." })` by
 * hand and follows the convention below. Rewriting ~200 call sites to route
 * through a helper would be a large mechanical diff with no behaviour change, so
 * the helpers are gone and the written rules stay — they are the part that has
 * actually been useful.
 *
 * Every error response is `{ error: "<snake_case_code>" }`, optionally with extra
 * structured fields. The code is a machine-readable identifier the client
 * switches on — never a human sentence. Nine call sites used to put prose in
 * that slot ("max 200 results per bulk action"), which no client could match.
 *
 * Status code conventions:
 *   400  malformed or invalid input
 *   401  no valid token
 *   403  authenticated but not permitted, including "user row not synced"
 *   404  the addressed resource does not exist
 *   409  the request conflicts with current state (duplicate, wrong status)
 *   410  a token or code that existed but has expired
 *   422  unused — validation failures are 400
 *   429  rate limited
 *   502  an upstream provider (payments, WCA, SMS, email) failed
 *   503  a dependency this service needs is unavailable or unconfigured
 */

/** Extra fields an error body may carry alongside `error`. */
export interface ErrorDetails {
  /** Field-level validation messages, for codes ending in `_validation_failed`. */
  errors?: string[];
  /** Seconds until the caller may retry, for 429s. */
  retryAfter?: number;
}
