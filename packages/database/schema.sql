-- ────────────────────────────────────────────────────────────────
-- Cubelelo Events Platform — canonical PostgreSQL schema (Phase 1)
-- Source of truth for the data model. The in-memory dev store in
-- apps/api mirrors a subset of this until Supabase/Postgres is wired.
-- All durations are integer milliseconds. Per-solve data uses JSONB.
-- ────────────────────────────────────────────────────────────────

-- ─────────────────────────── ENUMS ───────────────────────────
create type user_role     as enum ('user','judge','moderator','admin');
create type account_stage as enum ('active','migrated_stub','suspended','banned');
create type comp_status   as enum ('draft','published','registration_open','registration_closed','cancelled','live','results_pending','completed');
create type comp_type     as enum ('paid','free','practice');
create type round_status  as enum ('pending','open','closed','advanced');
create type payment_status as enum ('pending','paid','failed','refunded','refund_pending');
create type solve_penalty as enum ('none','plus2','dnf');
create type flag_status   as enum ('clean','flagged','verified','disqualified');

-- ─────────────────────────── 1. users ───────────────────────────
create table users (
  id            uuid primary key,            -- == Supabase auth uid (sub)
  cl_id         text unique not null,        -- CL-YYYY-XXXX
  email         text unique not null,
  name          text not null,
  last_name     text,
  gender        text,
  dob           date,                         -- used for WCA verification
  mobile_no     text,
  city          text,
  state         text,
  country       text default 'India',
  avatar_url    text,
  instagram     text,
  wca_id        text,
  wca_verified  boolean not null default false,
  role          user_role not null default 'user',
  rank_tier     text,                         -- admin-configurable thresholds
  account_stage account_stage not null default 'active',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- ─────────────────────────── 2. competitions ───────────────────────────
create table competitions (
  id                    uuid primary key default gen_random_uuid(),
  title                 text not null,
  type                  comp_type not null default 'paid',
  status                comp_status not null default 'draft',
  banner_url            text,
  mobile_banner_url     text,
  description           text,
  rules_md              text,
  base_fee              integer not null default 0,   -- paise
  per_event_fee         integer not null default 0,   -- paise
  registration_deadline timestamptz,
  created_by            uuid references users(id),
  published_by          uuid references users(id),
  registration_limit    integer,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

-- ─────────────────────────── 3. competition_events ───────────────────────────
create table competition_events (
  id             uuid primary key default gen_random_uuid(),
  competition_id uuid not null references competitions(id) on delete cascade,
  event_type     text not null,                -- '333','222','444','pyram',...
  round_count    integer not null default 1,
  cutoff_ms      integer,
  time_limit_ms  integer,
  fee            integer,                          -- paise, null = use competition perEventFee
  created_at     timestamptz not null default now(),
  unique (competition_id, event_type)
);

-- ─────────────────────────── 4. rounds ───────────────────────────
create table rounds (
  id                   uuid primary key default gen_random_uuid(),
  competition_event_id uuid not null references competition_events(id) on delete cascade,
  round_number         integer not null,
  advancement_count    integer,                 -- top N advance (null = final)
  status               round_status not null default 'pending',
  opens_at             timestamptz,
  closes_at            timestamptz,
  created_at           timestamptz not null default now(),
  unique (competition_event_id, round_number)
);

-- ─────────────────────────── 5. scramble_sets ───────────────────────────
create table scramble_sets (
  id             uuid primary key default gen_random_uuid(),
  round_id       uuid not null references rounds(id) on delete cascade,
  scrambles_json jsonb not null,               -- ["R U R'...", ...]
  generated_at   timestamptz not null default now(),
  locked_at      timestamptz,
  locked_by      uuid references users(id),
  unique (round_id)
);

-- ─────────────────────────── 6. registrations ───────────────────────────
create table registrations (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  competition_id uuid not null references competitions(id) on delete cascade,
  payment_status payment_status not null default 'pending',
  created_at     timestamptz not null default now(),
  unique (user_id, competition_id)
);

-- ─────────────────────────── 7. registration_events (join) ───────────────────────────
create table registration_events (
  registration_id      uuid not null references registrations(id) on delete cascade,
  competition_event_id uuid not null references competition_events(id) on delete cascade,
  primary key (registration_id, competition_event_id)
);

-- ─────────────────────────── 8. results ───────────────────────────
create table results (
  id             uuid primary key default gen_random_uuid(),
  round_id       uuid not null references rounds(id) on delete cascade,
  user_id        uuid not null references users(id) on delete cascade,
  solves_json    jsonb not null,               -- [{time_ms,penalty}, x5]
  best_single_ms integer,
  ao5_ms         integer,
  mean_ms        integer,
  median_ms      integer,
  std_ms         integer,
  rank           integer,
  video_url      text,
  flag_status    flag_status not null default 'clean',
  verified_by    uuid references users(id),
  verified_at    timestamptz,
  submitted_at   timestamptz not null default now(),
  unique (round_id, user_id)
);

-- ─────────────────────────── 9. payments ───────────────────────────
create table payments (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null references users(id) on delete cascade,
  registration_id     uuid references registrations(id) on delete cascade,  -- set after payment confirmed
  competition_id      uuid references competitions(id),                      -- checkout intent
  event_ids           text,                                                  -- comma-separated competition_event ids
  amount              integer not null,         -- paise
  currency            text not null default 'INR',
  razorpay_order_id   text unique,
  razorpay_payment_id text unique,
  promo_code_id       uuid references promo_codes(id),
  status              payment_status not null default 'pending',
  gst_invoice_url     text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

-- ─────────────────────────── 10-13. practice + daily challenge ───────────────────────────
-- (Deferred — practice module is out of current scope. DDL kept for completeness.)
create table practice_sessions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users(id) on delete cascade,
  event_type text not null,
  name       text,
  created_at timestamptz not null default now(),
  ended_at   timestamptz
);

create table practice_solves (
  id         uuid primary key default gen_random_uuid(),
  session_id uuid not null references practice_sessions(id) on delete cascade,
  time_ms    integer not null,
  scramble   text not null,
  penalty    solve_penalty not null default 'none',
  note       text,
  created_at timestamptz not null default now()
);

create table personal_bests (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users(id) on delete cascade,
  event_type     text not null,
  best_single_ms integer,
  best_ao5_ms    integer,
  best_mean_ms   integer,
  best_median_ms integer,
  best_rank      integer,
  updated_at     timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  unique (user_id, event_type)
);

create table daily_challenges (
  id         uuid primary key default gen_random_uuid(),
  date       date unique not null,
  event_type text not null default '333',
  scramble   text not null,
  created_at timestamptz not null default now()
);

create table daily_challenge_results (
  id           uuid primary key default gen_random_uuid(),
  challenge_id uuid not null references daily_challenges(id) on delete cascade,
  user_id      uuid not null references users(id) on delete cascade,
  time_ms      integer not null,
  submitted_at timestamptz not null default now(),
  unique (challenge_id, user_id)
);

-- ─────────────────────────── audit_log ───────────────────────────
create table audit_log (
  id         uuid primary key default gen_random_uuid(),
  admin_id   uuid references users(id),
  action     text not null,
  target     text,
  reason     text,
  created_at timestamptz not null default now()
);

-- ─────────────────────────── indexes ───────────────────────────
create index idx_results_round_rank     on results (round_id, rank);
create index idx_registrations_comp     on registrations (competition_id);
create index idx_reg_events_event       on registration_events (competition_event_id);
create index idx_pb_user_event          on personal_bests (user_id, event_type);
create index idx_comp_status            on competitions (status);
create index idx_practice_sessions_user on practice_sessions (user_id);
