-- Migration 048: payments.competition_id → ON DELETE SET NULL
--
-- Deleting a draft/cancelled competition failed with a foreign-key violation
-- (surfaced to the client as "Delete failed: 500"). The competition delete
-- relies on database cascade, and every child FK cascades except one:
--
--   040_payment_intent.sql added `payments.competition_id REFERENCES
--   competitions(id)` with no ON DELETE action (defaults to RESTRICT), and the
--   same migration made `payments.registration_id` nullable. A payment intent
--   with a NULL registration_id is not reached by the registrations cascade, so
--   its competition_id FK blocked the delete.
--
-- Fix: keep the payment row (financial history must survive a competition
-- delete) and just unlink the removed competition. competition_id is nullable,
-- so SET NULL is safe.

ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_competition_id_fkey;
ALTER TABLE payments
  ADD CONSTRAINT payments_competition_id_fkey
  FOREIGN KEY (competition_id) REFERENCES competitions(id) ON DELETE SET NULL;
