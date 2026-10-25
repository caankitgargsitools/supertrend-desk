-- Ideas lab, option selling built (25 Oct 2026): its 8 settings, registered earlier as "later", get their exact
-- definitions (before any result is seen) and join the queue. ideas_lease_until keeps two instalments (the schedule
-- and a chained call, used for the short option-pricing slices) from working at once.
alter table public.lab_settings add column if not exists ideas_lease_until timestamptz;

update public.idea_tries t set status = 'planned', label = v.label, setting = v.setting
from (values
  ('ic-1sd', 'Iron condor: sell the call and put about 1 standard deviation of the week''s move out, buy wings 2 strikes further', '{"form":"ic","sd":1,"w":2,"stop":0}'::jsonb),
  ('ic-1.5sd', 'Iron condor, short strikes 1.5 SD out, wings 2 strikes further', '{"form":"ic","sd":1.5,"w":2,"stop":0}'),
  ('strangle-hedged-1sd', 'Hedged strangle: short strikes 1 SD out, protection 4 strikes further', '{"form":"ic","sd":1,"w":4,"stop":0}'),
  ('strangle-hedged-1.5sd', 'Hedged strangle: short strikes 1.5 SD out, protection 4 strikes further', '{"form":"ic","sd":1.5,"w":4,"stop":0}'),
  ('ic-1sd-sl', 'Iron condor 1 SD, out early when Nifty touches a short strike', '{"form":"ic","sd":1,"w":2,"stop":1}'),
  ('ic-1.5sd-sl', 'Iron condor 1.5 SD, out early when Nifty touches a short strike', '{"form":"ic","sd":1.5,"w":2,"stop":1}'),
  ('bull-put', 'Bull put spread: sell a put 1 SD below, buy one 2 strikes lower', '{"form":"bps","sd":1,"w":2,"stop":0}'),
  ('bear-call', 'Bear call spread: sell a call 1 SD above, buy one 2 strikes higher', '{"form":"bcs","sd":1,"w":2,"stop":0}')
) as v(setting_key, label, setting)
where t.idea = 'optsell' and t.status = 'later' and t.setting_key = v.setting_key;
