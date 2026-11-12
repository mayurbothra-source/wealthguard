-- 010: one active engine signal per instrument.
-- The scoring engine only deactivated signals from the last 8 days, so older
-- ones stayed "active" for ever (up to 4 per instrument, 380 in total on
-- 12 Nov 2026). The engine now deactivates all of them; this cleans up the
-- rows left behind. Deactivated signals are still measured by the track record.

with ranked as (
  select id, row_number() over (partition by instrument_name order by generated_at desc, id desc) as rn
  from recommendations
  where client_id is null and instrument_id is null and is_active = true
)
update recommendations r set is_active = false
from ranked where r.id = ranked.id and ranked.rn > 1;

-- Check: should return 0 rows.
select instrument_name, count(*) from recommendations
where client_id is null and instrument_id is null and is_active = true
group by 1 having count(*) > 1;
