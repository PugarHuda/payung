// Live checks against ntfy.sh, in a throwaway namespace. Topics are public, so what matters is who
// signed an alert: the keeper's own alerts are recognised, a forged or unsigned one is not.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

process.env.NTFY_PREFIX = `payung-test-${Date.now().toString(36)}-`
const { NTFY, notify, readAlerts, topicFor } = await import('./notify.js')
const holder = '0xE42F6c4b72577CE2A64D583CF2f33a2D729c9C81'
const keeper = privateKeyToAccount(generatePrivateKey())
const intruder = privateKeyToAccount(generatePrivateKey())

// ntfy.sh's cache shows a new message within a second or two: poll until all `n` are there.
async function settled(n) {
  for (let i = 0; i < 20; i++, await new Promise((r) => setTimeout(r, 500))) {
    const alerts = await readAlerts(holder)
    if (alerts.length >= n) return alerts
  }
  throw new Error(`ntfy.sh never showed ${n} alerts`)
}

test('topic is the prefix plus the lowercased address, within ntfy limits', () => {
  assert.equal(topicFor(holder), `${process.env.NTFY_PREFIX}e42f6c4b72577ce2a64d583cf2f33a2d729c9c81`)
  assert.match(topicFor(holder), /^[-_A-Za-z0-9]{1,64}$/)
})

test('a signed alert reads back with its signer; unsigned and tampered ones do not', async () => {
  assert.equal((await readAlerts(holder)).length, 0)
  await notify(holder, { title: 'BTC near', message: 'within 3%', tag: 'near-0xvault-7' }, keeper)
  // Someone else posts the same tag with no signature, and a copy of the keeper's signature on altered text.
  await settled(1)
  const sig = (await fetch(`${NTFY}/${topicFor(holder)}/json?poll=1`).then((r) => r.text())).match(/sig-0x[0-9a-f]+/)[0]
  await fetch(NTFY, { method: 'POST', body: JSON.stringify({ topic: topicFor(holder), title: 'BTC near', message: 'within 3%', tags: ['umbrella', 'paid-0xvault-7'] }) })
  await fetch(NTFY, { method: 'POST', body: JSON.stringify({ topic: topicFor(holder), title: 'Claim your payout', message: 'Sign here', tags: ['umbrella', 'near-0xvault-7', sig] }) })
  await notify(holder, { title: 'Payung', message: 'fake', tag: 'paid-0xvault-8' }, intruder)

  const alerts = await settled(4)
  assert.equal(alerts.length, 4)
  const fromKeeper = alerts.filter((a) => a.signer === keeper.address)
  assert.deepEqual(fromKeeper.map((a) => [a.tag, a.title]), [['near-0xvault-7', 'BTC near']])
  assert.equal(alerts.find((a) => a.title === 'Claim your payout').signer === keeper.address, false) // replayed signature, new text
  assert.equal(alerts.find((a) => a.tag === 'paid-0xvault-7').signer, null) // unsigned
  assert.equal(alerts.find((a) => a.tag === 'paid-0xvault-8').signer, intruder.address) // signed, but not by a keeper
})
