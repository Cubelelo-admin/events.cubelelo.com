-- 044_competition_rule_sets.sql
--
-- A competition can use several rule sets, not one.
--
-- `competitions.rule_set_id` (migration 036) was a single FK, so the admin UI
-- worked around it by concatenating the selected sets' markdown into `rules_md`
-- and never recording which sets were chosen. Reloading the form then tried to
-- reverse-match rule sets by comparing markdown, which broke as soon as anyone
-- edited the text.
--
-- This stores the association properly. `rules_md` goes back to meaning only the
-- admin's own additional text; the rule sets' content is resolved at read time,
-- so editing a rule set updates every competition using it.
--
-- `position` preserves the order the admin picked, since rules read as a
-- sequence.

create table if not exists competition_rule_sets (
  competition_id uuid not null references competitions(id) on delete cascade,
  rule_set_id    uuid not null references rule_sets(id)    on delete cascade,
  position       integer not null default 0,
  primary key (competition_id, rule_set_id)
);

create index if not exists competition_rule_sets_competition_idx
  on competition_rule_sets (competition_id, position);

-- Carry over the existing single association so nothing is lost.
insert into competition_rule_sets (competition_id, rule_set_id, position)
select id, rule_set_id, 0
from competitions
where rule_set_id is not null
on conflict do nothing;

-- competitions.rule_set_id is deliberately left in place. It is no longer read
-- or written, but keeping it means a rollback to the previous build still works.
