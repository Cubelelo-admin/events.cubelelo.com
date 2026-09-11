# Cubelelo Events Platform

An online speedcubing competition platform built for [Cubelelo](https://cubelelo.com). Competitors register, solve scrambles under timed conditions, and climb the rankings — all in the browser.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14 (App Router), React 18, Tailwind CSS |
| Backend | Fastify 5, Socket.io (real-time) |
| Database | PostgreSQL (Supabase) / in-memory for dev |
| Auth | Supabase Auth (Google OAuth) + local HS256 dev tokens |
| Payments | Razorpay |
| Storage | Supabase Storage (falls back to local `uploads/`) |
| Job Queue | BullMQ + Redis (falls back to in-process timers) |
| Scrambles | cubing.js (12 WCA events) |
| Email | Brevo API or SMTP (falls back to console logging) |
| SMS | Twilio (optional, for mobile verification) |
| Testing | Vitest (unit + integration), Playwright (E2E) |
| Monorepo | Turborepo + npm workspaces |

## Project Structure

```
cubers/
├── apps/
│   ├── api/          # Fastify backend (port 4000)
│   └── web/          # Next.js frontend (port 3000)
├── packages/
│   ├── scramble-core/ # Scramble generation engine
│   ├── timer-core/    # Timer logic
│   ├── types/         # Shared TypeScript types
│   └── database/      # DB migrations & seeds
├── e2e/               # Playwright end-to-end tests
└── project_details/   # PRD, progress tracker, todos
```

`apps/api/CONVENTIONS.md` documents the repository pattern both database
backends must satisfy — read it before touching `pg-repo.ts` or `mem-repo.ts`.

## Prerequisites

- **Node.js** >= 20
- **npm** >= 10

No other services are required for local development — the API runs with an in-memory database, local file storage, in-process job timers, and console-based email by default.

## Getting Started

### 1. Install dependencies

```bash
npm install
```

### 2. Start both apps

```bash
npm run dev
```

Turborepo starts the API on `http://localhost:4000` and the web app on
`http://localhost:3000`. With no `.env` present, the API uses the in-memory
backend and prints which fallbacks are active on boot.

To run them separately:

```bash
npm run dev --workspace=apps/api
npm run dev --workspace=apps/web
```

### 3. Environment variables (optional)

There is no `.env.example` in the repo. Every variable is optional for local
development — see [Environment Variables](#environment-variables) for the full
list and what each one falls back to. Create a `.env` at the repo root only when
you need to point at a real service.

### 4. Signing in locally

Register an account through the web app at `/register`; local sign-in issues an
HS256 token signed with `DEV_AUTH_SECRET`.

The seeded `admin@cubelelo.com` account exists in dev but has **no password**, so
it cannot be used with the normal login form. To act as an admin locally, mint a
token for it directly — `apps/api/test/helpers.ts` shows the exact signing code,
and the same token works from the browser when stored in `localStorage` under
`cubers_token`.

## Scripts

| Command | Description |
|---------|-------------|
| `npm run dev` | Start all apps in dev mode (Turborepo) |
| `npm run build` | Build all apps |
| `npm run typecheck` | Type-check every workspace |
| `npm run lint` | Lint every workspace |
| `npm run test` | Run unit and integration tests (Vitest) |
| `npm run test:e2e` | Run end-to-end tests (Playwright) |
| `npm start` | Start the API in production mode |

Migrations are applied separately:

```bash
npm run migrate --workspace=packages/database
```

## How a competition runs

The lifecycle is worth understanding before changing anything in
`apps/api/src/lib/round*.ts`:

1. **Registration** — free competitions create the registration immediately;
   paid ones create it only after payment succeeds, so an unpaid registration
   never exists. A registration's `status` (`active` / `withdrawn` / `removed`)
   is what decides whether it counts — never its `payment_status`.
2. **Rounds open and close on the clock.** Delayed jobs drive the transitions,
   and a 60-second ticker recovers any that were missed.
3. **Competitors submit** results, which are flagged automatically by the rules
   in `flagEngine.ts` when they look anomalous.
4. **Verification** — judges and admins clear or penalise flagged results.
   Verification deliberately **does not** advance anyone.
5. **Publish** is the pivot. It freezes the standings, computes the shortlist
   from them, and emails competitors. Only published rounds advance anyone.
   If nobody publishes in time, results publish automatically shortly before the
   next round opens, so it never starts with an empty field — the deadline and
   its reminder are configured in **Admin → Settings**.
6. **Shortlisted competitors** become the next round's field, or the winners if
   it was the final round.

## Testing

### Unit and integration tests (Vitest)

```bash
npm run test
```

The API suite runs against the in-memory repository, so it needs no database.
That is also its main limitation: in-memory has no enum constraints, so
`apps/api/test/enum-parity.test.ts` parses the migration files and asserts every
TypeScript union stays a subset of its Postgres enum. Keep that test passing —
it exists because a drifted enum crashed only in production.

### End-to-end tests (Playwright)

```bash
# One-time: install the browser
npx playwright install chromium

npm run test:e2e
```

The Playwright config auto-starts both the API (in-memory, port 4000) and the web app (port 3000) before tests run. No manual server setup needed.

| File | Covers |
|------|--------|
| `e2e/auth.spec.ts` | Homepage, login/register pages, auth flows |
| `e2e/competitions.spec.ts` | Competition listing page |
| `e2e/admin.spec.ts` | Admin panel pages, banner & FAQ CRUD |
| `e2e/api-health.spec.ts` | API health endpoint, public endpoints, rate limiting |

## Environment Variables

All variables are optional for local development. The platform falls back to
dev-friendly defaults and logs which mode it is in at startup.

| Variable | Purpose | Fallback |
|----------|---------|----------|
| `DATABASE_URL` | PostgreSQL connection string | In-memory store |
| `REDIS_URL` | Rate limiting, job queue, roster, leaderboard cache | In-process timers and counters |
| `DEV_AUTH_SECRET` | HS256 secret for local sign-in | `dev-secret-change-me` |
| `SUPABASE_URL` | Supabase project URL | Local dev auth |
| `SUPABASE_JWT_SECRET` | Verifies Supabase HS256 tokens (Google OAuth) | Local dev auth |
| `SUPABASE_JWKS_URL` | Overrides the derived JWKS endpoint | Derived in production only |
| `SUPABASE_SERVICE_KEY` | Supabase admin key, used for storage uploads | Local `uploads/` directory |
| `SUPABASE_STORAGE_URL` | Storage endpoint | Falls back to `SUPABASE_URL`, then local files |
| `SUPABASE_STORAGE_BUCKET` | Bucket name for uploads | `images` |
| `RAZORPAY_KEY_ID` / `RAZORPAY_KEY_SECRET` | Razorpay credentials | Payments disabled |
| `RAZORPAY_WEBHOOK_SECRET` | Verifies Razorpay webhooks | Webhook verification disabled |
| `BREVO_API_KEY` | Brevo transactional email | SMTP, then console logging |
| `SMTP_HOST` / `SMTP_PORT` / `SMTP_USER` / `SMTP_PASS` | SMTP email | Console logging |
| `EMAIL_FROM` | Sender identity | `Cubelelo Events <noreply@cubelelo.com>` |
| `TWILIO_ACCOUNT_SID` / `TWILIO_AUTH_TOKEN` | SMS for mobile verification | SMS disabled |
| `TWILIO_FROM_NUMBER` / `TWILIO_MESSAGING_SID` | Twilio sender | SMS disabled |
| `APP_URL` | Base URL used in emails | `http://localhost:3000` |
| `WCA_API_BASE` | WCA API endpoint | Public WCA API |
| `PORT` / `HOST` | API bind address | `4000` / `0.0.0.0` |

`apps/web` reads its own `NEXT_PUBLIC_*` variables (baked in at build time, so
these must be set wherever the web app is *built*, not just where it runs):

| Variable | Purpose | Fallback |
|----------|---------|----------|
| `API_URL` | Server-side origin the Next app proxies `/api/v1` and `/uploads` to (`next.config.mjs`) | `http://localhost:4000` |
| `APP_URL` | Public site origin — used for `metadataBase`, the sitemap and OG image URLs | `http://localhost:3000` |
| `NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Enables Supabase Google OAuth sign-in | Local email/password auth only |
| `NEXT_PUBLIC_GA_MEASUREMENT_ID` | Google Analytics 4 measurement ID | Analytics disabled — no script is loaded |

### Required in production

`apps/api/src/config/env.ts` refuses to boot with `NODE_ENV=production` unless:

- `DEV_AUTH_SECRET` is set to a real value of at least 32 characters
- `REDIS_URL` is set — the roster, job queue and rate limiter all need it
- `RAZORPAY_WEBHOOK_SECRET` is set whenever Razorpay is enabled

## Deployment

Split across two services — `apps/web` and `apps/api` do not deploy together:

- **`apps/api`** — `render.yaml` at the repo root (Render Blueprint). Requires
  the production env vars above plus the rest of that file's `envVars` list.
- **`apps/web`** — `vercel.json` at the repo root. Import the repo into
  Vercel with the Root Directory left at the repo default (not set to
  `apps/web` — `vercel.json` already runs `npm install` and
  `npm run build --workspace=apps/web` from there); set `API_URL` to the
  deployed API's URL and the `NEXT_PUBLIC_*` vars from the table above as
  Vercel project environment variables (they're baked in at build time, so
  they must be set before the build, not just at runtime).

## Key Features

- **Competition Management** — Create, configure, and run multi-round competitions, with a shared form so the Create and Manage screens cannot drift apart
- **Publish-driven Advancement** — Results are final when published; shortlisting follows WCA Regulation 9p, including the 75% cap and tie-safe boundaries
- **Real-time Leaderboard** — Socket.io powered live standings that switch to final standings once a round is published
- **WCA-compliant Timer** — Web Worker-based timer with inspection, +2/DNF penalties, and per-format attempt counts
- **12 WCA Events** — Scramble generation via cubing.js, pre-generated when a competition is published
- **Verification** — Video review, statistical outlier flagging, per-attempt judge penalties, and an appeals flow
- **Withdrawals** — Competitors leave free competitions directly; paid ones raise a request the organiser reviews with the payment details in front of them
- **User Profiles** — CL IDs, personal bests, competition history, WCA ID linking
- **Admin Panel** — Competitions, participants, staff and roles, payments, promo codes, verification hub, content editor
- **Payments** — Razorpay integration with per-event fees, promo codes, GST invoices
- **Dark/Light Theme** — System-aware with manual toggle

## License

Private — Cubelelo.