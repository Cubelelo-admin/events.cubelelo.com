-- Verification Phase 1 schema additions

-- 1. Round: add video_required flag (per-round toggle for §3/§6)
ALTER TABLE rounds ADD COLUMN IF NOT EXISTS video_required boolean NOT NULL DEFAULT false;

-- 2. Results: add flag_reasons jsonb for structured flag data (§6)
ALTER TABLE results ADD COLUMN IF NOT EXISTS flag_reasons jsonb NOT NULL DEFAULT '[]';

-- 3. Audit log: add old_value / new_value for verification audit trail (§10)
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS old_value text;
ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS new_value text;

-- 4. Index for audit log target lookups (§10: pull full history for a single result)
CREATE INDEX IF NOT EXISTS idx_audit_log_target ON audit_log (target) WHERE target IS NOT NULL;
