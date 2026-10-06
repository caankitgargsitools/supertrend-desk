# CA Ankit Garg Trade Desk

Private control panel for Supertrend algo strategies (Dhan + Supabase).

- `index.html` – the whole website (static, no build step)
- `vendor/` – bundled Supabase and chart libraries
- Backend: Supabase project `umryzxusbdttbcshkajt` (engine + auth-setup edge functions, pg_cron every minute)

Deploy: import this repo in Vercel as a static site (Framework preset: Other, no build command, output directory = root).
