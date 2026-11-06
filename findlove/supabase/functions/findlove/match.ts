// Find Love · pure matching rules (no database, no network). Same scoring as findlove.find_candidates in SQL.
// A score is 0..100 made of four parts: sex 30, age 25, distance 25, time 20. Humans decide; this only ranks.

export type Kind = "lost" | "found";
export interface CaseLite {
  id: number; kind: Kind;
  sex?: "M" | "F" | "U" | null;
  age_years?: number | null; age_tol?: number | null;   // best estimate ± years
  lat?: number | null; lon?: number | null;
  at: string | Date;                                     // last seen (lost) / found at (found)
}
export interface Candidate { case_id: number; score: number; km: number | null; days: number; reasons: string[] }

export const MAX_KM = 200;        // 25 points fall to 0 over this distance
export const MAX_DAYS = 90;       // 20 points fall to 0 over this gap

export function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const r = Math.PI / 180, R = 6371;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lon2 - lon1) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

export function scorePair(lost: CaseLite, found: CaseLite): Candidate {
  const reasons: string[] = [];
  // sex
  let s = 0;
  if (!lost.sex || !found.sex || lost.sex === "U" || found.sex === "U") { s += 15; reasons.push("sex unknown on one side"); }
  else if (lost.sex === found.sex) { s += 30; reasons.push("same sex"); }
  else reasons.push("different sex");
  // age
  if (lost.age_years == null || found.age_years == null) { s += 10; reasons.push("age unknown on one side"); }
  else {
    const tol = Math.max(lost.age_tol ?? 1, found.age_tol ?? 1, 0.5);
    const d = Math.abs(lost.age_years - found.age_years);
    const pts = Math.max(0, 25 - (10 * d) / tol);
    s += pts; reasons.push(d <= tol ? `age within ±${tol} yr` : `age differs by ${d.toFixed(1)} yr`);
  }
  // distance
  let km: number | null = null;
  if (lost.lat == null || lost.lon == null || found.lat == null || found.lon == null) { s += 10; reasons.push("place not located"); }
  else {
    km = haversineKm(lost.lat, lost.lon, found.lat, found.lon);
    s += Math.max(0, 25 - (25 * km) / MAX_KM); reasons.push(`${km.toFixed(1)} km apart`);
  }
  // time: a child can't be found before it was lost
  const days = (new Date(found.at).getTime() - new Date(lost.at).getTime()) / 86400000;
  if (days < 0) reasons.push("found before lost");
  else { s += Math.max(0, 20 - (20 * days) / MAX_DAYS); reasons.push(`${days.toFixed(1)} days after`); }
  return { case_id: found.id, score: Math.round(s * 100) / 100, km: km == null ? null : Math.round(km * 10) / 10, days: Math.round(days * 10) / 10, reasons };
}

/** Rank the other kind's open cases against `me`, best first. */
export function findCandidates(me: CaseLite, others: CaseLite[], limit = 20): Candidate[] {
  const out: Candidate[] = [];
  for (const o of others) {
    if (o.kind === me.kind) continue;
    const c = me.kind === "lost" ? scorePair(me, o) : scorePair(o, me);
    out.push({ ...c, case_id: o.id });
  }
  return out.sort((a, b) => b.score - a.score).slice(0, limit);
}
