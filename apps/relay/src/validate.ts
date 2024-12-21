import { decodeAbi } from './abi'
import { logger } from './logger'
import { ManageEntityParameters } from './types/entityManager'

/// async in case we need to make a db call
export const validateTransactionData = async (
  encodedABI: string
): Promise<ManageEntityParameters> => {
  const decoded = decodeAbi(encodedABI)
  // TODO: validate decoded tx with zod
  // TODO: maybe check transactions table? this is no longer possible with the way identity works
  // TODO: filter replica set updates
  // if (failed) throw new Error("validation failed")
  return decoded
}

// throws if contract not valid
export const validateSupportedContract = (
  supportedContracts: string[],
  requestedContract: string | undefined
) => {
  // requestor did not provide a specified contract, expect EntityManager
  // if not outfitted for EM, the 'validateTransactionData' will fail to decode
  if (requestedContract === undefined) return
  if (!supportedContracts.includes(requestedContract))
    throw new Error(
      `requested contract ${requestedContract} not supported by ${supportedContracts}`
    )
}
