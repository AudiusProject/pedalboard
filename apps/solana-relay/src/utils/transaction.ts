import {
  Commitment,
  SendOptions,
  SendTransactionError,
  TransactionConfirmationStrategy,
  VersionedTransaction,
  type RpcResponseAndContext,
  type SignatureStatus
} from '@solana/web3.js'
import { Logger } from 'pino'

import { connections, getConnection } from './connections'
import { delay } from './delay'

const RETRY_DELAY_MS = 2 * 1000
const CONFIRM_POLL_DELAY_MS = 5 * 1000

/**
 * Checks that a confirmation status is considered confirmed based on the
 * commitment level.
 *
 * @see {@link https://github.com/solana-foundation/solana-web3.js/blob/c26c13bf841821d9bbf83bb476c567fe29d13821/src/connection.ts#L3958-L3982}
 */
const isConfirmed = (value: SignatureStatus, commitment: Commitment) => {
  switch (commitment) {
    case 'confirmed':
    case 'single':
    case 'singleGossip': {
      if (value.confirmationStatus === 'processed') {
        return false
      }
      break
    }
    case 'finalized':
    case 'max':
    case 'root': {
      if (
        value.confirmationStatus === 'processed' ||
        value.confirmationStatus === 'confirmed'
      ) {
        return false
      }
      break
    }
    // exhaust enums to ensure full coverage
    case 'processed':
    case 'recent':
  }
  return true
}

/**
 * Sends the transaction repeatedly to all configured RPCs until
 * it's been confirmed with the given commitment level or the blockhash expires.
 */
export const sendTransactionWithRetries = async ({
  transaction,
  commitment,
  confirmationStrategy,
  sendOptions,
  logger
}: {
  transaction: VersionedTransaction
  commitment: Commitment
  confirmationStrategy: TransactionConfirmationStrategy
  sendOptions?: SendOptions
  logger: Logger
}) => {
  const serializedTx = transaction.serialize()

  let retryCount = 0
  const createRetryPromise = async (signal: AbortSignal): Promise<void> => {
    while (!signal.aborted) {
      Promise.any(
        connections.map((connection) =>
          connection.sendRawTransaction(serializedTx, {
            skipPreflight: true,
            maxRetries: 0,
            ...sendOptions
          })
        )
      ).catch((error) => {
        logger.warn({ error, retryCount }, `Failed retry...`)
      })
      await delay(RETRY_DELAY_MS)
      retryCount++
    }
  }

  const connection = connections[0]
  const pollTransactionConfirmation = async (
    signal: AbortSignal,
    signature: string,
    commitment: Commitment
  ) => {
    while (!signal.aborted) {
      try {
        const connection = getConnection()
        const res = await connection.getSignatureStatus(signature)
        if (res.value) {
          const value = res.value
          if (isConfirmed(value, commitment)) {
            return res as RpcResponseAndContext<SignatureStatus>
          }
        }
      } catch (error) {
        logger.warn({ error }, `Failed to poll transaction confirmation...`)
      }
      await delay(CONFIRM_POLL_DELAY_MS)
    }
  }

  const start = Date.now()
  const abortController = new AbortController()
  let success = false
  try {
    if (!sendOptions?.skipPreflight) {
      const simulatedRes = await connection.simulateTransaction(transaction, {
        replaceRecentBlockhash: true
      })
      if (simulatedRes.value.err) {
        throw new SendTransactionError({
          action: 'simulate',
          signature: confirmationStrategy.signature,
          transactionMessage: JSON.stringify(simulatedRes.value.err),
          logs: simulatedRes.value.logs ?? undefined
        })
      }
    }

    const res = await Promise.race([
      createRetryPromise(abortController.signal),
      connection.confirmTransaction(
        { ...confirmationStrategy, abortSignal: abortController.signal },
        commitment
      ),
      // `confirmTransaction` only works with websockets. Also poll in case the
      // transaction succeeds but we miss the websocket event.
      pollTransactionConfirmation(
        abortController.signal,
        confirmationStrategy.signature,
        commitment
      )
    ])

    if (!res) {
      throw new Error('Failed to get transaction confirmation result')
    }
    if (res.value.err) {
      // Try one more time to confirm...
      try {
        const confirmationRes = await connection.getSignatureStatus(
          confirmationStrategy.signature
        )
        if (
          confirmationRes.value?.confirmationStatus === commitment &&
          !confirmationRes.value?.err
        ) {
          success = true
          return confirmationStrategy.signature
        }
      } catch (error) {
        logger.error({ error }, `Failed to get final signature status check.`)
      }
      throw new SendTransactionError({
        action: 'send',
        signature: confirmationStrategy.signature,
        transactionMessage: JSON.stringify(res.value.err)
      })
    }
    success = true
    return confirmationStrategy.signature
  } finally {
    // Stop the other operations
    abortController.abort()
    const end = Date.now()
    const elapsedMs = end - start
    logger.debug(
      { elapsedMs, retryCount, success },
      'sendTransactionWithRetries completed.'
    )
  }
}
