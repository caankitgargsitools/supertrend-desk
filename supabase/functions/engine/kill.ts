// Phase 3: the kill rule. A desk strategy's own trades are compared with what its backtest says it should do: 2,000
// random sets of the same number of backtest trades (drawn with replacement) give the range of normal results. Far below
// that range, new trades stop (exits still run) until Papa allows them again.
import { seeded } from "./noise.ts";

export const KILL_EARLY = { trades: 10, pct: 0.01 }, KILL_FULL = { trades: 20, pct: 0.05 };

/** desk / backtest: results per trade for one lot. Returns the verdict and the numbers behind it. */
export function killVerdict(desk: number[], backtest: number[], seed = 1) {
  const n = desk.length, real = desk.reduce((a, x) => a + x, 0);
  if (n < KILL_EARLY.trades || backtest.length < 10) return { n, real: Math.trunc(real), flag: false, p: null as number | null, p1: null as number | null, p5: null as number | null };
  const rnd = seeded(seed), sums: number[] = [];
  for (let k = 0; k < 2000; k++) { let s = 0; for (let i = 0; i < n; i++) s += backtest[Math.floor(rnd() * backtest.length)]; sums.push(s); }
  sums.sort((a, b) => a - b);
  const p1 = sums[Math.floor(sums.length * 0.01)], p5 = sums[Math.floor(sums.length * 0.05)];
  const p = sums.filter((x) => x <= real).length / sums.length;
  const flag = n >= KILL_FULL.trades ? p < KILL_FULL.pct : p < KILL_EARLY.pct;
  return { n, real: Math.trunc(real), flag, p: +p.toFixed(4), p1: Math.trunc(p1), p5: Math.trunc(p5) };
}
