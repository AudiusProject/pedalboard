import { recoverPersonalSignature } from 'eth-sig-util'
import { OptionalId } from '@audius/sdk'
import { getAudiusSdk } from '../sdk'
import { logger as rootLogger } from '../logger'

const log = rootLogger.child({ module: 'verifySignature' })

/**
 * Verifies that the EIP-191 personal_sign signature in the Encoded-Data headers
 * was produced by the registered wallet of the Audius user identified by userId.
 *
 * The Audius client signs a timestamp-scoped message with the user's wallet via
 * personal_sign (EIP-191). We recover the signer address and compare it against
 * the wallet address stored on the user's on-chain profile.
 *
 * Returns true on a valid match, false on any mismatch or error (fail-closed).
 */
export const verifyRequestSignature = async ({
  userId,
  messageHeader,
  signatureHeader
}: {
  userId: number
  messageHeader: string
  signatureHeader: string
}): Promise<boolean> => {
  try {
    // eth-sig-util prepends the EIP-191 prefix before hashing, matching
    // what the client signed via personal_sign.
    const recoveredWallet = recoverPersonalSignature({
      data: messageHeader,
      sig: signatureHeader
    })

    const sdk = getAudiusSdk()
    const hashedUserId = OptionalId.parse(userId)
    if (!hashedUserId) {
      log.warn({ userId }, 'verifySignature: could not encode userId')
      return false
    }

    const { data: user } = await sdk.users.getUser({ id: hashedUserId })
    if (!user?.wallet) {
      log.warn({ userId }, 'verifySignature: user not found or missing wallet')
      return false
    }

    // Ethereum addresses are case-insensitive hex.
    return recoveredWallet.toLowerCase() === user.wallet.toLowerCase()
  } catch (error) {
    log.warn({ error, userId }, 'verifySignature: threw during verification')
    return false
  }
}
