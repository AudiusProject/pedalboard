import { NextFunction, Request, Response } from 'express'
import { App } from '@pedalboard/basekit'
import { SharedData } from '..'
import { ClaimsManager } from '@audius/eth'

export const initRound = (app: App<SharedData>) => async (
  req: Request,
  res: Response,
  next: NextFunction
) => {
  const { viemClient } = app.viewAppData()

  const [latestBlock, lastFundedBlockNumber, fundingRoundBlockDiff] =
    await Promise.all([
      viemClient.getBlock().then((b) => Number(b.number)),
      viemClient
        .readContract({
          abi: ClaimsManager.abi,
          address: ClaimsManager.address,
          functionName: 'getLastFundedBlock'
        })
        .then(Number),
      viemClient
        .readContract({
          abi: ClaimsManager.abi,
          address: ClaimsManager.address,
          functionName: 'getFundingRoundBlockDiff'
        })
        .then(Number)
    ])

  const blockDiff = latestBlock - lastFundedBlockNumber

  if (lastFundedBlockNumber < latestBlock - 1.1 * fundingRoundBlockDiff) {
    res.status(400).send({
      status: 'Last funded block is too old',
      lastFundedBlockNumber,
      latestBlock,
      fundingRoundBlockDiff,
      blockDiff
    })
    next()
    return
  }

  res.send({
    status: 'Last funded block is recent enough',
    lastFundedBlockNumber,
    latestBlock,
    fundingRoundBlockDiff,
    blockDiff
  })
  next()
}
