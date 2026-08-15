-- Migration 045: Registration validity gets its own column.
--
-- `payment_status` was carrying two unrelated meanings: "did money arrive"
-- (only meaningful for paid competitions) and "is this registration valid"
-- (meaningful for all of them). Free competitions have no payment, so their rows
-- were written as 'paid' to make the second meaning work — which made the first
-- meaning false and left withdrawal impossible for everyone, since the withdraw
-- endpoint refuses any row marked 'paid'.
--
-- `payment_status` keeps its existing values untouched; it simply stops being
-- read to decide validity.

DO $$ BEGIN
  CREATE TYPE registration_status AS ENUM ('active','withdrawn','removed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE registrations
  ADD COLUMN IF NOT EXISTS status registration_status NOT NULL DEFAULT 'active';

-- Every existing row is active by definition: migration 040 deleted the stuck
-- pending registrations, and nothing has written a non-paid row since.

CREATE INDEX IF NOT EXISTS idx_registrations_comp_status
  ON registrations (competition_id, status);
