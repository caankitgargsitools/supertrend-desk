# Find Love — finding abandoned and lost children

**Status: scaffold only (6 Nov 2026).** The purpose and the first screens are set up here; the detail (who reports,
who verifies, how matching works, what the authorities' flow is) is to be decided with Papa before anything is built out.

## Purpose
Help reunite lost children with their families, and get abandoned children to the right care, quickly:
1. **Lost** — a parent or guardian reports a missing child (description, last seen where and when, photo).
2. **Found** — a volunteer, shelter, police post or railway staff reports a child found alone (description, where, when,
   where the child is now).
3. **Match** — the system puts likely pairs side by side (age, sex, place, time, marks, clothes) for a human to check.
4. **Hand over** — every case is pointed to the official channels, never handled alone by the app.

## Principles (standing, child safety first)
- **Authorities first.** India: Childline **1098** (24x7), the nearest police station (an FIR for a missing child is
  compulsory, Supreme Court 2013), the Child Welfare Committee (CWC) of the district, and the government's
  **TrackChild / Khoya-Paya** portal. The app records and matches; it does not replace any of these, and every case
  screen shows them.
- **A child's data is never public.** Photos, names and places are visible only to the reporter, verified volunteers
  and administrators (row-level security, private storage bucket, signed links that expire). No public search page,
  no sharing links, no social-media posting from the app. Search engines are kept out (noindex, as on the desk).
- **Humans decide matches.** The code only ranks candidates. A match becomes "confirmed" only when a verified person
  marks it so after speaking with the reporter and the authorities.
- **No AI on children's faces or data without a decision.** Face matching, AI summaries and any paid service follow the
  owner's rule (free → cheapest → costlier, log every call) and need Papa's go first. Free AI tiers may train on inputs,
  so nothing from a case ever goes to one.
- **Nothing is deleted.** Cases close (reunited / handed over / withdrawn / duplicate); rows are hidden, never removed.
- **Verified reporters.** Anyone can sign up; a report is live for matching only after a phone/OTP check, and
  volunteers are approved by an administrator.
- **Audit.** Every change to a case is written to `case_events` (who, when, what).

## Layout
- `index.html` — the whole web app (static, no build; same look and CSS variables as the desk). Served by Vercel at
  `/findlove` from the same deployment. For now it shows the screens with sample data and no backend calls.
- `supabase/migrations/001_findlove_init.sql` — **draft, not applied.** Schema `findlove`: `reporters`, `cases`,
  `case_photos`, `sightings`, `matches`, `case_events`; row-level security; `find_candidates(case_id)`.
- `supabase/functions/findlove/index.ts` — edge function skeleton (actions `health`, `match`); `match.ts` is the pure
  scoring (no database), used by the test.
- `tests/match.test.mjs` — Node test of the scoring: `cd findlove/tests && node build.mjs && node match.test.mjs`
  (uses esbuild from `tests/sim/node_modules`; run `cd tests/sim && npm install` once).

## Open for Papa to decide
1. Who may report and who verifies (NGO partners? police logins? only our volunteers?).
2. Where it runs: the desk's Supabase project (one login, lower cost) or a separate project (cleaner separation of a
   child's data from trading data — recommended).
3. Photos: store at all? If yes, retention period and who can see them.
4. Languages: Hindi + English first?
5. Matching inputs: description only (free) first; face matching later only with a decision.
6. Phone alerts to volunteers near a found child (needs location sharing — opt-in only).
