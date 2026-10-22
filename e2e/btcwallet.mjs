// A real Bitcoin wallet for Playwright, shaped like Unisat's injected `window.unisat`: a secp256k1
// key held in Node that signs BIP-137 messages (what Unisat's signMessage returns), on a native
// SegWit (P2WPKH) testnet address. Mezo Passport's smart account checks these signatures on-chain,
// so transactions it relays for this wallet are real Mezo testnet transactions.
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { bech32 } from 'bech32'

const varint = (n) => (n < 0xfd ? Uint8Array.of(n) : Uint8Array.of(0xfd, n & 0xff, n >> 8))
const concat = (...a) => Uint8Array.from(a.flatMap((x) => [...x]))
const MAGIC = new TextEncoder().encode('\x18Bitcoin Signed Message:\n')

/** Bitcoin's signed-message hash: sha256d(magic || varint(len) || message). */
export function messageHash(message) {
  const m = new TextEncoder().encode(message)
  return sha256(sha256(concat(MAGIC, varint(m.length), m)))
}

export function btcKey(secret = secp256k1.utils.randomPrivateKey()) {
  const publicKey = secp256k1.getPublicKey(secret, true)
  const address = bech32.encode('tb', [0, ...bech32.toWords(ripemd160(sha256(publicKey)))])
  const hex = (b) => Buffer.from(b).toString('hex')
  return {
    address,
    publicKey: hex(publicKey),
    /** BIP-137, base64: header (31 + recovery: compressed key) || r || s, as Unisat returns it. */
    signMessage(message) {
      const sig = secp256k1.sign(messageHash(message), secret)
      return Buffer.from(concat([31 + sig.recovery], sig.toCompactRawBytes())).toString('base64')
    },
  }
}

/** Injects `window.unisat` into the page, answered by `key` in Node. Returns a log of requests. */
export async function installUnisat(page, key) {
  const log = []
  await page.exposeFunction('__unisat', async (method, arg) => {
    log.push(method)
    if (method === 'signMessage') return key.signMessage(arg)
    if (method === 'getPublicKey') return key.publicKey
    return [key.address] // requestAccounts, getAccounts
  })
  await page.addInitScript(() => {
    window.unisat = Object.fromEntries(['requestAccounts', 'getAccounts', 'getPublicKey', 'signMessage'].map((m) => [m, (arg) => window.__unisat(m, arg)]))
  })
  return log
}
