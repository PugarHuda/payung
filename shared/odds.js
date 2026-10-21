// How likely is a touch? Two independent reads: a model on Payung's on-chain volatility, and a
// backtest over BTC's real path on Mezo's oracle.

const YEAR = 31_536_000

// Abramowitz & Stegun 7.1.26, |error| < 1.5e-7
function erf(x) {
  const s = Math.sign(x)
  const a = Math.abs(x)
  const t = 1 / (1 + 0.3275911 * a)
  return s * (1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-a * a))
}
const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2))

/** Chance a driftless lognormal price falls `drop` (0.08 = 8%) below today at any time within
 *  `seconds` (reflection principle: twice the chance of ending there). */
export function touchChance(drop, vol, seconds) {
  if (drop <= 0) return 1
  if (seconds <= 0 || vol <= 0) return 0
  return Math.min(1, 2 * normCdf(Math.log(1 - drop) / (vol * Math.sqrt(seconds / YEAR))))
}

/** In how many past windows of `seconds` did the price fall `drop` or more below the window's
 *  start? `history` is [{ t, p }] in time order; every sample can start a window that fits. */
export function touchRate(history, drop, seconds) {
  let hits = 0
  let windows = 0
  const end = history.at(-1)?.t ?? 0
  for (let i = 0; i < history.length && history[i].t + seconds <= end; i++) {
    windows++
    const floor = history[i].p * (1 - drop)
    for (let j = i + 1; j < history.length && history[j].t <= history[i].t + seconds; j++) {
      if (history[j].p <= floor) {
        hits++
        break
      }
    }
  }
  return { hits, windows }
}
