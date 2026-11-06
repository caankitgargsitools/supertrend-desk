// Find Love · matching rules. Run: node build.mjs && node match.test.mjs
import assert from "node:assert/strict";
import { scorePair, findCandidates, haversineKm } from "./match.mjs";

const T = (d) => new Date(d).toISOString();
const lost = { id: 1, kind: "lost", sex: "M", age_years: 6, age_tol: 1, lat: 28.6139, lon: 77.209, at: T("2026-11-01T10:00:00Z") }; // Delhi
let n = 0;
const ok = (name, f) => { f(); n++; console.log("ok", name); };

ok("same place, same day, same sex and age → near 100", () => {
  const found = { ...lost, id: 2, kind: "found", at: T("2026-11-01T18:00:00Z") };
  const c = scorePair(lost, found);
  assert.ok(c.score > 99 && c.score <= 100, String(c.score));
  assert.equal(c.km, 0);
});

ok("found before lost gets no time points and says so", () => {
  const found = { ...lost, id: 2, kind: "found", at: T("2026-10-30T10:00:00Z") };
  const c = scorePair(lost, found);
  assert.ok(c.reasons.includes("found before lost"));
  assert.ok(c.score <= 80);
});

ok("different sex loses the 30 sex points", () => {
  const found = { ...lost, id: 2, kind: "found", sex: "F", at: T("2026-11-01T18:00:00Z") };
  assert.ok(scorePair(lost, found).score < 71);
});

ok("unknown sex scores half", () => {
  const found = { ...lost, id: 2, kind: "found", sex: "U", at: T("2026-11-01T18:00:00Z") };
  const c = scorePair(lost, found);
  assert.ok(c.score > 84 && c.score < 86, String(c.score));
});

ok("age outside the tolerance costs points, 2.5× tolerance costs all 25", () => {
  const found = { ...lost, id: 2, kind: "found", age_years: 8.5, at: T("2026-11-01T18:00:00Z") };
  const c = scorePair(lost, found);
  assert.ok(c.score > 74.9 && c.score < 75.1, String(c.score));
});

ok("distance: Delhi → Mumbai (~1150 km) gives 0 of 25", () => {
  assert.ok(Math.abs(haversineKm(28.6139, 77.209, 19.076, 72.8777) - 1150) < 20);
  const found = { ...lost, id: 2, kind: "found", lat: 19.076, lon: 72.8777, at: T("2026-11-01T18:00:00Z") };
  const c = scorePair(lost, found);
  assert.ok(c.score > 74.9 && c.score < 75.1, String(c.score));
});

ok("findCandidates ranks found cases best first and skips same-kind rows", () => {
  const others = [
    { id: 10, kind: "found", sex: "M", age_years: 6, lat: 28.7, lon: 77.1, at: T("2026-11-02T10:00:00Z") },
    { id: 11, kind: "found", sex: "F", age_years: 12, lat: 13.08, lon: 80.27, at: T("2026-11-20T10:00:00Z") },
    { id: 12, kind: "lost", sex: "M", age_years: 6, lat: 28.6, lon: 77.2, at: T("2026-11-01T12:00:00Z") },
  ];
  const r = findCandidates(lost, others);
  assert.deepEqual(r.map((c) => c.case_id), [10, 11]);
  assert.ok(r[0].score > r[1].score);
});

ok("a found case ranks lost cases the same way (pair order kept)", () => {
  const found = { id: 2, kind: "found", sex: "M", age_years: 6, lat: 28.7, lon: 77.1, at: T("2026-11-02T10:00:00Z") };
  const r = findCandidates(found, [lost]);
  assert.equal(r.length, 1); assert.equal(r[0].case_id, 1); assert.ok(r[0].days > 0);
});

console.log(`${n} tests passed`);
