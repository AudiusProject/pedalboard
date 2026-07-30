import { recoverPersonalSignature } from 'eth-sig-util'
import { OptionalId } from '@audius/sdk'
import { Config } from '../config'
import { Logger } from '../logger'
import { WorkerServices } from '../workers/services'

/**
 * Clients sign the literal string `signature:<unix ms>` with a personal_sign
 * (EIP-191) signature over their account's Ethereum wallet key, and send it as
 * the Encoded-Data-Message / Encoded-Data-Signature header pair. See
 * signGatedContentRequest in the web and mobile clients.
 */
const MESSAGE_PREFIX = 'signature:'

export type VerifyResult =
  | { ok: true; wallet: string }
  | { ok: false; reason: string }

/**
 * Pull the millisecond timestamp out of a `signature:<unix ms>` message.
 * Returns null when the message isn't in that shape at all.
 */
export const parseSignatureTimestampMs = (message: string): number | null => {
  if (!message.startsWith(MESSAGE_PREFIX)) {
    return null
  }
  const raw = message.slice(MESSAGE_PREFIX.length).trim()
  if (raw === '') {
    return null
  }
  const parsed = Number(raw)
  return Number.isFinite(parsed) ? parsed : null
}

/**
 * Recover the signing wallet from the header pair. Returns null rather than
 * throwing — eth-sig-util throws on malformed input, and a malformed signature
 * is an ordinary client error here, not an exceptional condition.
 */
export const recoverSigner = (
  message: string,
  signature: string
): string | null => {
  try {
    return recoverPersonalSignature({ data: message, sig: signature }).toLowerCase()
  } catch {
    return null
  }
}

export type UserSignatureVerifier = (params: {
  userId: number
  messageHeader: string
  signatureHeader: string
  now?: number
}) => Promise<VerifyResult>

/**
 * Verifies that whoever sent this request actually controls the wallet behind
 * the `user_id` they claim.
 *
 * Before this existed the route checked only that the two headers were
 * *present*, never that they were valid or that they belonged to the claimed
 * user. Anyone could enqueue an arbitrarily expensive archive job — dozens of
 * lossless stems, gigabytes of disk and bandwidth, and a burst of api.audius.co
 * requests that trips its rate limiter — for any user id and any track, with a
 * signature header of literally `0xdeadbeef`. The downstream content fetches
 * failed on their own auth, so no private data was reachable, but the work was
 * done first and paid for by us.
 *
 * Cheap checks run before expensive ones: timestamp parse and signature
 * recovery are local and free, and only a request that survives both spends an
 * API call resolving the claimed user's wallet.
 */
export const createUserSignatureVerifier = ({
  sdk,
  config,
  logger
}: {
  sdk: WorkerServices['sdk']
  config: Config
  logger: Logger
}): UserSignatureVerifier => {
  return async ({ userId, messageHeader, signatureHeader, now = Date.now() }) => {
    const timestampMs = parseSignatureTimestampMs(messageHeader)
    if (timestampMs === null) {
      return { ok: false, reason: 'malformed signature message' }
    }

    // Replay window. Signatures are bearer credentials, so an old one that
    // leaks (they have historically been written to our own request logs) is
    // replayable until it ages out. Deliberately generous by default and
    // configurable to 0 to disable: client clocks drift, and rejecting a
    // legitimate download because someone's laptop is ten minutes fast is a
    // worse failure than a wide replay window.
    const maxAgeMs = config.signatureMaxAgeSeconds * 1000
    if (maxAgeMs > 0 && Math.abs(now - timestampMs) > maxAgeMs) {
      return { ok: false, reason: 'signature timestamp outside accepted window' }
    }

    const recovered = recoverSigner(messageHeader, signatureHeader)
    if (!recovered) {
      return { ok: false, reason: 'signature could not be recovered' }
    }

    const hashedUserId = OptionalId.parse(userId)
    if (!hashedUserId) {
      return { ok: false, reason: 'invalid user id' }
    }

    let user
    try {
      const response = await sdk.users.getUser({ id: hashedUserId })
      user = response.data
    } catch (error) {
      // An API failure is not the caller's fault. Surface it as its own reason
      // so the route can answer 503 rather than accusing them of a bad
      // signature, and so a discovery outage doesn't look like an attack in
      // the logs.
      logger.error({ err: error, userId }, 'Could not resolve user for signature check')
      return { ok: false, reason: 'user lookup failed' }
    }

    if (!user) {
      return { ok: false, reason: 'user not found' }
    }

    // `wallet` and `ercWallet` are the same address on every account we've
    // seen; check both so a future divergence fails open on the correct one
    // rather than rejecting a legitimate signer.
    const candidates = [user.ercWallet, user.wallet]
      .filter((w): w is string => typeof w === 'string' && w !== '')
      .map((w) => w.toLowerCase())

    if (candidates.length === 0) {
      logger.warn({ userId }, 'User has no wallet on record; cannot verify signature')
      return { ok: false, reason: 'user has no wallet on record' }
    }

    if (!candidates.includes(recovered)) {
      // Log the recovered wallet but never the signature itself — request
      // credentials in logs are their own problem, see the redaction issue.
      logger.warn(
        { userId, recovered, expected: candidates },
        'Signature does not match the claimed user'
      )
      return { ok: false, reason: 'signature does not match user' }
    }

    return { ok: true, wallet: recovered }
  }
}
