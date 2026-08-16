-- Migration 047: Close three enum gaps, and the promo redemption bypass.
--
-- The code has been writing values these enums do not accept. The test suite
-- never caught it because it runs on the in-memory repository, which has no
-- enums to violate — see apps/api/test/enum-parity.test.ts, which now reads
-- these files and fails if a TypeScript union drifts from its enum again.
--
-- ALTER TYPE ... ADD VALUE cannot run inside a transaction block in older
-- Postgres, so each statement stands alone.

-- 1. `super_admin` — checked in ~15 places and offered as an assignable role in
--    the admin user editor, but never a valid value.
ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'super_admin';

-- 2. `deleted` — written by both user self-delete and admin delete.
ALTER TYPE account_stage ADD VALUE IF NOT EXISTS 'deleted';

-- 3. `plus2` / `dnf` as a *result verdict*. These also exist in solve_penalty,
--    which is a different thing: that one is the competitor's own penalty on a
--    single solve, this is the judge's verdict on a whole result. Every judge
--    verdict of +2 or DNF was failing here.
ALTER TYPE flag_status ADD VALUE IF NOT EXISTS 'plus2';
ALTER TYPE flag_status ADD VALUE IF NOT EXISTS 'dnf';

-- 4. Per-user promo redemptions were capped at one row by this constraint, and
--    the insert swallowed the conflict — so the usage count stuck at 1 and a
--    code with max_uses_per_user > 1 could be redeemed without limit. Counting
--    redemptions requires one row per redemption.
ALTER TABLE promo_code_usages DROP CONSTRAINT IF EXISTS promo_code_usages_promo_code_id_user_id_key;

CREATE INDEX IF NOT EXISTS idx_promo_code_usages_code_user
  ON promo_code_usages (promo_code_id, user_id);
