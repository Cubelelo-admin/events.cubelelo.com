-- 042_result_judge_overrides.sql
--
-- A judge's +2 or DNF applies to a single ATTEMPT (WCA Regulation 10f / A6), not
-- to the whole result. The previous model stored only a result-level flag_status
-- and faked the consequences arithmetically — adding a flat 2000 ms to the
-- single, the average, the mean and the median all at once, and nulling every
-- stat for a DNF. Neither matches the regulations: a +2 on one attempt moves an
-- Ao5 by 0.667 s (or not at all, if that attempt is trimmed), and one DNF does
-- not void the other four attempts.
--
-- judge_overrides is an array parallel to solves_json: one entry per attempt,
-- null where the judge made no change. Raw solves are never mutated, so clearing
-- the overrides (a "verified" verdict) restores the competitor's original stats.

alter table results add column if not exists judge_overrides jsonb;

comment on column results.judge_overrides is
  'Per-attempt judge penalty overrides, parallel to solves_json. Entries are ''plus2'', ''dnf'' or null.';
