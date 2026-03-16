import type { App } from '@pedalboard/basekit'
import type { SharedData } from './config'
import type { ProposalParams } from './audits/version'
import { logger } from './logger'

export async function propose (app: App<SharedData>, params: ProposalParams): Promise<void> {
  const { libs, dryRun } = app.viewAppData()
  if (!libs.ethWeb3Manager || !libs.ethContracts) {
    throw new Error('Failed to propose, no ethWeb3Manager or ethContracts')
  }
  const web3 = libs.ethWeb3Manager!.getWeb3()
  const targetContractRegistryKey = web3.utils.utf8ToHex('DelegateManager')
  const callValue = '0'
  const functionSignature = 'slash(uint256,address)'
  const callData = [params.amountWei.toString(), params.owner]

  const inProgressProposalIds = await libs.ethContracts!.GovernanceClient.getInProgressProposals()
  const inProgressProposals = await Promise.all(
    inProgressProposalIds.map((id: string) =>
      libs.ethContracts!.GovernanceClient.getProposalSubmission(parseInt(id, 10))
    )
  )
  for (const proposal of inProgressProposals) {
    if (proposal?.name === params.title && proposal?.description === params.description) {
      logger.info(`Duplicate proposal for ${params.title} exists`)
      return
    }
  }
  logger.info(`Submitting proposal: ${params.title}`)
  if (!dryRun) {
    const proposalId = await libs.ethContracts!.GovernanceClient.submitProposal({
      targetContractRegistryKey,
      callValue,
      functionSignature,
      callData,
      name: params.title,
      description: params.description
    })
    logger.info(`Created proposal: ${proposalId}`)
  } else {
    logger.info('=======DRY RUN=======')
    logger.info({
      targetContractRegistryKey,
      callValue,
      functionSignature,
      callData,
      name: params.title,
      description: params.description
    })
  }
}
