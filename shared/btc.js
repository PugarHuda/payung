// Bitcoin signed messages (BIP-137), as Unisat, OKX and Xverse sign them: who signed, as the
// 20-byte owner hash OrangeKit's factory derives a Mezo Passport account (Safe) from.
import { secp256k1 } from '@noble/curves/secp256k1.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { ripemd160 } from '@noble/hashes/legacy.js'
import { bytesToHex, hexToBytes } from 'viem'

const MAGIC = new TextEncoder().encode('\x18Bitcoin Signed Message:\n')
const varint = (n) => (n < 0xfd ? Uint8Array.of(n) : Uint8Array.of(0xfd, n & 0xff, n >> 8))
const concat = (...a) => Uint8Array.from(a.flatMap((x) => [...x]))
const hash160 = (b) => ripemd160(sha256(b))

/** Bitcoin's signed-message hash: sha256d(magic || varint(len) || message). */
export function messageHash(message) {
  const m = new TextEncoder().encode(message)
  return sha256(sha256(concat(MAGIC, varint(m.length), m)))
}

/** The OrangeKit owner (bytes20 hex) behind a 65-byte BIP-137 signature (hex) of `message`, or null.
 *  Header 27-34: P2PKH (31+ compressed), 35-38: P2SH-P2WPKH, 39-42: P2WPKH. For P2PKH and P2WPKH the
 *  owner is hash160(public key); for nested SegWit it is the hash of its redeem script. */
export function bitcoinOwner(message, signature) {
  try {
    const sig = hexToBytes(signature)
    if (sig.length !== 65 || sig[0] < 31 || sig[0] > 42) return null // uncompressed keys can't own a Passport account
    const point = secp256k1.Signature.fromCompact(sig.subarray(1)).addRecoveryBit((sig[0] - 27) & 3).recoverPublicKey(messageHash(message))
    const keyHash = hash160(point.toRawBytes(true))
    return bytesToHex(sig[0] >= 35 && sig[0] <= 38 ? hash160(concat([0x00, 0x14], keyHash)) : keyHash)
  } catch {
    return null
  }
}
