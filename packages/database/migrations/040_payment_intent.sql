-- Migration 040: Payment-first registration flow
-- Store checkout intent on payment so registration is created only after payment succeeds.

-- 1. Make registration_id nullable (payment is created before registration now)
ALTER TABLE payments ALTER COLUMN registration_id DROP NOT NULL;

-- 2. Add intent columns so verify/webhook can create the registration
ALTER TABLE payments ADD COLUMN IF NOT EXISTS competition_id uuid REFERENCES competitions(id);
ALTER TABLE payments ADD COLUMN IF NOT EXISTS event_ids text; -- comma-separated competition_event ids
ALTER TABLE payments ADD COLUMN IF NOT EXISTS promo_code_id uuid REFERENCES promo_codes(id);

-- 3. Backfill competition_id from existing registrations
UPDATE payments p
SET competition_id = r.competition_id
FROM registrations r
WHERE p.registration_id = r.id
  AND p.competition_id IS NULL;

-- 4. Clean up orphaned pending registrations (no paid payment)
-- These are the stuck records the new flow prevents.
DELETE FROM registration_events
WHERE registration_id IN (
  SELECT id FROM registrations WHERE payment_status = 'pending'
);
DELETE FROM registrations WHERE payment_status = 'pending';
