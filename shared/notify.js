// Phone alerts through ntfy.sh (open source, no account): every borrower has a topic derived from
// their address, which they subscribe to in the ntfy app or web page. The keeper publishes there,
// so alerts arrive with the browser closed.
// ntfy.sh topics are public: anyone can read one and anyone can publish to it. So every alert is
// signed by whoever sent it, and readers recover the signer: the app marks which alerts really came
// from a Payung keeper, and the keeper's "already sent" check counts only its own signed alerts, so
// nobody can suppress an alert by posting its tag first. Alerts carry no links.
// EVM signers sign EIP-191 (tag sig-…). A Mezo Passport account is a Safe owned by a Bitcoin key, so
// it signs BIP-137 (tag btcsig-…): the reader recovers the Bitcoin owner and asks OrangeKit's factory
// which Safe that owner has; that Safe is the signer.
import { getAddress, parseAbi, recoverMessageAddress } from 'viem'
import { bitcoinOwner } from './btc.js'

const ORANGEKIT_FACTORY = '0x7E80bd5A2E8Fca0B160254D43aC9f43AC2cC1052'
const factoryAbi = parseAbi(['function predictAddresses(bytes20) view returns (address safe, address owner)'])

export const NTFY = 'https://ntfy.sh'
// Tests use their own namespace: NTFY_PREFIX for the keeper, VITE_NTFY_PREFIX for an app build.
const PREFIX = globalThis.process?.env?.NTFY_PREFIX ?? import.meta.env?.VITE_NTFY_PREFIX ?? 'payung-'
// Keepers whose alerts the app vouches for: the GitHub Actions keeper and the team's own.
export const KEEPERS = ['0x4FF8d702D8CC8c106BB1C7C6Bf56459DE4300d9D', '0xe42F6c4b72577CE2A64D583CF2f33a2D729c9C81']

export const topicFor = (address, prefix = PREFIX) => `${prefix}${address.toLowerCase().slice(2)}`
const signed = (topic, { tag, title, message }) => `Payung alert\ntopic: ${topic}\ntag: ${tag}\ntitle: ${title}\nmessage: ${message}`

/** Publish one alert, signed by `signer` (a viem account, or anything with signMessage({ message });
 *  `signer.bitcoin` marks a Bitcoin wallet, whose BIP-137 signature goes in a btcsig- tag).
 *  `tag` names the event (e.g. paid-<vault>-<id>); `priority` is ntfy's 1–5 (5 rings through Do Not Disturb on Android). */
export async function notify(address, { title, message, tag, priority }, signer) {
  const topic = topicFor(address)
  const signature = await signer.signMessage({ message: signed(topic, { tag, title, message }) })
  const sigTag = `${signer.bitcoin ? 'btcsig' : 'sig'}-${signature}`
  const res = await fetch(NTFY, { method: 'POST', body: JSON.stringify({ topic, title, message, priority, tags: ['umbrella', tag, sigTag] }), signal: AbortSignal.timeout(10_000) }) // a slow ntfy must not delay triggers
  if (!res.ok) throw new Error(`ntfy ${res.status}: ${await res.text()}`)
}

/** What ntfy.sh holds for this address (12-hour cache), newest first, each with the address that
 *  signed it, or null when unsigned or forged. Bitcoin-signed alerts need `client` (a viem public
 *  client on Mezo) to find the signer's Mezo Passport account; without one their signer is null. */
export async function readAlerts(address, prefix, client) {
  const topic = topicFor(address, prefix)
  const text = await fetch(`${NTFY}/${topic}/json?poll=1&since=12h`, { signal: AbortSignal.timeout(10_000) }).then((r) => r.text())
  const alerts = await Promise.all(text.split('\n').filter(Boolean).map(async (line) => {
    const m = JSON.parse(line)
    const tag = m.tags?.find((t) => t !== 'umbrella' && !t.startsWith('sig-') && !t.startsWith('btcsig-'))
    const text = signed(topic, { tag, title: m.title, message: m.message })
    const signature = m.tags?.find((t) => t.startsWith('sig-'))?.slice(4)
    const btcSignature = m.tags?.find((t) => t.startsWith('btcsig-'))?.slice(7)
    let signer = null
    if (signature) signer = await recoverMessageAddress({ message: text, signature }).catch(() => null)
    else if (btcSignature && client) {
      const owner = bitcoinOwner(text, btcSignature)
      if (owner) signer = await client.readContract({ address: ORANGEKIT_FACTORY, abi: factoryAbi, functionName: 'predictAddresses', args: [owner] }).then(([safe]) => getAddress(safe), () => null)
    }
    return { id: m.id, time: m.time, title: m.title, message: m.message, priority: m.priority ?? 3, tag, signer }
  }))
  return alerts.reverse()
}
