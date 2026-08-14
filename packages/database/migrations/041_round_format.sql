-- 041_round_format.sql
--
-- WCA scopes the round format, the cutoff and the time limit per ROUND
-- (Regulations 9b, 9g). Until now the format was inferred from the event type by
-- a hardcoded set in the results route, and cutoff/time limit lived on
-- competition_events. That made a combined first round followed by an
-- uncombined final impossible to express, and it silently broke submission for
-- every 3-attempt event.
--
-- format is the official WCA code: 1=Bo1, 2=Bo2, 3=Bo3, a=Ao5, m=Mo3.
-- cutoff_ms / time_limit_ms are nullable; a round with NULL inherits the
-- competition_event value it was created from.

alter table rounds add column if not exists format        text    not null default 'a';
alter table rounds add column if not exists cutoff_ms     integer;
alter table rounds add column if not exists time_limit_ms integer;

alter table rounds drop constraint if exists rounds_format_check;
alter table rounds add constraint rounds_format_check
  check (format in ('1', '2', '3', 'a', 'm'));

-- Backfill from the event type of each round's competition_event, matching the
-- WCA event table. Blindfolded events are Best-of-3, not Mean-of-3.
update rounds r
set format = case ce.event_type
  when '666'    then 'm'
  when '777'    then 'm'
  when '333fm'  then 'm'
  when '333bf'  then '3'
  when '444bf'  then '3'
  when '555bf'  then '3'
  when '333mbf' then '3'
  else 'a'
end
from competition_events ce
where ce.id = r.competition_event_id;

-- Inherit the existing event-level cutoff / time limit so current rounds keep
-- behaving the same. The event columns stay as the default for new rounds.
update rounds r
set cutoff_ms     = ce.cutoff_ms,
    time_limit_ms = ce.time_limit_ms
from competition_events ce
where ce.id = r.competition_event_id
  and (ce.cutoff_ms is not null or ce.time_limit_ms is not null);
