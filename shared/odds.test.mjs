import { test } from 'node:test'
import assert from 'node:assert/strict'
import { touchChance, touchRate } from './odds.js'

test('touchChance: reflection principle on a lognormal path', () => {
  // ln(0.9) / (0.5 * sqrt(1/52)) = -1.5195 -> 2 * N(-1.5195) = 0.1287
  assert.ok(Math.abs(touchChance(0.1, 0.5, 31_536_000 / 52) - 0.1287) < 0.001)
  assert.ok(touchChance(0.1, 0.5, 2 * 604800) > touchChance(0.1, 0.5, 604800)) // more time, likelier
  assert.ok(touchChance(0.2, 0.5, 604800) < touchChance(0.1, 0.5, 604800)) // further away, less likely
  assert.equal(touchChance(0.1, 0.5, 0), 0)
  assert.equal(touchChance(0, 0.5, 604800), 1)
})

test('touchRate: counts windows whose path fell far enough, only windows that fit', () => {
  const h = [100, 99, 95, 101, 100, 92, 100].map((p, i) => ({ t: i * 10, p }))
  // 20-second windows start at t = 0..40 (5 of them). A 5% fall: from 100 at t=0 (95 at t=20),
  // from 101 at t=30 (92 at t=50), from 100 at t=40 (92 at t=50). Not from 99 (95 is 4.0% down) or 95.
  assert.deepEqual(touchRate(h, 0.05, 20), { hits: 3, windows: 5 })
  assert.deepEqual(touchRate(h, 0.5, 20), { hits: 0, windows: 5 })
  assert.deepEqual(touchRate(h, 0.05, 1000), { hits: 0, windows: 0 }) // no window that long fits
})
