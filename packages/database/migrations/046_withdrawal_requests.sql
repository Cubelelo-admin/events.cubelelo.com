-- Migration 046: Withdrawal requests for paid competitions.
--
-- A competitor on a paid competition cannot simply leave — money changed hands,
-- so an organiser has to settle it. Until now the API said "contact the
-- organiser" and offered no channel to do so, which left the competitor stuck.
--
-- This is the appeals table's shape (migration 007) applied to registrations:
-- the competitor asks with a reason, an admin approves or rejects with a
-- response, and both sides can see the outcome. Approving is what marks the
-- registration withdrawn; refunds stay manual.

CREATE TABLE IF NOT EXISTS withdrawal_requests (
  id              uuid primary key default gen_random_uuid(),
  registration_id uuid not null references registrations(id) on delete cascade,
  user_id         uuid not null references users(id) on delete cascade,
  reason          text not null,
  status          text not null default 'pending',   -- pending | approved | rejected
  admin_response  text,
  resolved_by     uuid references users(id),
  created_at      timestamptz not null default now(),
  resolved_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_user
  ON withdrawal_requests (user_id);
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_registration
  ON withdrawal_requests (registration_id);
CREATE INDEX IF NOT EXISTS idx_withdrawal_requests_status
  ON withdrawal_requests (status);
