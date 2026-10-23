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
  await notify(holder, { title: 'BTC near', message: 'within 3%', tag: 'near-0xvault-7', priority: 5 }, keeper)
  // Someone else posts the same tag with no signature, and a copy of the keeper's signature on altered text.
  await settled(1)
  const sig = (await fetch(`${NTFY}/${topicFor(holder)}/json?poll=1`).then((r) => r.text())).match(/sig-0x[0-9a-f]+/)[0]
  await fetch(NTFY, { method: 'POST', body: JSON.stringify({ topic: topicFor(holder), title: 'BTC near', message: 'within 3%', tags: ['umbrella', 'paid-0xvault-7'] }) })
  await fetch(NTFY, { method: 'POST', body: JSON.stringify({ topic: topicFor(holder), title: 'Claim your payout', message: 'Sign here', tags: ['umbrella', 'near-0xvault-7', sig] }) })
  await notify(holder, { title: 'Payung', message: 'fake', tag: 'paid-0xvault-8' }, intruder)

  const alerts = await settled(4)
  assert.equal(alerts.length, 4)
  const fromKeeper = alerts.filter((a) => a.signer === keeper.address)
  assert.deepEqual(fromKeeper.map((a) => [a.tag, a.title, a.priority]), [['near-0xvault-7', 'BTC near', 5]])
  assert.equal(alerts.find((a) => a.tag === 'paid-0xvault-8').priority, 3) // ntfy's default
  assert.equal(alerts.find((a) => a.title === 'Claim your payout').signer === keeper.address, false) // replayed signature, new text
  assert.equal(alerts.find((a) => a.tag === 'paid-0xvault-7').signer, null) // unsigned
  assert.equal(alerts.find((a) => a.tag === 'paid-0xvault-8').signer, intruder.address) // signed, but not by a keeper
})

test('a Bitcoin wallet signs alerts in BIP-137; readers trace it to its Mezo Passport account', async () => {
  const { createPublicClient, http, parseAbi, getAddress } = await import('viem')
  const { mezoTestnet } = await import('./mezo.js')
  const { btcKey } = await import('../e2e/btcwallet.mjs')
  const { bitcoinOwner } = await import('./btc.js')
  const client = createPublicClient({ chain: mezoTestnet, transport: http(undefined, { timeout: 60_000 }) })
  const key = btcKey()
  const other = btcKey()
  // OrangeKit wallets sign with the Bitcoin key and hand back the 65-byte signature as hex.
  const asWallet = (k) => ({ bitcoin: true, signMessage: ({ message }) => '0x' + Buffer.from(k.signMessage(message), 'base64').toString('hex') })
  const safeOf = async (k) => {
    const owner = bitcoinOwner('x', asWallet(k).signMessage({ message: 'x' }))
    const [safe] = await client.readContract({ address: '0x7E80bd5A2E8Fca0B160254D43aC9f43AC2cC1052', abi: parseAbi(['function predictAddresses(bytes20) view returns (address, address)']), functionName: 'predictAddresses', args: [owner] })
    return getAddress(safe)
  }
  const account = await safeOf(key)
  await notify(account, { title: 'Payung test alert', message: 'from the account owner', tag: 'test' }, asWallet(key))
  await notify(account, { title: 'Payung test alert', message: 'from someone else', tag: 'test' }, asWallet(other))
  // Tampered: a genuine owner signature moved onto different text.
  const real = asWallet(key).signMessage({ message: 'something else' })
  await fetch(NTFY, { method: 'POST', body: JSON.stringify({ topic: topicFor(account), title: 'Payung test alert', message: 'tampered', tags: ['umbrella', 'test', `btcsig-${real}`] }) })
  let alerts = []
  for (let i = 0; i < 20 && alerts.length < 3; i++, await new Promise((r) => setTimeout(r, 500))) alerts = await readAlerts(account, undefined, client)
  const by = (message) => alerts.find((a) => a.message === message)?.signer
  assert.equal(by('from the account owner'), account)
  assert.notEqual(by('from someone else'), account)
  assert.equal(by('from someone else'), await safeOf(other))
  assert.notEqual(by('tampered'), account)
  // Without a Mezo client the Bitcoin signer can't be traced, so it isn't vouched for.
  assert.equal((await readAlerts(account)).find((a) => a.message === 'from the account owner').signer, null)
})
