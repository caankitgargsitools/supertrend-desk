-- Ideas lab, crypto funding signal built (25 Oct 2026; Papa chose the unhedged version: Delta India has no spot coin
-- to hedge with). Its 6 settings, registered as "later", get their exact definitions before any result is seen.
-- Binance's free funding history is stored per coin as lab candles kind "FB" (by the engine, refreshed weekly).
update public.idea_tries t set status = 'planned', label = v.label, setting = v.setting
from (values
  ('f-0.01', 'Short when the previous day''s funding is above 0.01% per 8 hours, long when below −0.01%, otherwise out; all four coins', '{"th":0.01,"coins":"all"}'::jsonb),
  ('f-0.02', 'Funding beyond ±0.02% per 8 hours; all four coins', '{"th":0.02,"coins":"all"}'),
  ('f-0.03', 'Funding beyond ±0.03% per 8 hours; all four coins', '{"th":0.03,"coins":"all"}'),
  ('f-0.01-btc', 'Funding beyond ±0.01% per 8 hours; Bitcoin only', '{"th":0.01,"coins":"BTC"}'),
  ('f-0.02-btc', 'Funding beyond ±0.02%; Bitcoin only', '{"th":0.02,"coins":"BTC"}'),
  ('f-0.03-btc', 'Funding beyond ±0.03%; Bitcoin only', '{"th":0.03,"coins":"BTC"}')
) as v(setting_key, label, setting)
where t.idea = 'funding' and t.status = 'later' and t.setting_key = v.setting_key;
