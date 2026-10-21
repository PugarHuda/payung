// Phone alerts through ntfy.sh (open source, no account): every borrower has a topic derived from
// their address, which they subscribe to in the ntfy app or web page. The keeper publishes there,
// so alerts arrive with the browser closed.
// ntfy.sh topics are public: anyone can read one and anyone can publish to it. So every alert is
// signed (EIP-191) by whoever sent it, and readers recover the signer: the app marks which alerts
// really came from a Payung keeper, and the keeper's "already sent" check counts only its own
// signed alerts, so nobody can suppress an alert by posting its tag first. Alerts carry no links.
import { recoverMessageAddress } from 'viem'

export const NTFY = 'https://ntfy.sh'
// Tests use their own namespace: NTFY_PREFIX for the keeper, VITE_NTFY_PREFIX for an app build.
const PREFIX = globalThis.process?.env?.NTFY_PREFIX ?? import.meta.env?.VITE_NTFY_PREFIX ?? 'payung-'
// Keepers whose alerts the app vouches for: the GitHub Actions keeper and the team's own.
export const KEEPERS = ['0x4FF8d702D8CC8c106BB1C7C6Bf56459DE4300d9D', '0xe42F6c4b72577CE2A64D583CF2f33a2D729c9C81']

export const topicFor = (address, prefix = PREFIX) => `${prefix}${address.toLowerCase().slice(2)}`
const signed = (topic, { tag, title, message }) => `Payung alert\ntopic: ${topic}\ntag: ${tag}\ntitle: ${title}\nmessage: ${message}`

/** Publish one alert, signed by `signer` (a viem account, or anything with signMessage({ message })).
 *  `tag` names the event (e.g. paid-<vault>-<id>). */
export async function notify(address, { title, message, tag }, signer) {
  const topic = topicFor(address)
  const signature = await signer.signMessage({ message: signed(topic, { tag, title, message }) })
  const res = await fetch(NTFY, { method: 'POST', body: JSON.stringify({ topic, title, message, tags: ['umbrella', tag, `sig-${signature}`] }) })
  if (!res.ok) throw new Error(`ntfy ${res.status}: ${await res.text()}`)
}

/** What ntfy.sh holds for this address (12-hour cache), newest first, each with the address that
 *  signed it, or null when unsigned or forged. */
export async function readAlerts(address, prefix) {
  const topic = topicFor(address, prefix)
  const text = await fetch(`${NTFY}/${topic}/json?poll=1&since=12h`).then((r) => r.text())
  const alerts = await Promise.all(text.split('\n').filter(Boolean).map(async (line) => {
    const m = JSON.parse(line)
    const tag = m.tags?.find((t) => t !== 'umbrella' && !t.startsWith('sig-'))
    const signature = m.tags?.find((t) => t.startsWith('sig-'))?.slice(4)
    const signer = signature
      ? await recoverMessageAddress({ message: signed(topic, { tag, title: m.title, message: m.message }), signature }).catch(() => null)
      : null
    return { id: m.id, time: m.time, title: m.title, message: m.message, tag, signer }
  }))
  return alerts.reverse()
}
